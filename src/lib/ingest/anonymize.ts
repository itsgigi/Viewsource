import * as cheerio from "cheerio";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Mitigazione base del rischio copyright per il clone showcase (Fase D):
 * anonimizza l'HTML catturato (Fase A) sostituendo brand, loghi e copy
 * identificativo con placeholder neutri, mantenendo intatti struttura DOM,
 * classi CSS, layout, palette e TUTTI gli altri asset (niente riscrittura
 * generativa dell'HTML: un LLM che riscrive pagine intere le tronca/altera
 * facilmente, qui manipoliamo il DOM chirurgicamente con cheerio).
 *
 * QUESTO È MITIGAZIONE, NON IMMUNITÀ: best-effort, può mancare riferimenti
 * impliciti. Il chiamante deve SEMPRE mostrare un link di attribuzione
 * all'originale accanto al clone.
 */

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0,
});

export interface ClonePreview {
  html: string;
  generatedAt: string;
}

const LOGO_SELECTOR = [
  "img[src*='logo' i]",
  "img[alt*='logo' i]",
  "img[class*='logo' i]",
  "img[id*='logo' i]",
  "svg[class*='logo' i]",
  "svg[id*='logo' i]",
].join(", ");

const PLACEHOLDER = "Studio";

/**
 * Genera (o rigenera) la versione anonimizzata dell'HTML catturato per un
 * sito e la persiste su Site.clonePreview. Lazy: chiamata solo al bisogno
 * (prima richiesta di /sites/[slug]/preview), non durante l'ingestion.
 */
export async function anonymizeCapture(siteId: string): Promise<ClonePreview> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });

  const homepageDoc = await prisma.document.findFirst({
    where: { siteId, html: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  const rawHtml = homepageDoc?.html;
  if (!rawHtml) {
    throw new Error(
      "Nessun HTML catturato per questo sito: serve prima una ingestion con cattura reale (Fase A)."
    );
  }

  const $ = cheerio.load(rawHtml);

  // 1. Sicurezza, a prescindere da tutto il resto: via <script> ed event
  // handler inline. È la difesa primaria per l'iframe sandboxed.
  $("script").remove();
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const attr of Object.keys(el.attribs)) {
      if (attr.toLowerCase().startsWith("on")) $(el).removeAttr(attr);
      if (attr.toLowerCase() === "href" && /^javascript:/i.test(el.attribs[attr])) {
        $(el).removeAttr(attr);
      }
    }
  });

  // 2. <base href>: SENZA, i path relativi di CSS/font/immagini del sito
  // originale non risolvono dentro l'iframe srcDoc (origin "null") e la
  // pagina appare completamente sgraffata — questo è il bug principale
  // di fedeltà visiva del clone, non un dettaglio.
  const origin = safeOrigin(site.sourceUrl);
  if (origin) {
    $("head").prepend(`<base href="${origin}/">`);
  }

  // 3. Termini di brand da anonimizzare nel testo/attributi visibili.
  const terms = await brandTerms(site).catch(() => [site.name]);
  const pattern = buildPattern(terms);

  if (pattern) {
    $("*")
      .contents()
      .each((_, node) => {
        if (node.type === "text") node.data = node.data.replace(pattern, PLACEHOLDER);
      });
    for (const attr of ["title", "alt", "aria-label", "placeholder", "content"]) {
      $(`[${attr}]`).each((_, el) => {
        const val = $(el).attr(attr);
        if (val) $(el).attr(attr, val.replace(pattern, PLACEHOLDER));
      });
    }
  }

  // 4. Loghi → placeholder neutro. Il resto degli asset (foto prodotto,
  // illustrazioni...) resta intatto: sostituirli tutti con placeholder
  // generici degraderebbe la fedeltà visiva senza un reale beneficio di
  // mitigazione (non sono identificativi del brand).
  $(LOGO_SELECTOR).each((_, el) => {
    if (el.type !== "tag") return;
    const $el = $(el);
    if (el.tagName === "img") {
      const w = $el.attr("width") || "160";
      const h = $el.attr("height") || "40";
      $el.attr("src", `https://placehold.co/${w}x${h}?text=Logo`);
      $el.removeAttr("srcset");
      $el.attr("alt", "Logo");
    } else {
      $el.remove();
    }
  });

  const html = $.html();
  const preview: ClonePreview = { html, generatedAt: new Date().toISOString() };

  await prisma.site.update({
    where: { id: siteId },
    data: { clonePreview: preview as unknown as Prisma.InputJsonValue },
  });

  return preview;
}

// ---------- Helpers ----------

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(terms: string[]): RegExp | null {
  const escaped = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].map(escapeRegex);
  return escaped.length > 0 ? new RegExp(`\\b(${escaped.join("|")})\\b`, "gi") : null;
}

const termsSchema = z.object({
  terms: z
    .array(z.string())
    .max(10)
    .describe("Termini identificativi del brand da anonimizzare: nomi prodotto, slogan distintivi, nomi propri citati"),
});

/**
 * Chiamata LLM piccola e mirata (solo nome+descrizione, non l'HTML intero)
 * per dedurre termini di brand oltre al nome del sito — es. nomi prodotto
 * ricorrenti nel copy. Costo e rischio di troncamento vicini a zero rispetto
 * a far riscrivere l'intera pagina a un LLM.
 */
async function brandTerms(site: { name: string; description: string | null }): Promise<string[]> {
  const structured = chatModel.withStructuredOutput(termsSchema, { name: "brand_terms" });
  const result = await structured.invoke([
    {
      role: "system",
      content:
        "Elenca (max 10) i termini identificativi di un brand/prodotto da anonimizzare in un clone dimostrativo pubblico: nome azienda, nomi prodotto ricorrenti, slogan distintivi. NON includere parole generiche di settore (es. 'caffè', 'macchina', 'sostenibilità').",
    },
    { role: "user", content: `Nome sito: ${site.name}\nDescrizione: ${site.description ?? "non disponibile"}` },
  ]);
  return [site.name, ...result.terms];
}
