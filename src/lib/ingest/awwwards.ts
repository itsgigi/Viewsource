import { z } from "zod";
import { Firecrawl } from "firecrawl";
import { ChatOpenAI } from "@langchain/openai";

// Fail-soft module: no function should ever block ingestion.
// Every error degrades to null / empty array, same as for screenshots.

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

// Note: OpenAI structured output in strict mode supports neither .optional()
// nor z.record — all optional fields must be .nullable().
const awwwardsSchema = z.object({
  title: z.string().describe("Site name as it appears on the Awwwards page"),
  award: z
    .string()
    .nullable()
    .describe("Main award, e.g. 'Site of the Day', 'Honorable Mention', 'Developer Award'"),
  awardDate: z.string().nullable().describe("Award date if shown, e.g. 'Jul 14, 2026'"),
  scores: z
    .object({
      design: z.number().nullable(),
      usability: z.number().nullable(),
      creativity: z.number().nullable(),
      content: z.number().nullable(),
      overall: z.number().nullable(),
    })
    .describe("Jury scores (0-10), null if not present"),
  devScores: z
    .array(z.object({ name: z.string(), score: z.number() }))
    .nullable()
    .describe("Any Developer Award scores by category (semantics, accessibility, wpo...)"),
  tags: z
    .array(z.string())
    .describe("All tags: categories (Architecture, Luxury...) and technologies (Next.js, Sanity...)"),
  credits: z
    .array(z.object({ name: z.string(), url: z.string().nullable() }))
    .describe("Credits: designers, agencies, developers with an Awwwards profile URL if any"),
  description: z.string().nullable().describe("Site description/claim reported on the page"),
});

/**
 * Orchestrator: a manual URL (if valid) wins over automatic discovery.
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
 * Looks up the site's Awwwards page via web search restricted to
 * awwwards.com (Awwwards' internal text search fails on domain names
 * without spaces, e.g. "houseofhoney"). A candidate is accepted only if
 * its "Visit site" link points to the same host.
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

// Internal result with the external host, for match verification
type ScrapedAwwwards = AwwwardsData & { externalHost: string | null };

/**
 * Scrape + parse of an awwwards.com/sites/<slug> page.
 * Markdown → LLM structured output for the textual fields;
 * rendered HTML → regex for palette and gallery images (lazy-loaded).
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
          "Extract the structured data from this Awwwards page for a website. Report only what's present on the page, don't make things up. Tags include both categories and technologies.",
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

/** Palette: hex values linked as /websites/%23HEX/ */
function extractPalette(html: string): string[] {
  const hexes = [...html.matchAll(/\/websites\/%23([0-9A-Fa-f]{6})/g)].map(
    (m) => `#${m[1].toUpperCase()}`
  );
  return [...new Set(hexes)].slice(0, 8);
}

/**
 * Gallery: /inspiration/<part>-<slug> anchors with an <img> inside (or
 * nearby) hydrated from assets.awwwards.com. Label derived from the part's slug.
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

    // "contact-house-of-honey-1" → "contact"; strips the site's slug at the end
    const label = slug.split("-").slice(0, 2).join(" ");
    out.push({ label, imageUrl: img[0] });
    if (out.length >= 8) break;
  }
  return out;
}

/** Host of the "Visit site" link, to verify the match with the project. */
function extractExternalHost(html: string, awwwardsUrl: string): string | null {
  const selfHost = "awwwards.com";
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(?:[\s\S]{0,200}?)(?:visit site|visit website)/gi;
  for (const m of html.matchAll(re)) {
    const h = hostOf(m[1]);
    if (h && !h.includes(selfHost)) return h;
  }
  // fallback: first external "visit"-style link with class bt-visit (awwwards markup)
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
