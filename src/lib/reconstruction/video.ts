import path from "node:path";
import fs from "node:fs/promises";
import { assertLocalOnly } from "@/lib/local-only";
import { videoDir, updateMeta } from "./paths";
import { setRunning } from "./progress";

/** Salva il video umano caricato dall'admin (Fase 1a) — sorgente complementare
 * a quello scriptato: cattura hover/click/menu che uno script non saprebbe
 * innescare. */
export async function saveHumanVideo(
  slug: string,
  buffer: Buffer,
  originalFilename: string
): Promise<string> {
  const ext = path.extname(originalFilename) || ".mp4";
  const filename = `human${ext}`;
  await fs.mkdir(videoDir(slug), { recursive: true });
  await fs.writeFile(path.join(videoDir(slug), filename), buffer);

  await updateMeta(slug, (meta) => {
    meta.video.human = `material/video/${filename}`;
  });

  return filename;
}

/**
 * Scripted video (Playwright, Phase 1a): constant-speed scroll from top to
 * bottom, no cursor, reproducible — complements the human video. Runs
 * LOCAL ONLY (Playwright).
 */
export async function captureScriptedVideo(slug: string, sourceUrl: string): Promise<string> {
  assertLocalOnly("Scripted video recording");
  setRunning(slug, { stage: "recording-scripted" });

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const dir = videoDir(slug);
    await fs.mkdir(dir, { recursive: true });

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        recordVideo: { dir, size: { width: 1440, height: 900 } },
      });
      const page = await context.newPage();
      await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60_000 });
      await page.waitForTimeout(1_000);

      // Continuous constant-speed scroll (not step-wise, like the existing
      // filmstrip in src/lib/ingest/capture.ts): here we need a smooth
      // video, not discrete frames.
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
      const durationMs = Math.min(20_000, Math.max(6_000, scrollHeight * 4));
      const steps = 120;
      const stepDelay = durationMs / steps;
      for (let i = 1; i <= steps; i++) {
        const y = Math.round((scrollHeight * i) / steps);
        await page.evaluate((targetY) => window.scrollTo(0, targetY), y);
        await page.waitForTimeout(stepDelay);
      }
      await page.waitForTimeout(500);

      const video = page.video();
      await context.close(); // finalizza il file video

      if (!video) throw new Error("Playwright non ha prodotto un video (recordVideo non attivo)");
      const recordedPath = await video.path();
      const finalPath = path.join(dir, "scripted.webm");
      await fs.rename(recordedPath, finalPath);

      await updateMeta(slug, (meta) => {
        meta.video.scripted = "material/video/scripted.webm";
      });

      return "scripted.webm";
    } finally {
      await browser.close();
    }
  } finally {
    setRunning(slug, null);
  }
}
