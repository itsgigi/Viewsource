import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertLocalOnly } from "@/lib/local-only";
import { framesDir, reconstructionDir, readMeta, updateMeta, type ReconstructionFrame } from "./paths";
import { setRunning } from "./progress";

const execFileAsync = promisify(execFile);

const MIN_FRAMES = 8;
const MAX_FRAMES = 60;
// Soglie candidate in ordine di tentativo: si parte da 0.25 (spec); se
// risultano troppi frame si sale (scena meno sensibile), se troppo pochi si
// scende (scena più sensibile).
const THRESHOLDS = [0.25, 0.4, 0.55, 0.15, 0.08];

async function clearFramesDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries.filter((f) => f.endsWith(".jpg")).map((f) => fs.rm(path.join(dir, f)))
  );
}

/** Un tentativo di estrazione a una data soglia scene: restituisce i
 * timestamp (pts_time, secondi) di ciascun frame selezionato, nell'ordine in
 * cui compaiono nell'output — uno showinfo per frame che supera `select`. */
async function runFfmpegAttempt(videoPath: string, dir: string, threshold: number): Promise<number[]> {
  await clearFramesDir(dir);

  const outPattern = path.join(dir, "frame_%03d.jpg");
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `select='gt(scene,${threshold})',showinfo,scale=1600:-1`,
      "-vsync",
      "vfr",
      "-q:v",
      "2",
      // Video registrati da Chromium/Playwright (vp8/webm) sono spesso
      // full-range YUV; l'encoder mjpeg dell'output .jpg lo rifiuta come
      // "non-standard" a meno di allentare lo strict compliance — non
      // tocca la qualità percepita, i frame sono solo riferimento interno.
      "-strict",
      "unofficial",
      outPattern,
    ],
    { maxBuffer: 1024 * 1024 * 32 }
  ).catch((err) => {
    // ffmpeg scrive sempre su stderr anche in caso di successo: catturiamo
    // anche l'errore per non perdere l'output diagnostico se il comando fallisce.
    throw new Error(`ffmpeg fallito: ${err.stderr ?? err.message}`);
  });

  const timestamps: number[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) timestamps.push(parseFloat(m[1]));
  }
  return timestamps;
}

/**
 * Estrazione frame con scene detection (Fase 1b): un frame ogni volta che la
 * scena cambia visivamente, non a intervallo fisso. Se il numero di frame è
 * fuori range [MIN_FRAMES, MAX_FRAMES], riprova con soglie diverse.
 */
export async function extractFrames(
  slug: string,
  source: "human" | "scripted"
): Promise<ReconstructionFrame[]> {
  assertLocalOnly("L'estrazione dei frame");
  setRunning(slug, { stage: "extracting-frames" });

  try {
    const meta = await readMeta(slug);
    const rel = source === "human" ? meta.video.human : meta.video.scripted;
    if (!rel) throw new Error(`Nessun video "${source}" caricato/generato per questa ricostruzione`);

    const videoPath = path.join(reconstructionDir(slug), rel);
    const dir = framesDir(slug);

    let timestamps: number[] = [];
    for (const threshold of THRESHOLDS) {
      timestamps = await runFfmpegAttempt(videoPath, dir, threshold);
      if (timestamps.length >= MIN_FRAMES && timestamps.length <= MAX_FRAMES) break;
    }

    if (timestamps.length === 0) {
      throw new Error("ffmpeg non ha estratto nessun frame (scene detection troppo/poco sensibile per questo video)");
    }

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    const frames: ReconstructionFrame[] = files.map((file, i) => ({
      file,
      timestampMs: Math.round((timestamps[i] ?? 0) * 1000),
    }));

    await updateMeta(slug, (m) => {
      m.frames = frames;
      if (m.phase === "collecting") m.phase = "collecting"; // resta in raccolta finché non si passa ad analyze
    });

    return frames;
  } finally {
    setRunning(slug, null);
  }
}
