import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import sharp from "sharp";

export interface DiffResult {
  /** 0 = identico, 1 = totalmente diverso. */
  diffScore: number;
  /** PNG con le zone diverse evidenziate. */
  diffPng: Buffer;
}

const PIXELMATCH_THRESHOLD = 0.1;

export interface MaskRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Confronta due screenshot PNG con pixelmatch. `originalPng` detta le
 * dimensioni del canvas: `renderedPng` viene ridimensionato (letterbox su
 * sfondo bianco, mai stretch) per garantire dimensioni identiche, requisito
 * di pixelmatch.
 *
 * `maskRect` (opzionale): regione da escludere dal punteggio — usata per i
 * `<video>`, il cui frame live nell'harness non sarà mai allo stesso istante
 * della ground truth congelata: penalizzarlo nel pixelmatch sarebbe un
 * segnale falso, non un errore di fedeltà del codice generato.
 */
export async function compareScreenshots(
  originalPng: Buffer,
  renderedPng: Buffer,
  maskRect?: MaskRect
): Promise<DiffResult> {
  const original = PNG.sync.read(originalPng);
  const { width, height } = original;

  const resizedRenderedBuffer = await sharp(renderedPng)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
  const rendered = PNG.sync.read(resizedRenderedBuffer);

  let excludedPixels = 0;
  if (maskRect) {
    const top = Math.max(0, Math.round(maskRect.top));
    const left = Math.max(0, Math.round(maskRect.left));
    const right = Math.min(width, left + Math.round(maskRect.width));
    const bottom = Math.min(height, top + Math.round(maskRect.height));
    excludedPixels = Math.max(0, right - left) * Math.max(0, bottom - top);

    // Azzera la regione mascherata su entrambe le immagini PRIMA di pixelmatch,
    // così quei pixel risultano identici (non contati come diff) e la diff
    // image mostra la regione come chiaramente esclusa, non un errore.
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const idx = (width * y + x) * 4;
        for (const buf of [original.data, rendered.data]) {
          buf[idx] = 0;
          buf[idx + 1] = 0;
          buf[idx + 2] = 0;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(original.data, rendered.data, diff.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
  });

  const scoreDenominator = width * height - excludedPixels;

  return {
    diffScore: scoreDenominator > 0 ? numDiffPixels / scoreDenominator : 0,
    diffPng: PNG.sync.write(diff),
  };
}
