import { z } from "zod";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { qdrant, COLLECTION, ensureCollection } from "@/lib/qdrant";
import { extractAnimationSignals } from "./animationSignals";
import type { CapturedSection as CapturedSectionInfo } from "@/lib/ingest/capture";

// ---------- Config ----------

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small", // 1536 dim, matches VECTOR_SIZE in qdrant.ts
});

// How much corpus to pass to the model for analysis (in characters)
const MAX_CORPUS_CHARS = 60_000;

// ---------- Analysis output schema ----------

const analysisSchema = z.object({
  description: z
    .string()
    .describe(
      "Accurate project description in English: what it does, for whom, how it's built, what characterizes it visually and technically. 2-4 paragraphs."
    ),
  techStack: z
    .array(z.string())
    .describe("Detected technologies, frameworks, and libraries"),
  designInfo: z
    .object({
      palette: z.array(z.string()).describe("Main colors (hex if detectable)"),
      fonts: z.array(z.string()).describe("Fonts used"),
      notes: z.string().describe("Notes on visual style, animations, layout"),
    })
    .describe("Detected design information"),
  components: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Component name, specific to what it does: 'Hero parallax intro', 'Scroll progress bar' — never generic like 'Animation'"
          ),
        kind: z.enum(["layout", "section", "ui", "animation"]),
        description: z
          .string()
          .describe(
            "What it does, how it behaves, what makes it reusable. For kind 'animation': describe the observed effect (what moves, when, how) and the likely technique."
          ),
        sourcePath: z
          .string()
          .describe(
            "File path, page URL, or — when the component matches a CAPTURED SECTION — its exact selector as written after 'selector=' in the block, to be able to retrieve the real HTML/CSS at extraction time"
          ),
      })
    )
    .describe(
      "ALL identified UI components that are potentially extractable: layout (shell, header, footer), section (hero, pricing, feature...), ui (buttons, selectors, cards...) AND animation. For a typical site expect 8-14 total components: every section visible in the screenshots is a section candidate, every interactive control a ui candidate. For animation: create a SEPARATE component for EVERY distinct scroll/motion effect observed in the sequential screenshots or in the animation signals (e.g. hero parallax, sticky element that transforms, progress/fill bar, section reveal, marquee, slider) — don't merge them. Animations are ADDED to the other components, not a replacement for them."
    ),
});

// ---------- Analysis ----------

