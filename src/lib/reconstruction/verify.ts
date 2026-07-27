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
 * Fase 4 — strumento di verifica A RICHIESTA (mai un loop automatico): render
 * della sezione via lo studio, confronto pixelmatch con il frame scelto
 * dall'admin come riferimento. Il frame è JPEG (estratto da ffmpeg), va
 * convertito a PNG prima del confronto (compareScreenshots richiede PNG).
 */
export async function verifySection(
  slug: string,
  sectionFile: string,
  referenceFrame: string
): Promise<VerifyResult> {
  assertLocalOnly("Il confronto visivo");

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
