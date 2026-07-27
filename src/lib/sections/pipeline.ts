import { prisma } from "@/lib/db";
import type { Section } from "@/generated/prisma/client";
import { renderComponent } from "@/lib/render";
import { compareScreenshots, type MaskRect } from "@/lib/render/diff";
import { uploadImage, SECTION_VIEWPORT_WIDTH, type MediaAsset } from "@/lib/ingest/capture";
import { assertLocalOnly } from "@/lib/local-only";
import { generateSectionCode } from "./reconstruct";

interface Annotations {
  mediaType: "image" | "video" | "canvas-webgl" | "none";
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

// A live <video> in the harness will never be at the same instant as the
// frozen ground truth: we mask its region out of the pixelmatch (see
// src/lib/render/diff.ts) instead of letting it penalize otherwise-correct code.
function videoMaskRect(section: Pick<Section, "annotations" | "mediaAssets">): MaskRect | undefined {
  const annotations = parseJson<Annotations | null>(section.annotations, null);
  if (annotations?.mediaType !== "video") return undefined;

  const assets = parseJson<MediaAsset[]>(section.mediaAssets, []);
  const video = assets.find((a) => a.kind === "video" && a.width && a.height);
  if (!video || video.top == null || video.left == null || !video.width || !video.height) return undefined;

  return { top: video.top, left: video.left, width: video.width, height: video.height };
}

export const DIFF_THRESHOLD = 0.1;
export const MAX_AUTO_ITERATIONS = 3;

const AUTO_LOOP_FEEDBACK =
  "These highlighted areas in the diff image don't match the original: fix them.";

export interface Iteration {
  code: string;
  diffScore: number;
  feedback: string | null;
  /** Extension beyond the spec minimum: avoids a re-render just to show/restore history. */
  renderScreenshot: string;
  diffScreenshot: string;
  createdAt: string;
}

function parseIterations(section: Pick<Section, "iterations">): Iteration[] {
  if (!section.iterations) return [];
  try {
    return JSON.parse(section.iterations) as Iteration[];
  } catch {
    return [];
  }
}

async function renderAndDiff(
  code: string,
  section: Pick<Section, "sourceScreenshot" | "annotations" | "mediaAssets">,
  namePrefix: string
) {
  const renderedBuffer = await renderComponent(code, { width: SECTION_VIEWPORT_WIDTH });

  // sourceScreenshot is nullable in the schema (sections from the new studio
  // flow have no captured DOM ground truth, see src/lib/reconstruction), but
  // this loop operates ONLY on sections from the old auto flow (deprecated,
  // not deleted), which always populate it at capture time — see
  // src/lib/sections/capture.ts.
  if (!section.sourceScreenshot) {
    throw new Error("Section without sourceScreenshot: not a ground truth from the old automatic capture flow.");
  }
  const originalRes = await fetch(section.sourceScreenshot);
  const originalBuffer = Buffer.from(await originalRes.arrayBuffer());

  const { diffScore, diffPng } = await compareScreenshots(originalBuffer, renderedBuffer, videoMaskRect(section));

  const [renderScreenshot, diffScreenshot] = await Promise.all([
    uploadImage(renderedBuffer, `${namePrefix}-render.png`),
    uploadImage(diffPng, `${namePrefix}-diff.png`),
  ]);

  return { diffScore, renderScreenshot, diffScreenshot };
}

async function appendIteration(sectionId: string, current: Section, iteration: Iteration): Promise<Section> {
  const iterations = [...parseIterations(current), iteration];
  return prisma.section.update({
    where: { id: sectionId },
    data: {
      generatedCode: iteration.code,
      diffScore: iteration.diffScore,
      renderScreenshot: iteration.renderScreenshot,
      status: "generated",
      iterations: JSON.stringify(iterations),
    },
  });
}

/**
 * Automatic loop (Phase D): generate → render → diff, and if `diffScore`
 * stays above threshold, feed the model ground truth + last code +
 * diff image again, up to MAX_AUTO_ITERATIONS. Every attempt is recorded
 * in `iterations`.
 */
export async function runAutoReconstructionLoop(sectionId: string): Promise<Section> {
  assertLocalOnly("Automatic reconstruction");

  let section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });

  let previousCode: string | undefined;
  let diffPngUrl: string | undefined;
  let feedback: string | undefined;
  let attempts = 0;
  let diffScore = Number.POSITIVE_INFINITY;
  let lastRenderError: Error | null = null;

  while (attempts < MAX_AUTO_ITERATIONS && diffScore > DIFF_THRESHOLD) {
    const { code } = await generateSectionCode(section, { previousCode, diffPngUrl, feedback });

    let result: Awaited<ReturnType<typeof renderAndDiff>>;
    try {
      result = await renderAndDiff(code, section, `sections/${section.id}-auto${attempts}`);
    } catch (err) {
      // A failed render (e.g. dev server glitch, component that mounts
      // empty) consumes an attempt but does NOT abandon the section: the
      // next round receives the error as feedback and retries, instead of
      // failing the whole section on the first transient hiccup.
      lastRenderError = err instanceof Error ? err : new Error(String(err));
      previousCode = code;
      diffPngUrl = undefined;
      feedback = `The previous attempt didn't render correctly: ${lastRenderError.message}. Make sure the component produces a visible layout (no zero-height containers, no off-screen elements), using only valid Tailwind classes.`;
      attempts++;
      continue;
    }

    lastRenderError = null;
    section = await appendIteration(sectionId, section, {
      code,
      diffScore: result.diffScore,
      feedback: feedback ?? null,
      renderScreenshot: result.renderScreenshot,
      diffScreenshot: result.diffScreenshot,
      createdAt: new Date().toISOString(),
    });

    diffScore = result.diffScore;
    previousCode = code;
    diffPngUrl = result.diffScreenshot;
    feedback = AUTO_LOOP_FEEDBACK;
    attempts++;
  }

  if (lastRenderError && !Number.isFinite(diffScore)) {
    // All attempts failed to render: no valid iteration to show, better to
    // propagate the real error than return a mute section.
    throw lastRenderError;
  }

  return section;
}

/**
 * A single iteration driven by admin feedback in natural language (section
 * panel). No automatic loop: the admin clicks again to iterate.
 */
export async function regenerateWithFeedback(sectionId: string, feedback: string): Promise<Section> {
  assertLocalOnly("Regeneration");

  const section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
  const iterations = parseIterations(section);
  const last = iterations[iterations.length - 1];

  const { code } = await generateSectionCode(section, {
    previousCode: section.generatedCode ?? undefined,
    diffPngUrl: last?.diffScreenshot,
    feedback,
  });

  const result = await renderAndDiff(code, section, `sections/${section.id}-manual${Date.now()}`);

  return appendIteration(sectionId, section, {
    code,
    diffScore: result.diffScore,
    feedback,
    renderScreenshot: result.renderScreenshot,
    diffScreenshot: result.diffScreenshot,
    createdAt: new Date().toISOString(),
  });
}

/** Restores a historical attempt as current, without touching `iterations`. */
export async function restoreIteration(sectionId: string, index: number): Promise<Section> {
  const section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
  const iterations = parseIterations(section);
  const target = iterations[index];
  if (!target) throw new Error("Iteration not found");

  return prisma.section.update({
    where: { id: sectionId },
    data: {
      generatedCode: target.code,
      diffScore: target.diffScore,
      renderScreenshot: target.renderScreenshot,
      status: "generated",
    },
  });
}