export async function analyzeSite(siteId: string) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });

  const docs = await prisma.document.findMany({
    where: { siteId },
    orderBy: { path: "asc" },
  });

  const homepageDoc = docs.find(
    (d) => normalizeUrl(d.path) === normalizeUrl(site.sourceUrl)
  );
  const animationSignals = extractAnimationSignals(homepageDoc?.html);

  let corpus = buildCorpus(docs);
  if (animationSignals) {
    corpus += `\n\n===== ANIMATION SIGNALS (rendered homepage HTML) =====\n${animationSignals}`;
  }

  const capturedSections = (site.capturedSections as CapturedSectionInfo[] | null) ?? [];
  if (capturedSections.length > 0) {
    corpus += `\n\n===== SECTIONS CAPTURED FROM THE REAL DOM (Playwright, actual rendered HTML+CSS) =====`;
    for (const s of capturedSections.slice(0, 12)) {
      corpus += `\n\n--- SECTION selector="${s.selector}" ---\nHTML:\n${s.html.slice(0, 3_000)}\nComputed CSS (main elements):\n${s.css.slice(0, 1_500)}`;
    }
  }

  const awwwards = site.awwwards as {
    url?: string;
    award?: string | null;
    awardDate?: string | null;
    scores?: Record<string, number | null>;
    palette?: string[];
    tags?: string[];
    credits?: { name: string }[];
    description?: string | null;
    gallery?: { label: string; imageUrl: string }[];
  } | null;

  if (awwwards) {
    corpus += `\n\n===== AWWWARDS (curated data, authoritative source) =====
Award: ${awwwards.award ?? "n/a"}${awwwards.awardDate ? ` (${awwwards.awardDate})` : ""}
Jury scores: ${JSON.stringify(awwwards.scores ?? {})}
Tags (categories + technologies): ${(awwwards.tags ?? []).join(", ")}
Palette: ${(awwwards.palette ?? []).join(", ")}
Credits: ${(awwwards.credits ?? []).map((c) => c.name).join(", ")}
${awwwards.description ? `Description: ${awwwards.description}` : ""}`;
  }

  const structured = chatModel.withStructuredOutput(analysisSchema, {
    name: "project_analysis",
  });

  const scrollScreenshots = (site.scrollScreenshots as string[] | null) ?? [];
  const galleryImages = (awwwards?.gallery ?? []).map((g) => g.imageUrl).slice(0, 5);
  const images = [site.screenshot, ...scrollScreenshots, ...galleryImages].filter(
    (u): u is string => !!u
  );

  const userContent =
    images.length > 0
      ? [
          { type: "text" as const, text: `Analyze this project:\n\n${corpus}` },
          ...images.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : `Analyze this project:\n\n${corpus}`;

  const result = await structured.invoke([
    {
      role: "system",
      content:
        "You are an expert frontend technical analyst. Analyze the content of a website or repository and produce a structured, concrete, and accurate analysis. Base yourself only on what you see in the corpus, don't make things up. If a homepage screenshot is present, use it as the primary source for real color palette and fonts (observe them directly in the image); the markdown text is only additional context.\n\nIf the corpus contains a SECTIONS CAPTURED FROM THE REAL DOM block, treat it as the primary source for structure: it's HTML and computed CSS actually rendered by the browser (Playwright), not derived text. Match each structural component (layout/section/ui) to the relevant captured section when one exists, and use its selector as sourcePath.\n\nIn the components field you must list TWO families of components, both mandatory:\n1. Structural components (kind layout, section, ui): the page's sections and reusable elements (hero, header, footer, card, selectors, slider...).\n2. Animation components: if multiple images are provided in sequence, they represent the page scrolling from top to bottom — use them to identify scroll-linked effects (parallax, sticky elements that transform, progress/fill bar, reveal, overlay...). Treat EVERY distinct scroll/motion effect as a SEPARATE component with kind \"animation\", named specifically (e.g. 'Hero parallax intro', 'Scroll progress bar'), using the ANIMATION SIGNALS in the corpus as technical evidence when available.\n\nAn analysis that contains only animation or only structural components is incomplete.\n\nIf the corpus contains an AWWWARDS block, treat it as an authoritative source curated by humans: its technology tags take priority for techStack and its palette takes priority for designInfo.palette.",
    },
    {
      role: "user",
      content: userContent,
    },
  ]);

  await prisma.$transaction([
    prisma.site.update({
      where: { id: siteId },
      data: {
        description: result.description,
        techStack: result.techStack,
        designInfo: result.designInfo,
      },
    }),
    // re-analysis: clear the previous components
    prisma.component.deleteMany({ where: { siteId } }),
    prisma.component.createMany({
      data: result.components.map((c) => ({ siteId, ...c })),
    }),
  ]);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Builds the corpus giving priority to the most informative files,
 * truncating to stay within budget.
 */
function buildCorpus(
  docs: { path: string; kind: string; content: string }[]
): string {
  const priority = (d: { path: string }) => {
    const p = d.path.toLowerCase();
    if (p.endsWith("readme.md")) return 0;
    if (p.endsWith("package.json")) return 1;
    if (p.includes("layout") || p.includes("page")) return 2;
    if (p.includes("component")) return 3;
    return 4;
  };

  const sorted = [...docs].sort((a, b) => priority(a) - priority(b));

  let corpus = "";
  for (const doc of sorted) {
    const header = `\n\n===== ${doc.kind.toUpperCase()}: ${doc.path} =====\n`;
    const remaining = MAX_CORPUS_CHARS - corpus.length - header.length;
    if (remaining <= 200) break;
    corpus += header + doc.content.slice(0, remaining);
  }
  return corpus;
}

// ---------- Embeddings → Qdrant ----------

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 150,
});

export async function embedSite(siteId: string) {
  await ensureCollection();

  // re-embedding: remove the project's old points
  await qdrant.delete(COLLECTION, {
    filter: {
      must: [{ key: "siteId", match: { value: siteId } }],
    },
  });

  const docs = await prisma.document.findMany({ where: { siteId } });

  for (const doc of docs) {
    const chunks = await splitter.splitText(doc.content);
    if (chunks.length === 0) continue;

    const vectors = await embeddings.embedDocuments(chunks);

    const points = chunks.map((text, i) => ({
      id: randomUUID(),
      vector: vectors[i],
      payload: {
        siteId,
        documentId: doc.id,
        path: doc.path,
        kind: doc.kind,
        chunkIndex: i,
        text,
      },
    }));

    await qdrant.upsert(COLLECTION, { points });

    await prisma.document.update({
      where: { id: doc.id },
      data: { qdrantIds: points.map((p) => p.id) },
    });
  }
}
