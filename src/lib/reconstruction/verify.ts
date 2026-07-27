import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { assertLocalOnly } from "@/lib/local-only";
import { renderStudio } from "./studio";
import { compareScreenshots } from "@/lib/render/diff";
import { uploadImage } from "@/lib/ingest/capture";
import { framesDir } from "./paths";

export interface VerifyResult {
  diffScore: number;
  diffImageUrl: string;
  renderImageUrl: string;
}

/**
 * Phase 4 — ON-DEMAND verification tool (never an automatic loop): renders
 * the section via the studio, pixelmatch comparison against the frame
 * chosen by the admin as reference. The frame is JPEG (extracted via
 * ffmpeg), needs to be converted to PNG before comparison
 * (compareScreenshots requires PNG).
 */
export async function verifySection(
  slug: string,
  sectionFile: string,
  referenceFrame: string
): Promise<VerifyResult> {
  assertLocalOnly("Visual comparison");

  const frameBuffer = await fs.readFile(path.join(framesDir(slug), referenceFrame));
  const framePng = await sharp(frameBuffer).png().toBuffer();

  const renderedBuffer = await renderStudio(slug, sectionFile);

  const { diffScore, diffPng } = await compareScreenshots(framePng, renderedBuffer);

  const [diffImageUrl, renderImageUrl] = await Promise.all([
    uploadImage(diffPng, `reconstructions/${slug}-${sectionFile}-diff.png`),
    uploadImage(renderedBuffer, `reconstructions/${slug}-${sectionFile}-render.png`),
  ]);

  return { diffScore, diffImageUrl, renderImageUrl };
}
