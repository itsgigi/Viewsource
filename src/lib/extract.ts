import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { extractAnimationSignals } from "@/lib/analyze/animationSignals";
import { extractComponentSource } from "@/lib/ast/parseFile";
import type { CapturedSection } from "@/lib/ingest/capture";
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

export interface BundleFile {
  path: string;
  content: string;
}

export interface ExtractionResult {
  mode: ExtractionMode;
  code?: string;
  filename?: string;
  deps?: string[];
  prompt?: string;
  notes?: string;
  files?: BundleFile[]; // bundle multi-file completo (solo componenti origin "ast")
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
  if (component.origin === "ast") {
    return extractAstComponent(component, mode);
  }

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

  // Sezione catturata dal DOM reale (Playwright, Fase A) che corrisponde a
  // questo componente: fonte primaria di HTML/CSS reali per code e prompt.
  const capturedSections = (site.capturedSections as CapturedSection[] | null) ?? [];
  const capturedSection = component.sourcePath
    ? capturedSections.find(
        (s) =>
          s.selector === component.sourcePath ||
          s.selector.includes(component.sourcePath!) ||
          component.sourcePath!.includes(s.selector)
      )
    : undefined;

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
  capturedSection
    ? `SEZIONE CATTURATA DAL DOM REALE (Playwright, selettore "${capturedSection.selector}") — fonte primaria, fedele al renderizzato reale:\nHTML:\n${capturedSection.html.slice(0, 8_000)}\nCSS computato:\n${capturedSection.css.slice(0, 3_000)}`
    : ""
}

