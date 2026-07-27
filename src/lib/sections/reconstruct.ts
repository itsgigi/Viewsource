import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import type { Section } from "@/generated/prisma/client";
import type { FilmstripFrame, MediaAsset } from "@/lib/ingest/capture";

// High-end, vision-capable model — NOT mini, quality here is the product
// (spec Phase B). Can be overridden via OPENAI_VISION_MODEL.
const visionModel = new ChatOpenAI({
  model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  temperature: 0.2,
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("The complete React+TypeScript component, in a single file, ready to use"),
  notes: z
    .string()
    .describe(
      "What was faithfully reconstructed and what was invented/approximated (e.g. animations not capturable from static source, or sections annotated as not faithfully reconstructible)"
    ),
});

export interface ReconstructOptions {
  previousCode?: string;
  /** URL of the last attempt's diff (pixelmatch) image, if available. */
  diffPngUrl?: string;
  /** Natural-language feedback (admin, or the automatic loop's generic one). */
  feedback?: string;
}

interface Annotations {
  mediaType: "image" | "video" | "canvas-webgl" | "none";
  animations: string[];
  difficulty: "easy" | "medium" | "not-feasible";
  notes?: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// Format change vs. the previous version (Tailwind-only): translating to
// Tailwind lost clip-path/mix-blend-mode/custom grid/composite transforms.
// Now the real captured CSS is preserved almost verbatim.
const SYSTEM_PROMPT = `You are a senior frontend engineer. Reconstruct a section of a real website as a SINGLE React + TypeScript component, as visually faithful as possible to the provided screenshot and structurally faithful to the provided HTML/CSS (captured from the real DOM — primary source).

Format rules:
- Output in a SINGLE self-contained file with an export default of a functional component, with NO required props.
- The JSX structure must mirror the hierarchy of the captured HTML (sourceHtml), not be freely reinvented.
- Do NOT translate the styling to Tailwind: carry the captured CSS (sourceCss) almost verbatim, cleaned of irrelevant rules and with CSS variables resolved, in a <style> tag in the same file, with prefixed classes to avoid global collisions (e.g. "sec-{sectionname}-title" instead of "title"). Keep clip-path, mix-blend-mode, custom grid-template, viewport units, and composite transforms intact — these are exactly what would be lost translating to Tailwind.
- NO imports from external project files and NO npm libraries besides "react" — EXCEPT "gsap" and "framer-motion", available ONLY if the section indicates the site uses them (see "detected libraries" below): import them only in that case, otherwise animations via CSS/@keyframes in the same <style>.
- Media: if a source is a video (see media inventory below), generate a <video> tag with the real URL provided — NEVER an <img> instead. Use the real URLs provided for content images/videos. ONLY for logos/brand (not content media) use a neutral placeholder (e.g. a block with the text "Logo") while keeping the original layout.
- Animations must settle into their final visual state shortly after mount, WITHOUT depending on a real user scroll: this component's fidelity is judged from a single static screenshot captured right after mount, not from real interaction. A scroll-gated animation that stays "unrevealed" in that screenshot is judged as an error, even if the code is conceptually correct.
- Production-quality code: typed, accessible, responsive.
- If you receive a previous attempt, feedback, and/or a diff image: do NOT repeat the previous attempt identically, fix specifically what the feedback and the highlighted diff areas indicate.`;

function describeMediaAssets(assets: MediaAsset[]): string {
  if (assets.length === 0) return "(no media detected in this section)";
  return assets
    .map((a, i) => {
      const parts = [`[${i}] ${a.kind}`];
      if (a.src) parts.push(`src="${a.src}"`);
      if (a.poster) parts.push(`poster="${a.poster}"`);
      if (a.width || a.height) parts.push(`${a.width ?? "?"}x${a.height ?? "?"}`);
      if (a.objectFit) parts.push(`object-fit:${a.objectFit}`);
      if (a.backgroundSize) parts.push(`background-size:${a.backgroundSize}`);
      if (a.kind === "video") {
        const attrs = [
          a.autoplay && "autoplay",
          a.loop && "loop",
          a.muted && "muted",
          a.playsinline && "playsinline",
        ].filter(Boolean);
        if (attrs.length) parts.push(attrs.join(","));
      }
      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Generates (or regenerates, with iteration context) a section's code.
 * Vision input: always the original screenshot; on iteration, also the
 * last attempt's diff image; a few filmstrip frames, if available, for
 * dynamic behavior context.
 */
export async function generateSectionCode(
  section: Section,
  opts: ReconstructOptions = {}
): Promise<{ code: string; notes: string }> {
  const structured = visionModel.withStructuredOutput(codeSchema, {
    name: "section_reconstruction",
  });

  const mediaAssets = parseJson<MediaAsset[]>(section.mediaAssets, []);
  const detectedLibs = parseJson<string[]>(section.detectedLibs, []);
  const annotations = parseJson<Annotations | null>(section.annotations, null);
  const filmstrip = parseJson<FilmstripFrame[]>(section.filmstrip, []);

  const textParts = [
    `SECTION: "${section.name}"`,
    `CAPTURED HTML (primary source, real DOM):\n${section.sourceHtml}`,
    section.sourceCss ? `CAPTURED CSS (primary source, real DOM):\n${section.sourceCss}` : "",
    `REAL MEDIA INVENTORY (use these URLs, don't invent others):\n${describeMediaAssets(mediaAssets)}`,
    `ANIMATION LIBRARIES DETECTED ON THE SITE: ${detectedLibs.length > 0 ? detectedLibs.join(", ") : "none — use only CSS/@keyframes"}`,
    section.motionDescription
      ? `SCROLL-DRIVEN BEHAVIOR DESCRIPTION (reviewed by the admin):\n${section.motionDescription}`
      : "",
    annotations
      ? `ADMIN ANNOTATION: media type=${annotations.mediaType}, animations=${annotations.animations.join(",") || "none"}, difficulty=${annotations.difficulty}${annotations.notes ? `, notes="${annotations.notes}"` : ""}${annotations.difficulty === "not-feasible" ? " — still make a best-effort attempt and state so explicitly in notes" : ""}`
      : "",
    opts.previousCode
      ? `PREVIOUS ATTEMPT (to fix, not to repeat identically):\n${opts.previousCode}`
      : "",
    opts.feedback ? `FEEDBACK TO APPLY:\n${opts.feedback}` : "",
    opts.diffPngUrl
      ? "The image attached after the original screenshot and filmstrip frames is the difference map (pixelmatch) between the original and the reconstruction: the highlighted areas do NOT match the original, fix them."
      : "",
  ].filter(Boolean);

  const images = [{ type: "image_url" as const, image_url: { url: section.sourceScreenshot } }];
  // Representative, not all of them: 3-4 frames are enough to give dynamic
  // context without excessively bloating the prompt.
  const step = Math.max(1, Math.ceil(filmstrip.length / 4));
  for (let i = 0; i < filmstrip.length; i += step) {
    images.push({ type: "image_url" as const, image_url: { url: filmstrip[i].url } });
  }
  if (opts.diffPngUrl) {
    images.push({ type: "image_url" as const, image_url: { url: opts.diffPngUrl } });
  }

  const userContent = [{ type: "text" as const, text: textParts.join("\n\n") }, ...images];

  return structured.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);
}
