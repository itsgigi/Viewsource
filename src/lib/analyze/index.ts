import { z } from "zod";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { qdrant, COLLECTION, ensureCollection } from "@/lib/qdrant";
import { extractAnimationSignals } from "./animationSignals";
import type { CapturedSection as CapturedSectionInfo } from "@/lib/ingest/capture";

// ---------- Config ----------

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small", // 1536 dim, allineato a VECTOR_SIZE in qdrant.ts
});

// Quanto corpus passare al modello per l'analisi (in caratteri)
const MAX_CORPUS_CHARS = 60_000;

// ---------- Schema output analisi ----------

const analysisSchema = z.object({
  description: z
    .string()
    .describe(
      "Descrizione accurata del progetto in italiano: cosa fa, per chi, come è costruito, cosa lo caratterizza visivamente e tecnicamente. 2-4 paragrafi."
    ),
  techStack: z
    .array(z.string())
    .describe("Tecnologie, framework e librerie rilevate"),
  designInfo: z
    .object({
      palette: z.array(z.string()).describe("Colori principali (hex se rilevabili)"),
      fonts: z.array(z.string()).describe("Font utilizzati"),
      notes: z.string().describe("Note su stile visivo, animazioni, layout"),
    })
    .describe("Informazioni di design rilevate"),
  components: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Nome del componente, specifico per ciò che fa: 'Hero parallax intro', 'Barra di progresso allo scroll' — mai generico come 'Animation'"
          ),
        kind: z.enum(["layout", "section", "ui", "animation"]),
        description: z
          .string()
          .describe(
            "Cosa fa, come si comporta, cosa lo rende riutilizzabile. Per kind 'animation': descrivi l'effetto osservato (cosa si muove, quando, come) e la tecnica probabile."
          ),
        sourcePath: z
          .string()
          .describe(
            "Path del file, URL della pagina, o — quando il componente corrisponde a una SEZIONE CATTURATA — il suo selettore esatto così com'è scritto dopo 'selettore=' nel blocco, per poter recuperare l'HTML/CSS reale in fase di estrazione"
          ),
      })
    )
    .describe(
      "TUTTI i componenti UI identificati e potenzialmente estraibili: layout (shell, header, footer), section (hero, pricing, feature...), ui (bottoni, selettori, card...) E animation. Per un sito tipico aspettati 8-14 componenti totali: ogni sezione visibile negli screenshot è un candidato section, ogni controllo interattivo un candidato ui. Per le animation: crea un componente SEPARATO per OGNI effetto di scroll/motion distinto osservato negli screenshot in sequenza o nei segnali di animazione (es. parallax dell'hero, elemento sticky che si trasforma, barra/indicatore di progresso, reveal di sezione, marquee, slider) — non accorparli. Le animation si AGGIUNGONO agli altri componenti, non li sostituiscono."
    ),
});

// ---------- Analisi ----------

