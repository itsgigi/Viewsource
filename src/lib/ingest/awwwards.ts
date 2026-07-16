import { z } from "zod";
import { Firecrawl } from "firecrawl";
import { ChatOpenAI } from "@langchain/openai";

// Modulo fail-soft: nessuna funzione deve mai bloccare l'ingestion.
// Ogni errore degrada a null / array vuoto, come per gli screenshot.

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

export interface AwwwardsData {
  url: string;
  title: string;
  award: string | null;
  awardDate: string | null;
  scores: {
    design: number | null;
    usability: number | null;
    creativity: number | null;
    content: number | null;
    overall: number | null;
  };
  devScores: { name: string; score: number }[] | null;
  palette: string[];
  tags: string[];
  credits: { name: string; url: string | null }[];
  description: string | null;
  gallery: { label: string; imageUrl: string }[];
}

// Nota: OpenAI structured output in modalità strict non supporta .optional()
// né z.record — tutti i campi facoltativi devono essere .nullable().
const awwwardsSchema = z.object({
  title: z.string().describe("Nome del sito come appare sulla pagina Awwwards"),
  award: z
    .string()
    .nullable()
    .describe("Premio principale, es. 'Site of the Day', 'Honorable Mention', 'Developer Award'"),
  awardDate: z.string().nullable().describe("Data del premio se indicata, es. 'Jul 14, 2026'"),
  scores: z
    .object({
      design: z.number().nullable(),
      usability: z.number().nullable(),
      creativity: z.number().nullable(),
      content: z.number().nullable(),
      overall: z.number().nullable(),
    })
    .describe("Punteggi della giuria (0-10), null se non presenti"),
  devScores: z
    .array(z.object({ name: z.string(), score: z.number() }))
    .nullable()
    .describe("Eventuali punteggi Developer Award per categoria (semantics, accessibility, wpo...)"),
  tags: z
    .array(z.string())
    .describe("Tutti i tag: categorie (Architecture, Luxury...) e tecnologie (Next.js, Sanity...)"),
  credits: z
    .array(z.object({ name: z.string(), url: z.string().nullable() }))
    .describe("Crediti: designer, agenzie, sviluppatori con eventuale URL del profilo Awwwards"),
  description: z.string().nullable().describe("Descrizione/claim del sito riportata sulla pagina"),
});

/**
 * Orchestratore: URL manuale (se valido) vince sulla discovery automatica.
 */
export async function fetchAwwwardsData(
  siteUrl: string,
  manualUrl?: string | null
): Promise<AwwwardsData | null> {
  try {
    if (manualUrl && /awwwards\.com\/(sites|inspiration)\//.test(manualUrl)) {
      return await scrapeAwwwardsPage(manualUrl);
    }
    const found = await findAwwwardsPage(siteUrl);
    return found;
  } catch {
    return null;
  }
}

/**
 * Cerca la pagina Awwwards del sito via web search ristretta ad
 * awwwards.com (la ricerca testuale interna di Awwwards fallisce sui
 * nomi di dominio senza spazi, es. "houseofhoney"). La candidata è
 * accettata solo se il suo link "Visit site" punta allo stesso host.
 */
async function findAwwwardsPage(siteUrl: string): Promise<AwwwardsData | null> {
  const host = hostOf(siteUrl);
  if (!host) return null;

  const search = await firecrawl
    .search(`${host.split(".")[0]} site`, {
      includeDomains: ["awwwards.com"],
      limit: 5,
    })
    .catch(() => null);

  const results = (search?.web ?? []) as Array<{ url?: string }>;
  const candidates = [
    ...new Set(
      results
        .map((r) => r.url ?? "")
        .filter((u) => /awwwards\.com\/sites\/[a-z0-9-]+\/?$/.test(u))
    ),
  ].slice(0, 3);

  for (const candidate of candidates) {
    const data = await scrapeAwwwardsPage(candidate.replace(/\/$/, ""));
    if (data && data.externalHost === host) {
      return data;
    }
  }
  return null;
}

// Risultato interno con host esterno per la verifica del match
type ScrapedAwwwards = AwwwardsData & { externalHost: string | null };

/**
 * Scrape + parse di una pagina awwwards.com/sites/<slug>.
 * Markdown → LLM structured output per i campi testuali;
 * HTML renderizzato → regex per palette e immagini gallery (lazy-loaded).
 */
async function scrapeAwwwardsPage(url: string): Promise<ScrapedAwwwards | null> {
  const page = await firecrawl
    .scrape(url, { formats: ["markdown", "html"] })
    .catch(() => null);
  if (!page?.markdown) return null;

  const html = page.html ?? "";

  const structured = chatModel.withStructuredOutput(awwwardsSchema, {
    name: "awwwards_page",
  });

  const parsed = await structured
    .invoke([
      {
        role: "system",
        content:
          "Estrai i dati strutturati da questa pagina Awwwards di un sito web. Riporta solo ciò che è presente nella pagina, non inventare. I tag includono sia categorie sia tecnologie.",
      },
      { role: "user", content: page.markdown.slice(0, 20_000) },
    ])
    .catch(() => null);
  if (!parsed) return null;

  return {
    url,
    ...parsed,
    palette: extractPalette(html),
    gallery: extractGallery(html),
    externalHost: extractExternalHost(html, url),
  };
}

/** Palette: hex linkati come /websites/%23HEX/ */
function extractPalette(html: string): string[] {
  const hexes = [...html.matchAll(/\/websites\/%23([0-9A-Fa-f]{6})/g)].map(
    (m) => `#${m[1].toUpperCase()}`
  );
  return [...new Set(hexes)].slice(0, 8);
}

/**
 * Gallery: anchor /inspiration/<part>-<slug> con dentro (o vicino) un <img>
 * hydrated da assets.awwwards.com. Label derivata dallo slug della parte.
 */
function extractGallery(html: string): { label: string; imageUrl: string }[] {
  const out: { label: string; imageUrl: string }[] = [];
  const seen = new Set<string>();

  const anchorRe = /<a[^>]+href="(?:https:\/\/www\.awwwards\.com)?\/inspiration\/([a-z0-9-]+)"[^>]*>([\s\S]{0,2000}?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    const slug = m[1];
    const inner = m[2];
    const img = inner.match(/https:\/\/assets\.awwwards\.com\/[^"' )]+\.(?:jpg|jpeg|png|webp)/i);
    if (!img) continue;
    if (seen.has(img[0])) continue;
    seen.add(img[0]);

    // "contact-house-of-honey-1" → "contact"; via lo slug del sito in coda
    const label = slug.split("-").slice(0, 2).join(" ");
    out.push({ label, imageUrl: img[0] });
    if (out.length >= 8) break;
  }
  return out;
}

/** Host del link "Visit site" per verificare il match con il progetto. */
function extractExternalHost(html: string, awwwardsUrl: string): string | null {
  const selfHost = "awwwards.com";
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(?:[\s\S]{0,200}?)(?:visit site|visit website)/gi;
  for (const m of html.matchAll(re)) {
    const h = hostOf(m[1]);
    if (h && !h.includes(selfHost)) return h;
  }
  // fallback: primo link esterno "visit" style con classe bt-visit (markup awwwards)
  const btVisit = html.match(/class="[^"]*bt-visit[^"]*"[^>]*href="(https?:\/\/[^"]+)"|href="(https?:\/\/[^"]+)"[^>]*class="[^"]*bt-visit[^"]*"/);
  const url = btVisit?.[1] ?? btVisit?.[2];
  if (url) {
    const h = hostOf(url);
    if (h && !h.includes(selfHost)) return h;
  }
  void awwwardsUrl;
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
