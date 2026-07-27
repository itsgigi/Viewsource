/**
 * Stato "in corso" di cattura/ricostruzione, per sito, tenuto in memoria di
 * processo (il meccanismo gira solo in locale, un solo processo Node: niente
 * bisogno di persistenza). Il frontend fa polling su questo stato per
 * mostrare una schermata discorsiva invece di un semplice spinner bloccante.
 */

import type { CaptureProgress } from "@/lib/ingest/capture";

// Sovrainsieme di CaptureProgress: "labeling"/"saving" sono stage propri di
// questo livello (dopo che il browser Playwright ha già chiuso), non del
// modulo di cattura DOM.
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