export async function analyzeSite(siteId: string) {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });

  const docs = await prisma.document.findMany({
    where: { siteId },
    orderBy: { path: "asc" },
  });

  const homepageDoc = docs.find(
    (d) => normalizeUrl(d.path) === normalizeUrl(site.sourceUrl)
  );
  const animationSignals = extractAnimationSignals(homepageDoc?.html);

  let corpus = buildCorpus(docs);
  if (animationSignals) {
    corpus += `\n\n===== SEGNALI DI ANIMAZIONE (HTML renderizzato dell'homepage) =====\n${animationSignals}`;
  }

  const capturedSections = (site.capturedSections as CapturedSectionInfo[] | null) ?? [];
  if (capturedSections.length > 0) {
    corpus += `\n\n===== SEZIONI CATTURATE DAL DOM REALE (Playwright, HTML+CSS effettivi renderizzati) =====`;
    for (const s of capturedSections.slice(0, 12)) {
      corpus += `\n\n--- SEZIONE selettore="${s.selector}" ---\nHTML:\n${s.html.slice(0, 3_000)}\nCSS computato (elementi principali):\n${s.css.slice(0, 1_500)}`;
    }
  }

  const awwwards = site.awwwards as {
    url?: string;
    award?: string | null;
    awardDate?: string | null;
    scores?: Record<string, number | null>;
    palette?: string[];
    tags?: string[];
    credits?: { name: string }[];
    description?: string | null;
    gallery?: { label: string; imageUrl: string }[];
  } | null;

  if (awwwards) {
    corpus += `\n\n===== AWWWARDS (dati curati, fonte autorevole) =====
Premio: ${awwwards.award ?? "n/d"}${awwwards.awardDate ? ` (${awwwards.awardDate})` : ""}
Punteggi giuria: ${JSON.stringify(awwwards.scores ?? {})}
Tag (categorie + tecnologie): ${(awwwards.tags ?? []).join(", ")}
Palette: ${(awwwards.palette ?? []).join(", ")}
Crediti: ${(awwwards.credits ?? []).map((c) => c.name).join(", ")}
${awwwards.description ? `Descrizione: ${awwwards.description}` : ""}`;
  }

  const structured = chatModel.withStructuredOutput(analysisSchema, {
    name: "project_analysis",
  });

  const scrollScreenshots = (site.scrollScreenshots as string[] | null) ?? [];
  const galleryImages = (awwwards?.gallery ?? []).map((g) => g.imageUrl).slice(0, 5);
  const images = [site.screenshot, ...scrollScreenshots, ...galleryImages].filter(
    (u): u is string => !!u
  );

  const userContent =
    images.length > 0
      ? [
          { type: "text" as const, text: `Analizza questo progetto:\n\n${corpus}` },
          ...images.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : `Analizza questo progetto:\n\n${corpus}`;

  const result = await structured.invoke([
    {
      role: "system",
      content:
        "Sei un analista tecnico esperto di frontend. Analizza il contenuto di un sito web o repository e produci un'analisi strutturata, concreta e accurata. Basati solo su ciò che vedi nel corpus, non inventare. Se è presente uno screenshot dell'homepage, usalo come fonte primaria per palette colori e font reali (osservali direttamente nell'immagine); il testo markdown serve solo da contesto aggiuntivo.\n\nSe il corpus contiene un blocco SEZIONI CATTURATE DAL DOM REALE, trattalo come fonte primaria per la struttura: è HTML e CSS computato realmente renderizzati dal browser (Playwright), non testo derivato. Fai corrispondere ogni componente strutturale (layout/section/ui) alla sezione catturata pertinente quando esiste, e usane il selettore come sourcePath.\n\nNel campo components devi elencare DUE famiglie di componenti, entrambe obbligatorie:\n1. Componenti strutturali (kind layout, section, ui): le sezioni e gli elementi riutilizzabili della pagina (hero, header, footer, card, selettori, slider...).\n2. Componenti animation: se sono fornite più immagini in sequenza, rappresentano lo scorrimento della pagina dall'alto verso il basso — usale per individuare effetti legati allo scroll (parallax, elementi sticky che si trasformano, progress/fill bar, reveal, overlay...). Tratta OGNI effetto scroll/motion distinto come un componente SEPARATO con kind \"animation\", nominato in modo specifico (es. 'Hero parallax intro', 'Barra di progresso allo scroll'), usando i SEGNALI DI ANIMAZIONE nel corpus come evidenza tecnica quando disponibili.\n\nUn'analisi che contiene solo animation o solo componenti strutturali è incompleta.\n\nSe il corpus contiene un blocco AWWWARDS, trattalo come fonte autorevole curata da esseri umani: i suoi tag tecnologici hanno priorità per techStack e la sua palette ha priorità per designInfo.palette.",
    },
    {
      role: "user",
      content: userContent,
    },
  ]);

  await prisma.$transaction([
    prisma.site.update({
      where: { id: siteId },
      data: {
        description: result.description,
        techStack: result.techStack,
        designInfo: result.designInfo,
      },
    }),
    // ri-analisi: pulisci i componenti precedenti
    prisma.component.deleteMany({ where: { siteId } }),
    prisma.component.createMany({
      data: result.components.map((c) => ({ siteId, ...c })),
    }),
  ]);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Costruisce il corpus dando priorità ai file più informativi,
 * troncando per stare nel budget.
 */
function buildCorpus(
  docs: { path: string; kind: string; content: string }[]
): string {
  const priority = (d: { path: string }) => {
    const p = d.path.toLowerCase();
    if (p.endsWith("readme.md")) return 0;
    if (p.endsWith("package.json")) return 1;
    if (p.includes("layout") || p.includes("page")) return 2;
    if (p.includes("component")) return 3;
    return 4;
  };

  const sorted = [...docs].sort((a, b) => priority(a) - priority(b));

  let corpus = "";
  for (const doc of sorted) {
    const header = `\n\n===== ${doc.kind.toUpperCase()}: ${doc.path} =====\n`;
    const remaining = MAX_CORPUS_CHARS - corpus.length - header.length;
    if (remaining <= 200) break;
    corpus += header + doc.content.slice(0, remaining);
  }
  return corpus;
}

// ---------- Embeddings → Qdrant ----------

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 150,
});

export async function embedSite(siteId: string) {
  await ensureCollection();

  // ri-embedding: rimuovi i vecchi point del progetto
  await qdrant.delete(COLLECTION, {
    filter: {
      must: [{ key: "siteId", match: { value: siteId } }],
    },
  });

  const docs = await prisma.document.findMany({ where: { siteId } });

  for (const doc of docs) {
    const chunks = await splitter.splitText(doc.content);
    if (chunks.length === 0) continue;

    const vectors = await embeddings.embedDocuments(chunks);

    const points = chunks.map((text, i) => ({
      id: randomUUID(),
      vector: vectors[i],
      payload: {
        siteId,
        documentId: doc.id,
        path: doc.path,
        kind: doc.kind,
        chunkIndex: i,
        text,
      },
    }));

    await qdrant.upsert(COLLECTION, { points });

    await prisma.document.update({
      where: { id: doc.id },
      data: { qdrantIds: points.map((p) => p.id) },
    });
  }
}
