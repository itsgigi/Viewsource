/**
 * Stato "in corso" delle operazioni dello studio di ricostruzione, per slug,
 * tenuto in memoria di processo — stesso pattern di src/lib/sections/progress.ts
 * (il meccanismo gira solo in locale, un solo processo Node).
 */

export type ReconstructionStage =
  | "recording-scripted"
  | "extracting-frames"
  | "extracting-static"
  | "analyzing"
  | "generating"
  | "publishing";

interface StageProgress {
  stage: ReconstructionStage;
  detail?: string;
}

interface SlugProgress {
  running: StageProgress | null;
  error: string | null;
}

const progressBySlug = new Map<string, SlugProgress>();

function get(slug: string): SlugProgress {
  let p = progressBySlug.get(slug);
  if (!p) {
    p = { running: null, error: null };
    progressBySlug.set(slug, p);
  }
  return p;
}

export function getReconstructionProgress(slug: string): SlugProgress {
  return get(slug);
}

export function setRunning(slug: string, progress: StageProgress | null): void {
  get(slug).running = progress;
}

export function setReconstructionError(slug: string, error: string | null): void {
  get(slug).error = error;
}
