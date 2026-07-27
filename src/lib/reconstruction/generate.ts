import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import fs from "node:fs/promises";
import path from "node:path";
import { assertLocalOnly } from "@/lib/local-only";
import {
  readMeta,
  writeMeta,
  readSpec,
  sectionsDir,
  reconstructionDir,
  staticExtractionPath,
} from "./paths";
import { setRunning } from "./progress";
import type { StaticExtraction } from "./staticExtract";

// Stessa convenzione di src/lib/sections/reconstruct.ts: scaffold economico
// (gpt-4o-mini), codice per-sezione su modello vision-capable (gpt-4o).
const scaffoldModel = new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", temperature: 0 });
const codeModel = new ChatOpenAI({ model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o", temperature: 0.2 });

const scaffoldSchema = z.object({
  sections: z
    .array(z.object({ name: z.string() }))
    .describe("Elenco delle sezioni, nell'ordine di scorrimento, come descritte in SPEC.md sotto '## Sezioni'"),
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("Il componente React+TypeScript completo, in un singolo file, export default, senza props richieste"),
  notes: z
    .string()
    .describe("Cosa è stato ricostruito fedelmente e cosa è stato approssimato/inventato"),
});

const SYSTEM_PROMPT = `Sei un frontend engineer senior. Ricostruisci UNA sezione di un sito web reale come un SINGOLO componente React + TypeScript, a partire dalla sua descrizione in SPEC.md (confermata da un umano) e da frame video della pagina reale.

Regole di formato:
- Output in un SINGOLO file autonomo con export default di un componente funzionale, SENZA props richieste.
- Porta lo stile con un tag <style> nello stesso file (classi scoped/prefissate per evitare collisioni globali, es. "sec-hero-titolo"), basandoti sul CSS reale fornito quando pertinente — non tradurre tutto in valori inventati se hai un riferimento reale.
- SENZA import da file esterni del progetto e SENZA librerie npm oltre a "react" — TRANNE "gsap" e "framer-motion", disponibili SOLO se elencate tra le librerie rilevate: importale solo in quel caso, altrimenti animazioni via CSS/@keyframes.
- Media: se l'inventario indica un video per questo tipo di contenuto, genera un tag <video> con un URL reale dall'inventario — MAI un <img> al suo posto. Per loghi/brand usa un placeholder neutro mantenendo il layout.
- Le animazioni devono risolversi al loro stato visivo finale poco dopo il mount, SENZA dipendere da uno scroll reale: la fedeltà è giudicata da uno screenshot statico post-mount.
- Codice production-quality: tipizzato, accessibile, responsive.
- Nelle note dichiara sempre esplicitamente cosa è stato approssimato o inventato per mancanza di informazioni certe.`;

function slugifyFilename(name: string, index: number): string {
  const pascal = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return `${String(index + 1).padStart(2, "0")}-${pascal || "Section"}.tsx`;
}

function componentNameFor(filename: string): string {
  const base = path.basename(filename, ".tsx").replace(/^\d+-/, "").replace(/[^a-zA-Z0-9]/g, "");
  return base || "Section";
}

/**
 * Fase 3: dalla SPEC.md confermata, scaffolda l'elenco ordinato delle
 * sezioni (chiamata economica), poi genera il codice di ciascuna (chiamata
 * vision-capable, frame + estrazione statica come riferimento). Scrive
 * page.tsx + sections/NN-Nome.tsx. Non è pensata per essere ri-eseguita dopo
 * che l'admin ha iniziato a modificare i file a mano (Fase 4 in poi).
 */
export async function generateReconstruction(slug: string): Promise<void> {
  assertLocalOnly("La generazione della demo");
  setRunning(slug, { stage: "generating" });

  try {
    const specMd = await readSpec(slug);
    if (!specMd) throw new Error("SPEC.md non trovata — completa e conferma la Fase 2 prima di generare");

    const meta = await readMeta(slug);
    const staticData: StaticExtraction | null = await fs
      .readFile(staticExtractionPath(slug), "utf-8")
      .then((raw) => JSON.parse(raw) as StaticExtraction)
      .catch(() => null);

    const scaffold = await scaffoldModel
      .withStructuredOutput(scaffoldSchema, { name: "reconstruction_scaffold" })
      .invoke([
        {
          role: "system",
          content:
            "Estrai l'elenco ordinato delle sezioni descritte in questo documento SPEC (una per ogni intestazione di terzo livello sotto '## Sezioni'), nello stesso ordine. Restituisci solo i nomi, esattamente come appaiono.",
        },
        { role: "user", content: specMd },
      ]);

    if (scaffold.sections.length === 0) {
      throw new Error("Nessuna sezione trovata in SPEC.md — verifica che contenga una sezione '## Sezioni'");
    }

    const framesDirAbs = path.join(reconstructionDir(slug), "material", "frames");
    const step = Math.max(1, Math.ceil(meta.frames.length / 6));
    const sampleFrames = meta.frames.filter((_, i) => i % step === 0);
    const images = await Promise.all(
      sampleFrames.map(async (f) => {
        const buf = await fs.readFile(path.join(framesDirAbs, f.file));
        return {
          type: "image_url" as const,
          image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
        };
      })
    );

    const sectionsMeta: typeof meta.sections = [];
    const imports: string[] = [];
    const mounts: string[] = [];

    for (let i = 0; i < scaffold.sections.length; i++) {
      const name = scaffold.sections[i].name;
      setRunning(slug, { stage: "generating", detail: `${i + 1}/${scaffold.sections.length}: ${name}` });

      const filename = slugifyFilename(name, i);
      const componentName = componentNameFor(filename);

      const structured = codeModel.withStructuredOutput(codeSchema, { name: "reconstruction_section" });
      const result = await structured.invoke([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: [
                `SEZIONE DA GENERARE: "${name}" (posizione ${i + 1} di ${scaffold.sections.length})`,
                `SPEC.md COMPLETA (contesto):\n${specMd}`,
                staticData
                  ? `CSS REALE (fogli linkati + computed styles delle sezioni principali della pagina originale — riferimento, non struttura da rispecchiare 1:1):\n${JSON.stringify(staticData.sectionStyles).slice(0, 4_000)}`
                  : "",
                staticData
                  ? `INVENTARIO MEDIA REALE (usa questi URL, non inventarne altri):\n${JSON.stringify(staticData.media).slice(0, 3_000)}`
                  : "",
                `LIBRERIE DI ANIMAZIONE RILEVATE SUL SITO: ${meta.detectedLibs.join(", ") || "nessuna — usa solo CSS/@keyframes"}`,
                `PALETTE: ${meta.palette.join(", ") || "n/d"}`,
                `FONT: ${meta.fonts.join(", ") || "n/d"}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
            ...images,
          ],
        },
      ]);

      await fs.writeFile(path.join(sectionsDir(slug), filename), result.code, "utf-8");
      imports.push(`import ${componentName} from "./sections/${filename.replace(/\.tsx$/, "")}";`);
      mounts.push(`      <${componentName} />`);
      sectionsMeta.push({ file: filename, name, approved: false, referenceFrame: null });
    }

    const pageTsx = `${imports.join("\n")}\n\nexport default function Page() {\n  return (\n    <>\n${mounts.join("\n")}\n    </>\n  );\n}\n`;
    await fs.writeFile(path.join(reconstructionDir(slug), "page.tsx"), pageTsx, "utf-8");

    await writeMeta(slug, { ...meta, sections: sectionsMeta, phase: "generated" });
  } finally {
    setRunning(slug, null);
  }
}
