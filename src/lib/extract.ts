import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { extractAnimationSignals } from "@/lib/analyze/animationSignals";
import type { Component, Site } from "@/generated/prisma/client";

// Target unico: la UI pubblica non offre più la scelta dello stack
export const EXTRACTION_TARGET = "React + TypeScript + Tailwind CSS";

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("Il codice completo del componente, in un singolo file, pronto all'uso"),
  filename: z.string().describe("Nome file suggerito, es. Hero.tsx"),
  deps: z
    .array(z.string())
    .describe("Dipendenze npm necessarie oltre a quelle base del target"),
  notes: z
    .string()
    .describe("Note d'uso: props, cosa personalizzare, cosa è stato ricostruito"),
});

const promptSchema = z.object({
  prompt: z
    .string()
    .describe(
      "Prompt completo e autonomo da incollare in un LLM (Claude, ChatGPT, Cursor...) per ricreare il componente in un altro progetto. Include descrizione, specifiche visive e comportamentali, riferimenti di codice e istruzioni di adattamento."
    ),
  notes: z
    .string()
    .describe("Suggerimenti su come usare il prompt e cosa specificare in più"),
});

export type ExtractionMode = "code" | "prompt";

export interface ExtractionResult {
  mode: ExtractionMode;
  code?: string;
  filename?: string;
  deps?: string[];
  prompt?: string;
  notes?: string;
}

export function suggestedFilename(componentName: string): string {
  return `${componentName.replace(/\s+/g, "")}.tsx`;
}

/**
 * Estrazione lazy con cache permanente: se il campo è già popolato restituisce
 * il salvato SENZA chiamare OpenAI; altrimenti genera una volta e persiste.
 */
export async function extractComponent(
  component: Component & { site: Site },
  mode: ExtractionMode
): Promise<ExtractionResult> {
  if (mode === "code" && component.code) {
    return {
      mode: "code",
      code: component.code,
      filename: suggestedFilename(component.name),
      deps: (component.deps as string[] | null) ?? [],
    };
  }
  if (mode === "prompt" && component.prompt) {
    return { mode: "prompt", prompt: component.prompt };
  }

  const site = component.site;

  // Recupera il documento sorgente (match esatto, poi parziale)
  const sourceDoc = component.sourcePath
    ? await prisma.document.findFirst({
        where: {
          siteId: site.id,
          OR: [
            { path: component.sourcePath },
            { path: { contains: lastSegment(component.sourcePath) } },
          ],
        },
      })
    : null;

  // package.json per contesto sulle dipendenze reali (solo repo git)
  const pkgDoc = await prisma.document.findFirst({
    where: { siteId: site.id, path: { endsWith: "package.json" } },
  });

  const designInfo = site.designInfo
    ? JSON.stringify(site.designInfo)
    : "non disponibile";

  const isAnimation = component.kind === "animation";
  const scrollScreenshots: string[] = isAnimation
    ? (site.scrollScreenshots as string[] | null) ?? []
    : [];
  const animationSignals = isAnimation
    ? extractAnimationSignals(sourceDoc?.html)
    : "";

  const sharedContext = `PROGETTO: ${site.name} (${site.sourceUrl})

COMPONENTE: ${component.name} (${component.kind})
DESCRIZIONE: ${component.description}

STACK TARGET: ${EXTRACTION_TARGET}

DESIGN INFO DEL PROGETTO:
${designInfo}

${
  sourceDoc
    ? `SORGENTE (${sourceDoc.path}):\n${sourceDoc.content.slice(0, 30_000)}`
    : "SORGENTE: non disponibile — basati su descrizione e design info."
}

${pkgDoc ? `PACKAGE.JSON DEL PROGETTO:\n${pkgDoc.content.slice(0, 4_000)}` : ""}

${
  animationSignals
    ? `SEGNALI DI ANIMAZIONE (HTML renderizzato della pagina sorgente):\n${animationSignals}`
    : ""
}`;

  const userContent =
    scrollScreenshots.length > 0
      ? [
          { type: "text" as const, text: sharedContext },
          ...scrollScreenshots.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : sharedContext;

  const animationGuidance = isAnimation
    ? " Se sono fornite immagini in sequenza, rappresentano lo scorrimento della pagina dall'alto verso il basso: osservale per dedurre la tecnica di animazione realmente usata (parallax, trasformazione legata allo scroll, progress/fill bar, sticky reveal...) e implementala in modo idiomatico per lo stack target (es. framer-motion o GSAP ScrollTrigger per React, IntersectionObserver o CSS scroll-timeline per vanilla), invece di produrre un placeholder statico."
    : "";

  if (mode === "code") {
    const structured = chatModel.withStructuredOutput(codeSchema, {
      name: "component_extraction",
    });

    const result = await structured.invoke([
      {
        role: "system",
        content: `Sei un frontend engineer senior. Estrai o ricostruisci un componente UI da un progetto esistente, producendo codice pronto all'uso nello stack richiesto.

Regole:
- Output in un SINGOLO file autonomo, senza import da file del progetto originale.
- Se hai il codice sorgente, adattalo fedelmente allo stack target mantenendo comportamento e stile.
- Se hai solo contenuto testuale (pagina crawlata), RICOSTRUISCI il componente in modo fedele a struttura, contenuti e design descritti.
- Rispetta la palette e i font del progetto originale.
- Usa placeholder chiari dove i contenuti reali non sono disponibili.
- Codice production-quality: tipizzato, accessibile, responsive.${animationGuidance}`,
      },
      { role: "user", content: userContent },
    ]);

    await prisma.component.update({
      where: { id: component.id },
      data: { code: result.code, deps: result.deps },
    });

    return { mode: "code", ...result };
  }

  // mode === "prompt"
  const structured = chatModel.withStructuredOutput(promptSchema, {
    name: "component_prompt",
  });

  const result = await structured.invoke([
    {
      role: "system",
      content: `Sei un esperto di prompt engineering per lo sviluppo frontend. Il tuo compito è scrivere un PROMPT che l'utente incollerà in un altro LLM (Claude Code, Cursor, ChatGPT...) per ricreare un componente UI dentro un SUO progetto esistente.

Il prompt che produci deve essere autonomo e completo, e deve includere:
1. COSA COSTRUIRE: descrizione chiara del componente, struttura e gerarchia degli elementi.
2. SPECIFICHE VISIVE: palette (valori hex), tipografia, spaziature, breakpoint responsive — tratte dalle design info fornite.
3. COMPORTAMENTO: interazioni, animazioni, stati (hover, focus, loading...).
4. RIFERIMENTI DI CODICE: se il sorgente è disponibile, includi gli estratti più significativi come riferimento fedele (pattern, classi, logica chiave), citandone la provenienza.
5. ISTRUZIONI DI ADATTAMENTO: indica all'LLM di integrarsi con le convenzioni del progetto ospite (design tokens, componenti UI esistenti, struttura cartelle) invece di introdurre stili hardcoded, chiedendo all'utente il contesto se necessario.

Il prompt deve essere scritto nello stack target indicato, in italiano, ben strutturato con sezioni chiare. Non scrivere il codice completo del componente: scrivi le istruzioni e i riferimenti perché un LLM lo costruisca bene nel contesto di destinazione.${animationGuidance}`,
    },
    { role: "user", content: userContent },
  ]);

  await prisma.component.update({
    where: { id: component.id },
    data: { prompt: result.prompt },
  });

  return { mode: "prompt", ...result };
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

