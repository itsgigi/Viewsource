import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import fs from "node:fs/promises";
import path from "node:path";
import { assertLocalOnly } from "@/lib/local-only";
import { readMeta, reconstructionDir, staticExtractionPath, writeSpec, updateMeta } from "./paths";
import { setRunning } from "./progress";
import type { StaticExtraction } from "./staticExtract";

// Modello vision-capable, stessa convenzione di src/lib/sections/reconstruct.ts:
// la qualità qui è il prodotto (Fase 2), non mini. Override via OPENAI_VISION_MODEL.
const visionModel = new ChatOpenAI({
  model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  temperature: 0.2,
});

const specSchema = z.object({
  identity: z.object({
    palette: z
      .array(z.object({ hex: z.string(), role: z.string() }))
      .describe("Colori con ruolo: sfondo, accento, testo..."),
    typography: z
      .array(z.object({ family: z.string(), usage: z.string() }))
      .describe("Famiglie tipografiche e dove sono usate (titoli, corpo, CTA...)"),
    density: z.string().describe("Densità/ritmo del layout (spazioso, compatto, alternato...)"),
    photographyStyle: z.string().describe("Stile fotografico/illustrativo osservato"),
  }),
  sections: z
    .array(
      z.object({
        name: z.string().describe("Nome breve e specifico, es. 'Hero', 'Collezioni a griglia'"),
        purpose: z.string(),
        contents: z.string(),
        layout: z.string().describe("Griglia/colonne/full-bleed/etc."),
        mediaType: z.string().describe("video, immagine, canvas/WebGL, nessuno..."),
        behavior: z
          .string()
          .describe(
            "Cosa entra/esce e da dove, cosa si sostituisce e a che punto dello scroll, parallasse, pin/sticky, hover, cursore custom, transizioni di pagina"
          ),
      })
    )
    .describe("Nell'ordine di scorrimento della pagina"),
  interactions: z
    .array(z.string())
    .describe("Interazioni viste SOLO nel video umano: menu, filtri, carousel, stati"),
  feasibilityNotes: z
    .string()
    .describe(
      "Cosa è riproducibile fedelmente, cosa va approssimato, cosa è fuori portata (WebGL/shader...)"
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

- **Scopo**: ${s.purpose}
- **Contenuti**: ${s.contents}
- **Layout**: ${s.layout}
- **Media**: ${s.mediaType}
- **Comportamento/animazioni**: ${s.behavior}`
    )
    .join("\n\n");
  const interactionLines = spec.interactions.length
    ? spec.interactions.map((i) => `- ${i}`).join("\n")
    : "- (nessuna interazione aggiuntiva osservata nel video umano)";

  return `# SPEC — ${siteName}

Sorgente: ${sourceUrl}

## Identità visiva

**Palette**
${paletteLines}

**Tipografia**
${typographyLines}

**Densità/ritmo**: ${spec.identity.density}

**Stile fotografico**: ${spec.identity.photographyStyle}

## Sezioni

${sectionBlocks}

## Interazioni (dal video umano)

${interactionLines}

## Note di ricostruibilità

${spec.feasibilityNotes}
`;
}

/**
 * Fase 2: un modello vision riceve frame+timestamp, inventario media,
 * librerie rilevate, palette — produce una descrizione strutturata, resa in
 * SPEC.md. Questo è solo il DRAFT: l'admin lo rivede/corregge/conferma
 * (Fase 2, editabile) prima che Fase 3 lo usi.
 */
export async function analyzeReconstruction(slug: string, siteName: string): Promise<string> {
  assertLocalOnly("L'analisi vision");
  setRunning(slug, { stage: "analyzing" });

  try {
    const meta = await readMeta(slug);
    if (meta.frames.length === 0) {
      throw new Error("Nessun frame estratto ancora — esegui prima l'estrazione frame (Fase 1b)");
    }

    const staticData: StaticExtraction | null = await fs
      .readFile(staticExtractionPath(slug), "utf-8")
      .then((raw) => JSON.parse(raw) as StaticExtraction)
      .catch(() => null);

    const structured = visionModel.withStructuredOutput(specSchema, { name: "reconstruction_spec" });

    const textParts = [
      `SITO: ${siteName} (${meta.sourceUrl})`,
      `SEQUENZA FRAME (con timestamp, in ordine di scorrimento):\n${meta.frames
        .map((f, i) => `[${i}] t=${(f.timestampMs / 1000).toFixed(1)}s`)
        .join("\n")}`,
      staticData
        ? `INVENTARIO MEDIA (fonte primaria, DOM reale):\n${JSON.stringify(staticData.media, null, 2).slice(0, 4_000)}`
        : "",
      staticData ? `FONT RILEVATI: ${staticData.fonts.join(", ") || "n/d"}` : "",
      `LIBRERIE DI ANIMAZIONE RILEVATE: ${meta.detectedLibs.join(", ") || "nessuna"}`,
      `PALETTE RILEVATA (computed styles): ${meta.palette.join(", ") || "n/d"}`,
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
          "Sei un analista frontend/motion senior. Analizza la sequenza di frame di uno scroll (dall'alto al basso) di un sito reale e produci una descrizione strutturata e accurata: identità visiva, elenco delle sezioni nell'ordine di scorrimento, comportamento/animazioni per sezione, interazioni, e note oneste su cosa è riproducibile fedelmente. Basati solo su ciò che osservi nei frame e nei dati forniti, non inventare.",
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
