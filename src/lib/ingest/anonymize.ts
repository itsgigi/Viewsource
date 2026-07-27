import * as cheerio from "cheerio";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Baseline copyright-risk mitigation for the clone showcase (Phase D):
 * anonymizes the captured HTML (Phase A) by replacing brand, logos, and
 * identifying copy with neutral placeholders, keeping the DOM structure,
 * CSS classes, layout, palette, and ALL other assets intact (no generative
 * rewriting of the HTML: an LLM that rewrites entire pages easily
 * truncates/alters them; here we manipulate the DOM surgically with cheerio).
 *
 * THIS IS MITIGATION, NOT IMMUNITY: best-effort, it can miss implicit
 * references. The caller must ALWAYS show an attribution link to the
 * original next to the clone.
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
 * Generates (or regenerates) the anonymized version of the captured HTML
 * for a site and persists it to Site.clonePreview. Lazy: called only on
 * demand (first request to /sites/[slug]/preview), not during ingestion.
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
      "No HTML captured for this site: an ingestion with a real capture (Phase A) is needed first."
    );
  }

  const $ = cheerio.load(rawHtml);

  // 1. Security, above everything else: strip <script> and inline event
  // handlers. This is the primary defense for the sandboxed iframe.
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

  // 2. <base href>: WITHOUT it, the original site's relative CSS/font/image
  // paths won't resolve inside the srcDoc iframe (origin "null") and the
  // page shows up completely unstyled — this is the clone's main visual
  // fidelity bug, not a minor detail.
  const origin = safeOrigin(site.sourceUrl);
  if (origin) {
    $("head").prepend(`<base href="${origin}/">`);
  }

  // 3. Brand terms to anonymize in visible text/attributes.
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

  // 4. Logos → neutral placeholder. The rest of the assets (product
  // photos, illustrations...) stay intact: replacing them all with generic
  // placeholders would degrade visual fidelity without a real mitigation
  // benefit (they aren't brand-identifying).
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
    .describe("Brand-identifying terms to anonymize: product names, distinctive slogans, proper names mentioned"),
});

/**
 * Small, targeted LLM call (name+description only, not the whole HTML) to
 * infer brand terms beyond the site's name — e.g. recurring product names
 * in the copy. Cost and truncation risk near zero compared to having an
 * LLM rewrite the entire page.
 */
async function brandTerms(site: { name: string; description: string | null }): Promise<string[]> {
  const structured = chatModel.withStructuredOutput(termsSchema, { name: "brand_terms" });
  const result = await structured.invoke([
    {
      role: "system",
      content:
        "List (max 10) the brand/product-identifying terms to anonymize in a public demonstrative clone: company name, recurring product names, distinctive slogans. Do NOT include generic industry words (e.g. 'coffee', 'car', 'sustainability').",
    },
    { role: "user", content: `Site name: ${site.name}\nDescription: ${site.description ?? "not available"}` },
  ]);
  return [site.name, ...result.terms];
}
