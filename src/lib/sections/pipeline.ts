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

// Un <video> live nell'harness non sarà mai allo stesso istante della ground
// truth congelata: mascheriamo la sua regione dal pixelmatch (vedi
// src/lib/render/diff.ts) invece di lasciarlo penalizzare un codice corretto.
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
  "Queste zone evidenziate nell'immagine diff non corrispondono all'originale: correggile.";

export interface Iteration {
  code: string;
  diffScore: number;
  feedback: string | null;
  /** Estensione rispetto al minimo di spec: evita un re-render solo per mostrare/ripristinare lo storico. */
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

  // sourceScreenshot è nullable in schema (le sezioni del nuovo flusso studio
  // non hanno ground truth DOM catturata, vedi src/lib/reconstruction), ma
  // questo loop opera SOLO su sezioni del vecchio flusso auto (dismesso, non
  // cancellato), che lo popolano sempre in cattura — vedi src/lib/sections/capture.ts.
  if (!section.sourceScreenshot) {
    throw new Error("Sezione senza sourceScreenshot: non è una ground truth del vecchio flusso di cattura automatica.");
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
 * Loop automatico (Fase D): genera → render → diff, e se `diffScore` resta
 * sopra soglia rimanda al modello ground truth + ultimo codice + immagine-diff,
 * fino a MAX_AUTO_ITERATIONS. Ogni tentativo viene registrato in `iterations`.
 */
export async function runAutoReconstructionLoop(sectionId: string): Promise<Section> {
  assertLocalOnly("La ricostruzione automatica");

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
      // Un render fallito (es. glitch del dev server, componente che monta
      // vuoto) consuma un tentativo ma NON abbandona la sezione: il prossimo
      // giro riceve l'errore come feedback e riprova, invece di far fallire
      // l'intera sezione al primo intoppo transiente.
      lastRenderError = err instanceof Error ? err : new Error(String(err));
      previousCode = code;
      diffPngUrl = undefined;
      feedback = `Il tentativo precedente non si è renderizzato correttamente: ${lastRenderError.message}. Assicurati che il componente produca un layout visibile (niente contenitori ad altezza 0, niente elementi fuori schermo), usando solo classi Tailwind valide.`;
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
    // Tutti i tentativi sono falliti al render: nessuna iterazione valida da
    // mostrare, meglio propagare l'errore reale che tornare una sezione muta.
    throw lastRenderError;
  }

  return section;
}

/**
 * Un'unica iterazione guidata da feedback admin in linguaggio naturale
 * (pannello sezione). Nessun loop automatico: l'admin ri-clicca per iterare.
 */
export async function regenerateWithFeedback(sectionId: string, feedback: string): Promise<Section> {
  assertLocalOnly("La rigenerazione");

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

/** Ripristina un tentativo storico come corrente, senza toccare `iterations`. */
export async function restoreIteration(sectionId: string, index: number): Promise<Section> {
  const section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
  const iterations = parseIterations(section);
  const target = iterations[index];
  if (!target) throw new Error("Iterazione non trovata");

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
