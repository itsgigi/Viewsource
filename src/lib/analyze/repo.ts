import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

// Budget di componenti mandati all'LLM: i repo grandi possono estrarne
// centinaia via AST. Quelli fuori budget restano `excluded: true` (default
// alla creazione) — non "spariscono", restano ingeribili in futuro se si
// alza il budget o si aggiunge una revisione manuale.
const MAX_CANDIDATES = 40;
const MAX_IMAGES = 15;

const rankingSchema = z.object({
  projectDescription: z
    .string()
    .describe(
      "Descrizione accurata del progetto in italiano: cosa fa, per chi, come è costruito. 2-4 paragrafi, basata sul package.json e sui componenti reali forniti, non inventata."
    ),
  techStack: z.array(z.string()).describe("Tecnologie, framework e librerie rilevate dal progetto reale"),
  components: z
    .array(
      z.object({
        filePath: z.string().describe("Path esatto del file principale del componente, come fornito in input"),
        worthy: z
          .boolean()
          .describe(
            "true se il componente merita una vetrina pubblica: usato nelle pagine principali, stile proprio, superficie visiva significativa, non un wrapper banale di poche righe"
          ),
        rank: z
          .number()
          .int()
          .describe("Ordine di rilevanza tra i componenti worthy: 1 = il più rilevante. Ignorato se worthy è false."),
        kind: z.enum(["layout", "section", "ui", "animation"]),
        description: z
          .string()
          .describe(
            "Cosa fa, come si comporta, cosa lo rende riutilizzabile, note sull'integrazione. Solo se worthy è true, altrimenti stringa vuota."
          ),
      })
    )
    .describe("Un elemento per OGNI componente fornito in input, nello stesso ordine — nessuno va omesso"),
});

/**
 * Fase 4 della spec: qui, e solo qui, entra l'LLM per la pipeline repo.
 * I componenti sono già estratti deterministicamente (Fase 2, src/lib/ast) —
 * il compito dell'LLM è ordinarli per rilevanza, decidere quali meritano la
 * vetrina pubblica, classificarli e descriverli. Chiamata da runIngestion
 * DOPO che i Component (origin "ast") sono già stati persistiti.
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
      return `--- COMPONENTE filePath="${c.filePath}" nome="${c.name}" ---
Props: ${JSON.stringify(props)}
Dipendenze npm: ${JSON.stringify(npmDeps)}
File nel bundle: ${bundleFiles.map((f) => f.path).join(", ") || "solo il file principale"}`;
    })
    .join("\n\n");

  const images = candidates
    .map((c) => c.previewImage)
    .filter((u): u is string => !!u)
    .slice(0, MAX_IMAGES);

  const textContent = `Progetto: ${site.name} (${site.sourceUrl})

PACKAGE.JSON:
${pkg ? JSON.stringify(pkg).slice(0, 4_000) : "non disponibile"}

COMPONENTI ESTRATTI VIA AST (dati reali, deterministici):
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
        "Sei un analista tecnico frontend esperto. Ricevi componenti React GIÀ estratti deterministicamente da un repo reale (props, dipendenze npm, bundle multi-file) — il tuo compito NON è trovarli, ma decidere quali meritano una vetrina pubblica, ordinarli per rilevanza, classificarli (layout/section/ui/animation) e descriverli. Preferisci componenti con stile proprio e superficie visiva significativa; scarta (worthy: false) i wrapper banali di poche righe. Se sono fornite immagini, sono screenshot reali ritagliati del componente nel progetto — usale come prova primaria, non solo il nome. Rispondi per OGNI componente fornito in input, nello stesso ordine, senza ometterne nessuno.",
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
