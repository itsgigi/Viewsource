import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

// Budget of components sent to the LLM: large repos can extract hundreds
// via AST. Ones outside the budget stay `excluded: true` (the default at
// creation) — they don't "disappear", they remain ingestible in the future
// if the budget is raised or a manual review is added.
const MAX_CANDIDATES = 40;
const MAX_IMAGES = 15;

const rankingSchema = z.object({
  projectDescription: z
    .string()
    .describe(
      "Accurate project description in English: what it does, for whom, how it's built. 2-4 paragraphs, based on the package.json and the real components provided, not made up."
    ),
  techStack: z.array(z.string()).describe("Technologies, frameworks, and libraries detected from the real project"),
  components: z
    .array(
      z.object({
        filePath: z.string().describe("Exact path of the component's main file, as provided in the input"),
        worthy: z
          .boolean()
          .describe(
            "true if the component deserves a public showcase: used on the main pages, has its own style, meaningful visual surface, not a trivial few-line wrapper"
          ),
        rank: z
          .number()
          .int()
          .describe("Relevance order among worthy components: 1 = most relevant. Ignored if worthy is false."),
        kind: z.enum(["layout", "section", "ui", "animation"]),
        description: z
          .string()
          .describe(
            "What it does, how it behaves, what makes it reusable, integration notes. Only if worthy is true, otherwise an empty string."
          ),
      })
    )
    .describe("One item for EVERY component provided in the input, in the same order — none should be omitted"),
});

/**
 * Spec Phase 4: this is the only place the LLM enters the repo pipeline.
 * The components are already extracted deterministically (Phase 2, src/lib/ast) —
 * the LLM's job is to rank them by relevance, decide which deserve the
 * public showcase, classify them, and describe them. Called by runIngestion
 * AFTER the Component rows (origin "ast") have already been persisted.
 */
export async function analyzeRepoComponents(siteId: string): Promise<void> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const components = await prisma.component.findMany({ where: { siteId, origin: "ast" } });
  if (components.length === 0) return;

  const candidates = [...components]
    .sort((a, b) => complexityScore(b) - complexityScore(a))
    .slice(0, MAX_CANDIDATES);

  const metadata = (site.metadata as Record<string, unknown> | null) ?? null;
  const pkg = metadata?.packageJson ?? null;

  const corpus = candidates
    .map((c) => {
      const props = safeParse(c.propsSchema, []);
      const npmDeps = safeParse(c.npmDeps, []);
      const bundleFiles = safeParse<{ path: string }[]>(c.bundleFiles, []);
      return `--- COMPONENT filePath="${c.filePath}" name="${c.name}" ---
Props: ${JSON.stringify(props)}
npm dependencies: ${JSON.stringify(npmDeps)}
Files in bundle: ${bundleFiles.map((f) => f.path).join(", ") || "main file only"}`;
    })
    .join("\n\n");

  const images = candidates
    .map((c) => c.previewImage)
    .filter((u): u is string => !!u)
    .slice(0, MAX_IMAGES);

  const textContent = `Project: ${site.name} (${site.sourceUrl})

PACKAGE.JSON:
${pkg ? JSON.stringify(pkg).slice(0, 4_000) : "not available"}

COMPONENTS EXTRACTED VIA AST (real, deterministic data):
${corpus}`;

  const userContent =
    images.length > 0
      ? [
          { type: "text" as const, text: textContent },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : textContent;

  const structured = chatModel.withStructuredOutput(rankingSchema, { name: "repo_analysis" });

  const result = await structured.invoke([
    {
      role: "system",
      content:
        "You are an expert frontend technical analyst. You're given React components ALREADY extracted deterministically from a real repo (props, npm dependencies, multi-file bundle) — your job is NOT to find them, but to decide which deserve a public showcase, rank them by relevance, classify them (layout/section/ui/animation), and describe them. Prefer components with their own style and meaningful visual surface; discard (worthy: false) trivial few-line wrappers. If images are provided, they are real cropped screenshots of the component in the project — use them as primary evidence, not just the name. Respond for EVERY component provided in the input, in the same order, without omitting any.",
    },
    { role: "user", content: userContent },
  ]);

  const componentUpdates = result.components
    .map((r) => ({ r, component: candidates.find((c) => c.filePath === r.filePath) }))
    .filter((x): x is { r: (typeof result.components)[number]; component: (typeof candidates)[number] } => !!x.component)
    .map(({ r, component }) =>
      prisma.component.update({
        where: { id: component.id },
        data: r.worthy
          ? { excluded: false, rank: r.rank, kind: r.kind, description: r.description }
          : { excluded: true, rank: null },
      })
    );

  await prisma.$transaction([
    prisma.site.update({
      where: { id: siteId },
      data: { description: result.projectDescription, techStack: result.techStack },
    }),
    ...componentUpdates,
  ]);
}

function complexityScore(c: { propsSchema: string | null; bundleFiles: string | null }): number {
  return safeParse(c.propsSchema, [] as unknown[]).length * 2 + safeParse(c.bundleFiles, [] as unknown[]).length;
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
