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
// Candidate thresholds in attempt order: starts at 0.25 (spec); if too
// many frames result, go up (less sensitive scene detection), if too few,
// go down (more sensitive).
const THRESHOLDS = [0.25, 0.4, 0.55, 0.15, 0.08];

async function clearFramesDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries.filter((f) => f.endsWith(".jpg")).map((f) => fs.rm(path.join(dir, f)))
  );
}

/** One extraction attempt at a given scene threshold: returns the
 * timestamps (pts_time, seconds) of each selected frame, in the order they
 * appear in the output — one showinfo per frame that passes `select`. */
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
      // Videos recorded by Chromium/Playwright (vp8/webm) are often
      // full-range YUV; the .jpg output's mjpeg encoder rejects it as
      // "non-standard" unless strict compliance is relaxed — this doesn't
      // affect perceived quality, the frames are only an internal reference.
      "-strict",
      "unofficial",
      outPattern,
    ],
    { maxBuffer: 1024 * 1024 * 32 }
  ).catch((err) => {
    // ffmpeg always writes to stderr even on success: we capture the error
    // too so we don't lose the diagnostic output if the command fails.
    throw new Error(`ffmpeg failed: ${err.stderr ?? err.message}`);
  });

  const timestamps: number[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) timestamps.push(parseFloat(m[1]));
  }
  return timestamps;
}

/**
 * Frame extraction with scene detection (Phase 1b): one frame every time the
 * scene visually changes, not at a fixed interval. If the frame count is
 * outside [MIN_FRAMES, MAX_FRAMES], retry with different thresholds.
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
