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

// Same convention as src/lib/sections/reconstruct.ts: cheap scaffold
// (gpt-4o-mini), per-section code on a vision-capable model (gpt-4o).
const scaffoldModel = new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", temperature: 0 });
const codeModel = new ChatOpenAI({ model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o", temperature: 0.2 });

const scaffoldSchema = z.object({
  sections: z
    .array(z.object({ name: z.string() }))
    .describe("List of sections, in scroll order, as described in SPEC.md under '## Sections'"),
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("The complete React+TypeScript component, in a single file, export default, with no required props"),
  notes: z
    .string()
    .describe("What was faithfully reconstructed and what was approximated/invented"),
});

const SYSTEM_PROMPT = `You are a senior frontend engineer. Reconstruct ONE section of a real website as a SINGLE React + TypeScript component, based on its description in SPEC.md (confirmed by a human) and video frames of the real page.

Format rules:
- Output in a SINGLE self-contained file with an export default of a functional component, with NO required props.
- Carry the styling in a <style> tag in the same file (scoped/prefixed classes to avoid global collisions, e.g. "sec-hero-title"), based on the real CSS provided when relevant — don't translate everything into made-up values if you have a real reference.
- NO imports from external project files and NO npm libraries besides "react" — EXCEPT "gsap" and "framer-motion", available ONLY if listed among the detected libraries: import them only in that case, otherwise use CSS/@keyframes for animations.
- Media: if the inventory indicates a video for this type of content, generate a <video> tag with a real URL from the inventory — NEVER an <img> instead. For logos/brand use a neutral placeholder while keeping the layout.
- Animations must settle into their final visual state shortly after mount, WITHOUT depending on a real scroll: fidelity is judged from a static post-mount screenshot.
- Production-quality code: typed, accessible, responsive.
- In the notes, always explicitly state what was approximated or invented due to missing certain information.`;

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
 * Phase 3: from the confirmed SPEC.md, scaffolds the ordered list of
 * sections (cheap call), then generates each one's code (vision-capable
 * call, frames + static extraction as reference). Writes page.tsx +
 * sections/NN-Name.tsx. Not meant to be re-run once the admin has started
 * hand-editing the files (Phase 4 onward).
 */
export async function generateReconstruction(slug: string): Promise<void> {
  assertLocalOnly("Demo generation");
  setRunning(slug, { stage: "generating" });

  try {
    const specMd = await readSpec(slug);
    if (!specMd) throw new Error("SPEC.md not found — complete and confirm Phase 2 before generating");

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
            "Extract the ordered list of sections described in this SPEC document (one per third-level heading under '## Sections'), in the same order. Return only the names, exactly as they appear.",
        },
        { role: "user", content: specMd },
      ]);

    if (scaffold.sections.length === 0) {
      throw new Error("No sections found in SPEC.md — check that it contains a '## Sections' section");
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
                `SECTION TO GENERATE: "${name}" (position ${i + 1} of ${scaffold.sections.length})`,
                `FULL SPEC.md (context):\n${specMd}`,
                staticData
                  ? `REAL CSS (linked stylesheets + computed styles of the original page's main sections — reference, not a structure to mirror 1:1):\n${JSON.stringify(staticData.sectionStyles).slice(0, 4_000)}`
                  : "",
                staticData
                  ? `REAL MEDIA INVENTORY (use these URLs, don't invent others):\n${JSON.stringify(staticData.media).slice(0, 3_000)}`
                  : "",
                `ANIMATION LIBRARIES DETECTED ON THE SITE: ${meta.detectedLibs.join(", ") || "none — use only CSS/@keyframes"}`,
                `PALETTE: ${meta.palette.join(", ") || "n/a"}`,
                `FONTS: ${meta.fonts.join(", ") || "n/a"}`,
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
