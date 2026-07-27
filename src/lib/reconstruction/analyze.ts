import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import fs from "node:fs/promises";
import path from "node:path";
import { assertLocalOnly } from "@/lib/local-only";
import { readMeta, reconstructionDir, staticExtractionPath, writeSpec, updateMeta } from "./paths";
import { setRunning } from "./progress";
import type { StaticExtraction } from "./staticExtract";

// Vision-capable model, same convention as src/lib/sections/reconstruct.ts:
// quality here is the product (Phase 2), not mini. Override via OPENAI_VISION_MODEL.
const visionModel = new ChatOpenAI({
  model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  temperature: 0.2,
});

const specSchema = z.object({
  identity: z.object({
    palette: z
      .array(z.object({ hex: z.string(), role: z.string() }))
      .describe("Colors with role: background, accent, text..."),
    typography: z
      .array(z.object({ family: z.string(), usage: z.string() }))
      .describe("Type families and where they're used (headings, body, CTA...)"),
    density: z.string().describe("Layout density/rhythm (spacious, compact, alternating...)"),
    photographyStyle: z.string().describe("Observed photographic/illustrative style"),
  }),
  sections: z
    .array(
      z.object({
        name: z.string().describe("Short, specific name, e.g. 'Hero', 'Grid collections'"),
        purpose: z.string(),
        contents: z.string(),
        layout: z.string().describe("Grid/columns/full-bleed/etc."),
        mediaType: z.string().describe("video, image, canvas/WebGL, none..."),
        behavior: z
          .string()
          .describe(
            "What enters/exits and from where, what gets swapped and at what point in the scroll, parallax, pin/sticky, hover, custom cursor, page transitions"
          ),
      })
    )
    .describe("In the page's scroll order"),
  interactions: z
    .array(z.string())
    .describe("Interactions seen ONLY in the human video: menu, filters, carousel, states"),
  feasibilityNotes: z
    .string()
    .describe(
      "What's faithfully reproducible, what needs to be approximated, what's out of reach (WebGL/shaders...)"
    ),
});

function renderSpecMarkdown(
  siteName: string,
  sourceUrl: string,
  spec: z.infer<typeof specSchema>
): string {
  const paletteLines = spec.identity.palette.map((p) => `- \`${p.hex}\` — ${p.role}`).join("\n");
  const typographyLines = spec.identity.typography
    .map((t) => `- **${t.family}** — ${t.usage}`)
    .join("\n");
  const sectionBlocks = spec.sections
    .map(
      (s, i) => `### ${i + 1}. ${s.name}

- **Purpose**: ${s.purpose}
- **Contents**: ${s.contents}
- **Layout**: ${s.layout}
- **Media**: ${s.mediaType}
- **Behavior/animations**: ${s.behavior}`
    )
    .join("\n\n");
  const interactionLines = spec.interactions.length
    ? spec.interactions.map((i) => `- ${i}`).join("\n")
    : "- (no additional interactions observed in the human video)";

  return `# SPEC — ${siteName}

Source: ${sourceUrl}

## Visual identity

**Palette**
${paletteLines}

**Typography**
${typographyLines}

**Density/rhythm**: ${spec.identity.density}

**Photographic style**: ${spec.identity.photographyStyle}

## Sections

${sectionBlocks}

## Interactions (from the human video)

${interactionLines}

## Reconstructability notes

${spec.feasibilityNotes}
`;
}

/**
 * Phase 2: a vision model receives frames+timestamp, media inventory,
 * detected libraries, palette — produces a structured description, rendered
 * as SPEC.md. This is only the DRAFT: the admin reviews/edits/confirms it
 * (Phase 2, editable) before Phase 3 uses it.
 */
export async function analyzeReconstruction(slug: string, siteName: string): Promise<string> {
  assertLocalOnly("Vision analysis");
  setRunning(slug, { stage: "analyzing" });

  try {
    const meta = await readMeta(slug);
    if (meta.frames.length === 0) {
      throw new Error("No frames extracted yet — run frame extraction first (Phase 1b)");
    }

    const staticData: StaticExtraction | null = await fs
      .readFile(staticExtractionPath(slug), "utf-8")
      .then((raw) => JSON.parse(raw) as StaticExtraction)
      .catch(() => null);

    const structured = visionModel.withStructuredOutput(specSchema, { name: "reconstruction_spec" });

    const textParts = [
      `SITE: ${siteName} (${meta.sourceUrl})`,
      `FRAME SEQUENCE (with timestamp, in scroll order):\n${meta.frames
        .map((f, i) => `[${i}] t=${(f.timestampMs / 1000).toFixed(1)}s`)
        .join("\n")}`,
      staticData
        ? `MEDIA INVENTORY (primary source, real DOM):\n${JSON.stringify(staticData.media, null, 2).slice(0, 4_000)}`
        : "",
      staticData ? `DETECTED FONTS: ${staticData.fonts.join(", ") || "n/a"}` : "",
      `DETECTED ANIMATION LIBRARIES: ${meta.detectedLibs.join(", ") || "none"}`,
      `DETECTED PALETTE (computed styles): ${meta.palette.join(", ") || "n/a"}`,
    ].filter(Boolean);

    const framesDirAbs = path.join(reconstructionDir(slug), "material", "frames");
    const images = await Promise.all(
      meta.frames.map(async (f) => {
        const buf = await fs.readFile(path.join(framesDirAbs, f.file));
        return {
          type: "image_url" as const,
          image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
        };
      })
    );

    const result = await structured.invoke([
      {
        role: "system",
        content:
          "You are a senior frontend/motion analyst. Analyze the frame sequence of a real site's scroll (top to bottom) and produce a structured, accurate description: visual identity, list of sections in scroll order, behavior/animations per section, interactions, and honest notes on what's faithfully reproducible. Base yourself only on what you observe in the frames and provided data, don't make things up.",
      },
      {
        role: "user",
        content: [{ type: "text" as const, text: textParts.join("\n\n") }, ...images],
      },
    ]);

    const markdown = renderSpecMarkdown(siteName, meta.sourceUrl, result);
    await writeSpec(slug, markdown);
    await updateMeta(slug, (m) => {
      if (m.phase === "collecting") m.phase = "analyzed";
    });

    return markdown;
  } finally {
    setRunning(slug, null);
  }
}
