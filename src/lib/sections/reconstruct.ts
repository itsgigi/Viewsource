import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import type { Section } from "@/generated/prisma/client";
import type { FilmstripFrame, MediaAsset } from "@/lib/ingest/capture";

// Modello vision-capable e di fascia alta — NON mini, la qualità qui è il
// prodotto (spec Fase B). Override possibile via OPENAI_VISION_MODEL.
const visionModel = new ChatOpenAI({
  model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",
  temperature: 0.2,
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("Il componente React+TypeScript completo, in un singolo file, pronto all'uso"),
  notes: z
    .string()
    .describe(
      "Cosa è stato ricostruito fedelmente e cosa è stato inventato/approssimato (es. animazioni non catturabili dal sorgente statico, o sezioni annotate come non ricostruibili fedelmente)"
    ),
});

export interface ReconstructOptions {
  previousCode?: string;
  /** URL dell'immagine-diff (pixelmatch) dell'ultimo tentativo, se disponibile. */
  diffPngUrl?: string;
  /** Feedback in linguaggio naturale (admin, o generico del loop automatico). */
  feedback?: string;
}

interface Annotations {
  mediaType: "image" | "video" | "canvas-webgl" | "none";
  animations: string[];
  difficulty: "easy" | "medium" | "not-feasible";
  notes?: string;
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

// Cambio di formato rispetto alla versione precedente (Tailwind-only): la
// traduzione in Tailwind perdeva clip-path/mix-blend-mode/grid custom/transform
// compositi. Ora il CSS reale catturato viene preservato quasi verbatim.
const SYSTEM_PROMPT = `Sei un frontend engineer senior. Ricostruisci una sezione di un sito web reale come un SINGOLO componente React + TypeScript, il più fedele possibile visivamente allo screenshot fornito e strutturalmente all'HTML/CSS forniti (catturati dal DOM reale — fonte primaria).

Regole di formato:
- Output in un SINGOLO file autonomo con export default di un componente funzionale, SENZA props richieste.
- La struttura JSX deve rispecchiare la gerarchia dell'HTML catturato (sourceHtml), non essere reinventata liberamente.
- NON tradurre lo stile in Tailwind: porta il CSS catturato (sourceCss) quasi verbatim, ripulito da regole non pertinenti e con le variabili CSS risolte, in un tag <style> nello stesso file, con le classi prefissate per evitare collisioni globali (es. "sec-{nomesezione}-titolo" invece di "titolo"). Mantieni intatti clip-path, mix-blend-mode, grid-template custom, unità viewport, transform compositi — sono esattamente ciò che andrebbe perso traducendo in Tailwind.
- SENZA import da file esterni del progetto e SENZA librerie npm oltre a "react" — TRANNE "gsap" e "framer-motion", disponibili SOLO se la sezione indica che il sito le usa (vedi "librerie rilevate" più sotto): importale solo in quel caso, altrimenti animazioni via CSS/@keyframes nello stesso <style>.
- Media: se una fonte è un video (vedi inventario media più sotto), genera un tag <video> con l'URL reale fornito — MAI un <img> al suo posto. Usa gli URL reali forniti per immagini/video di contenuto. SOLO per loghi/brand (non per media di contenuto) usa un placeholder neutro (es. blocco con testo "Logo") mantenendo il layout originale.
- Le animazioni devono risolversi al loro stato visivo finale poco dopo il mount, SENZA dipendere da uno scroll reale dell'utente: la fedeltà di questo componente viene giudicata da un singolo screenshot statico catturato subito dopo il mount, non da un'interazione reale. Un'animazione scroll-gated che resta "non rivelata" in quello screenshot viene giudicata come un errore, anche se il codice è concettualmente corretto.
- Codice production-quality: tipizzato, accessibile, responsive.
- Se ricevi un tentativo precedente, un feedback e/o un'immagine-diff: NON ripetere il tentativo precedente identico, correggi specificamente ciò che il feedback e le zone evidenziate nella diff indicano.`;

function describeMediaAssets(assets: MediaAsset[]): string {
  if (assets.length === 0) return "(nessun media rilevato in questa sezione)";
  return assets
    .map((a, i) => {
      const parts = [`[${i}] ${a.kind}`];
      if (a.src) parts.push(`src="${a.src}"`);
      if (a.poster) parts.push(`poster="${a.poster}"`);
      if (a.width || a.height) parts.push(`${a.width ?? "?"}x${a.height ?? "?"}`);
      if (a.objectFit) parts.push(`object-fit:${a.objectFit}`);
      if (a.backgroundSize) parts.push(`background-size:${a.backgroundSize}`);
      if (a.kind === "video") {
        const attrs = [
          a.autoplay && "autoplay",
          a.loop && "loop",
          a.muted && "muted",
          a.playsinline && "playsinline",
        ].filter(Boolean);
        if (attrs.length) parts.push(attrs.join(","));
      }
      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Genera (o rigenera, con contesto d'iterazione) il codice di una sezione.
 * Input vision: sempre lo screenshot originale; in iterazione anche
 * l'immagine-diff dell'ultimo tentativo; alcuni frame della filmstrip di
 * scroll, se disponibili, per contesto sul comportamento dinamico.
 */
export async function generateSectionCode(
  section: Section,
  opts: ReconstructOptions = {}
): Promise<{ code: string; notes: string }> {
  const structured = visionModel.withStructuredOutput(codeSchema, {
    name: "section_reconstruction",
  });

  const mediaAssets = parseJson<MediaAsset[]>(section.mediaAssets, []);
  const detectedLibs = parseJson<string[]>(section.detectedLibs, []);
  const annotations = parseJson<Annotations | null>(section.annotations, null);
  const filmstrip = parseJson<FilmstripFrame[]>(section.filmstrip, []);

  const textParts = [
    `SEZIONE: "${section.name}"`,
    `HTML CATTURATO (fonte primaria, DOM reale):\n${section.sourceHtml}`,
    section.sourceCss ? `CSS CATTURATO (fonte primaria, DOM reale):\n${section.sourceCss}` : "",
    `INVENTARIO MEDIA REALE (usa questi URL, non inventarne altri):\n${describeMediaAssets(mediaAssets)}`,
    `LIBRERIE DI ANIMAZIONE RILEVATE SUL SITO: ${detectedLibs.length > 0 ? detectedLibs.join(", ") : "nessuna — usa solo CSS/@keyframes"}`,
    section.motionDescription
      ? `DESCRIZIONE DEL COMPORTAMENTO SCROLL-DRIVEN (rivista dall'admin):\n${section.motionDescription}`
      : "",
    annotations
      ? `ANNOTAZIONE ADMIN: tipo media=${annotations.mediaType}, animazioni=${annotations.animations.join(",") || "nessuna"}, difficoltà=${annotations.difficulty}${annotations.notes ? `, note="${annotations.notes}"` : ""}${annotations.difficulty === "not-feasible" ? " — fai comunque un tentativo best-effort e dichiaralo esplicitamente in notes" : ""}`
      : "",
    opts.previousCode
      ? `TENTATIVO PRECEDENTE (da correggere, non da ripetere identico):\n${opts.previousCode}`
      : "",
    opts.feedback ? `FEEDBACK DA APPLICARE:\n${opts.feedback}` : "",
    opts.diffPngUrl
      ? "L'immagine allegata dopo lo screenshot originale e i frame di filmstrip è la mappa delle differenze (pixelmatch) tra originale e ricostruzione: le zone evidenziate NON corrispondono all'originale, correggile."
      : "",
  ].filter(Boolean);

  const images = [{ type: "image_url" as const, image_url: { url: section.sourceScreenshot } }];
  // Rappresentativi, non tutti: 3-4 frame bastano a dare contesto dinamico
  // senza gonfiare eccessivamente il prompt.
  const step = Math.max(1, Math.ceil(filmstrip.length / 4));
  for (let i = 0; i < filmstrip.length; i += step) {
    images.push({ type: "image_url" as const, image_url: { url: filmstrip[i].url } });
  }
  if (opts.diffPngUrl) {
    images.push({ type: "image_url" as const, image_url: { url: opts.diffPngUrl } });
  }

  const userContent = [{ type: "text" as const, text: textParts.join("\n\n") }, ...images];

  return structured.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);
}
