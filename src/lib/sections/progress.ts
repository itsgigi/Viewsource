/**
 * "In progress" capture/reconstruction state, per site, kept in process
 * memory (the mechanism runs local-only, a single Node process: no need
 * for persistence). The frontend polls this state to show a narrative
 * screen instead of a plain blocking spinner.
 */

import type { CaptureProgress } from "@/lib/ingest/capture";

// Superset of CaptureProgress: "labeling"/"saving" are stages specific to
// this level (after the Playwright browser has already closed), not to
// the DOM capture module.
export interface SectionCaptureProgress {
  stage: CaptureProgress["stage"] | "labeling" | "saving";
  found?: number;
  total?: number;
}

interface SiteProgress {
  capturing: SectionCaptureProgress | null;
  reconstructing: { total: number; done: number; current: string | null } | null;
  error: string | null;
}

const progressBySite = new Map<string, SiteProgress>();

function get(siteId: string): SiteProgress {
  let p = progressBySite.get(siteId);
  if (!p) {
    p = { capturing: null, reconstructing: null, error: null };
    progressBySite.set(siteId, p);
  }
  return p;
}

export function getProgress(siteId: string): SiteProgress {
  return get(siteId);
}

export function setCapturing(siteId: string, progress: SectionCaptureProgress | null): void {
  get(siteId).capturing = progress;
}

export function setReconstructing(
  siteId: string,
  progress: { total: number; done: number; current: string | null } | null
): void {
  get(siteId).reconstructing = progress;
}

export function setError(siteId: string, error: string | null): void {
  get(siteId).error = error;
}