${
  sourceDoc
    ? `SORGENTE${capturedSection ? " (contesto aggiuntivo)" : ""} (${sourceDoc.path}):\n${sourceDoc.content.slice(0, 30_000)}`
    : !capturedSection
    ? "SORGENTE: non disponibile — basati su descrizione e design info."
    : ""
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
- Se è presente una SEZIONE CATTURATA DAL DOM REALE, è la fonte primaria: è HTML/CSS realmente renderizzati dal browser, non testo derivato. Riproducine fedelmente struttura DOM, classi/stili e gerarchia, adattandoli allo stack target.
- Se hai solo il codice sorgente (repo git), adattalo fedelmente allo stack target mantenendo comportamento e stile.
- Se hai solo contenuto testuale (pagina crawlata, nessuna cattura reale disponibile), RICOSTRUISCI il componente in modo fedele a struttura, contenuti e design descritti.
- Rispetta la palette e i font del progetto originale.
- Usa placeholder chiari dove i contenuti reali non sono disponibili.
- Codice production-quality: tipizzato, accessibile, responsive.
- IMPORTANTE — limite noto: JS e animazioni (GSAP, WebGL, Three.js, scroll-hijacking...) non vengono catturati come sorgente, solo la struttura statica renderizzata in un istante. Se il componente ha comportamento dinamico, il campo "code" deve unire struttura reale catturata + una tua ricostruzione plausibile del comportamento, e il campo "notes" DEVE dichiararlo esplicitamente (es. "animazione ricostruita dall'AI, non catturata dal sorgente").${animationGuidance}`,
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
4. RIFERIMENTI DI CODICE REALI: questo è OBBLIGATORIO, non opzionale — il prompt deve includere pezzi veri di HTML/CSS (non solo descrizione a parole). Se è presente una SEZIONE CATTURATA DAL DOM REALE, incolla nel prompt gli estratti più significativi del suo HTML e CSS computato (in un blocco di codice, citando il selettore di provenienza) come riferimento fedele per l'LLM che lo userà. Se hai solo il sorgente del repo, incolla gli estratti più significativi da lì. Se non hai né l'uno né l'altro, dichiaralo e basati sulla descrizione.
5. ISTRUZIONI DI ADATTAMENTO: indica all'LLM di integrarsi con le convenzioni del progetto ospite (design tokens, componenti UI esistenti, struttura cartelle) invece di introdurre stili hardcoded, chiedendo all'utente il contesto se necessario.

Il prompt deve essere scritto nello stack target indicato, in italiano, ben strutturato con sezioni chiare. Non scrivere il codice COMPLETO del componente: scrivi le istruzioni, PIÙ gli estratti di codice reale come riferimento, perché un LLM lo costruisca bene nel contesto di destinazione. Se il componente è di tipo animation, dichiara esplicitamente che il comportamento dinamico non è catturabile dal sorgente statico e va ricostruito.${animationGuidance}`,
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

// ---------- origin "ast" (Fase 5, ingestion da repo) ----------
// A differenza dei componenti "ai"/"source", qui codice, props e dipendenze
// sono già noti per costruzione (estratti deterministicamente in Fase 2):
// mode "code" non chiama mai l'LLM, mode "prompt" lo usa solo per la prosa
// (descrizione/adattamento), non per inventare codice o props.

interface AstPropField {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
}

const astPromptProseSchema = z.object({
  description: z
    .string()
    .describe("Cosa fa e come si comporta il componente, in italiano, per chi lo integrerà in un altro progetto"),
  adaptationNotes: z
    .string()
    .describe(
      "Istruzioni per integrarlo nelle convenzioni del progetto ospite (design tokens, componenti UI esistenti, struttura cartelle) invece di introdurre stili hardcoded"
    ),
});

async function extractAstComponent(
  component: Component & { site: Site },
  mode: ExtractionMode
): Promise<ExtractionResult> {
  const bundleFiles = safeParseJson<BundleFile[]>(component.bundleFiles, []);
  const npmDeps = safeParseJson<string[]>(component.npmDeps, []);
  const mainFile = bundleFiles.find((f) => f.path === component.filePath) ?? bundleFiles[0];

  if (mode === "code") {
    // Nessuna chiamata LLM: il bundle multi-file è già completo, estratto
    // deterministicamente all'ingestion (Fase 2/3). Il paywall vive nel
    // chiamante (route), qui si restituisce sempre il dato reale.
    return {
      mode: "code",
      code: mainFile?.content ?? "",
      filename: mainFile ? lastSegment(mainFile.path) : suggestedFilename(component.name),
      deps: npmDeps,
      files: bundleFiles,
    };
  }

  if (component.prompt) {
    return { mode: "prompt", prompt: component.prompt };
  }

  const propsSchema = safeParseJson<AstPropField[]>(component.propsSchema, []);
  const snippet = mainFile
    ? (extractComponentSource(mainFile.content, component.name) ?? mainFile.content).slice(0, 3_000)
    : "";

  const structured = chatModel.withStructuredOutput(astPromptProseSchema, {
    name: "ast_component_prompt",
  });

  const result = await structured.invoke([
    {
      role: "system",
      content:
        "Sei un esperto di prompt engineering per il frontend. Ti viene fornito un componente REALE (estratto dal codice sorgente di un progetto vero, non ricostruito): props e frammento di codice sono dati veri, non inventarli né riscriverli. Scrivi solo descrizione del comportamento e istruzioni di adattamento al progetto ospite: verranno unite automaticamente ai dati reali per formare il prompt finale.",
    },
    {
      role: "user",
      content: `COMPONENTE: ${component.name}\nPROPS REALI: ${JSON.stringify(propsSchema)}\nDIPENDENZE NPM: ${JSON.stringify(npmDeps)}\nFRAMMENTO DI CODICE REALE (${mainFile?.path ?? component.filePath}):\n${snippet}`,
    },
  ]);

  const propsLines = propsSchema.length
    ? propsSchema
        .map((p) => `- \`${p.name}\`${p.optional ? "?" : ""}: ${p.type}${p.defaultValue ? ` (default: ${p.defaultValue})` : ""}`)
        .join("\n")
    : "Nessuna prop rilevata.";

  const prompt = `${result.description}

## Props
${propsLines}

## Dipendenze npm
${npmDeps.length ? npmDeps.join(", ") : "nessuna oltre alle dipendenze base del progetto"}

## Frammento di codice reale (${mainFile?.path ?? component.filePath})
\`\`\`tsx
${snippet}
\`\`\`

## Istruzioni di adattamento
${result.adaptationNotes}`;

  await prisma.component.update({ where: { id: component.id }, data: { prompt } });

  return { mode: "prompt", prompt };
}

function safeParseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

