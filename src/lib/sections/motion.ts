import { ChatOpenAI } from "@langchain/openai";
import type { Section } from "@/generated/prisma/client";
import type { FilmstripFrame, MotionHint } from "@/lib/ingest/capture";

// Descrizione del comportamento scroll-driven: non è il prodotto finale (lo
// è il codice ricostruito), quindi un modello economico basta — l'admin la
// rivede e corregge comunque prima che conti per qualcosa (Fase 5c).
const motionModel = new ChatOpenAI({
  model: process.env.OPENAI_MOTION_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
});

const SYSTEM_PROMPT = `Guardi una sequenza di screenshot (filmstrip) di UNA sezione di un sito web, presi a scroll progressivo dall'alto verso il basso. Descrivi in italiano, in poche frasi, cosa cambia visivamente da un frame al successivo: cosa entra/esce e con che direzione, cosa si sostituisce e a che punto approssimativo dello scroll, cosa sembra avere effetto parallasse (si muove a velocità diversa dallo scroll), cosa sembra sticky/pinned (resta fermo mentre il resto scorre). Se la sequenza non mostra cambiamenti degni di nota, dillo chiaramente e brevemente ("nessuna animazione evidente"). Non inventare comportamenti che non vedi nei frame. Massimo 5-6 frasi.`;

function parseJson<T>(value: string | null | unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Genera la descrizione automatica del comportamento scroll-driven di una
 * sezione dalla sua filmstrip. Non chiede mai all'admin di scriverla da zero
 * — la mostra e lui la corregge dove serve (Fase 5c).
 */
export async function generateMotionDescription(section: Section): Promise<string> {
  const filmstrip = parseJson<FilmstripFrame[]>(section.filmstrip, []);
  if (filmstrip.length === 0) {
    return "Nessun frame di scroll catturato per questa sezione: probabilmente non era visibile durante la cattura filmstrip, o è troppo corta perché lo scroll ci passi attraverso in modo apprezzabile.";
  }

  const motionHints = parseJson<MotionHint[]>(section.motionHints, []);
  const detectedLibs = parseJson<string[]>(section.detectedLibs, []);

  const hintsText =
    motionHints.length > 0
      ? motionHints
          .map(
            (h) =>
              `- tra frame ${h.fromFrame} e ${h.toFrame}: regione cambiata (y ${h.pageTop}-${h.pageBottom}px pagina), ${(h.changedRatio * 100).toFixed(1)}% pixel diversi`
          )
          .join("\n")
      : "(nessuna differenza rilevante rilevata meccanicamente tra i frame)";

  const textParts = [
    `SEZIONE: "${section.name}"`,
    `Librerie di animazione rilevate sulla pagina: ${detectedLibs.length > 0 ? detectedLibs.join(", ") : "nessuna"}`,
    `Regioni cambiate tra frame consecutivi (calcolate meccanicamente, pixelmatch):\n${hintsText}`,
    `Di seguito ${filmstrip.length} frame in ordine di scroll crescente.`,
  ].join("\n\n");

  const images = filmstrip.map((f) => ({
    type: "image_url" as const,
    image_url: { url: f.url },
  }));

  const result = await motionModel.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text" as const, text: textParts }, ...images] },
  ]);

  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}
