import { Firecrawl } from "firecrawl";

// npm i firecrawl  (il vecchio @mendable/firecrawl-js è ora un wrapper di questo)

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });

export interface RawDoc {
  path: string; // URL della pagina o path del file
  kind: "page" | "file";
  content: string;
}

/**
 * Crawla un sito e restituisce una pagina markdown per ogni URL trovato.
 * `limit` tiene sotto controllo i crediti Firecrawl: 30 pagine bastano
 * per la maggior parte dei siti vetrina/portfolio.
 */
export async function ingestWebsite(
  url: string,
  { limit = 30 }: { limit?: number } = {}
): Promise<RawDoc[]> {
  const result = await firecrawl.crawl(url, {
    limit,
    scrapeOptions: { formats: ["markdown"], onlyMainContent: false },
    pollInterval: 3,
  });

  const pages = result.data ?? [];

  return pages
    .filter((p) => p.markdown && p.markdown.trim().length > 0)
    .map((p) => ({
      path: p.metadata?.sourceURL ?? url,
      kind: "page" as const,
      content: p.markdown!,
    }));
}

/**
 * Scatta uno screenshot full-page dell'homepage. Non blocca l'ingestion
 * se fallisce: torna semplicemente null.
 */
export async function captureHomepageScreenshot(url: string): Promise<string | null> {
  try {
    const result = await firecrawl.scrape(url, {
      formats: [{ type: "screenshot", fullPage: true }],
    });
    return result.screenshot ?? null;
  } catch {
    return null;
  }
}

export interface ScrollSequence {
  screenshots: string[]; // in ordine, dall'alto verso il basso
  html: string | null; // HTML renderizzato (post-JS) dell'homepage
}

/**
 * Scatta una sequenza di screenshot scendendo lungo la pagina (per
 * catturare effetti legati allo scroll: parallax, reveal, progress bar...)
 * e cattura anche l'HTML renderizzato nella stessa chiamata.
 * Non blocca l'ingestion se fallisce: torna una sequenza vuota.
 */
export async function captureScrollSequence(
  url: string,
  steps = 7
): Promise<ScrollSequence> {
  try {
    type ScrollActions = Array<
      | { type: "screenshot" }
      | { type: "wait"; milliseconds: number }
      | { type: "executeJavascript"; script: string }
    >;

    // L'azione "scroll" nativa di Firecrawl scorre troppo poco per pagine
    // scrolly lunghe, e i siti con scroll-hijacking ignorano window.scrollBy
    // e spesso anche gli eventi wheel sintetici (isTrusted: false).
    // Strategia per caso:
    // - Locomotive Scroll renderizza una scrollbar propria (.c-scrollbar_thumb)
    //   gestita da listener mouse in JS: simuliamo un drag del thumb, che
    //   funziona anche con eventi sintetici. Il thumb viene trascinato di
    //   1/8 di viewport per step, coprendo l'intera pagina in ~7 step.
    // - Altrimenti scrollBy nativo (copre siti normali e lenis, che mantiene
    //   lo scroll nativo) + raffica di wheel distanziati via setInterval,
    //   che continua a girare durante la successiva azione "wait".
    // IIFE: ogni executeJavascript gira nello stesso scope globale della
    // pagina, senza IIFE le const verrebbero ridichiarate al secondo step.
    const scrollScript = `(() => {
      const thumb = document.querySelector('.c-scrollbar_thumb');
      if (thumb) {
        const r = thumb.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2);
        const y0 = Math.round(r.y + r.height / 2);
        const dy = Math.max(40, Math.round(innerHeight / 8));
        const ev = (type, cy) =>
          new MouseEvent(type, { clientX: x, clientY: cy, bubbles: true, cancelable: true });
        thumb.dispatchEvent(ev('mousedown', y0));
        let i = 0;
        const id = setInterval(() => {
          i++;
          const cy = y0 + Math.round((dy * i) / 10);
          window.dispatchEvent(ev('mousemove', cy));
          document.dispatchEvent(ev('mousemove', cy));
          if (i >= 10) {
            clearInterval(id);
            window.dispatchEvent(ev('mouseup', y0 + dy));
            document.dispatchEvent(ev('mouseup', y0 + dy));
          }
        }, 50);
      } else {
        window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
        const target = document.elementFromPoint(innerWidth / 2, innerHeight / 2) ?? document.body;
        let n = 0;
        const id = setInterval(() => {
          target.dispatchEvent(new WheelEvent('wheel', { deltaY: innerHeight / 12, bubbles: true, cancelable: true }));
          if (++n >= 25) clearInterval(id);
        }, 40);
      }
    })()`;

    const actions: ScrollActions = [{ type: "screenshot" }];
    for (let i = 1; i < steps; i++) {
      actions.push({ type: "executeJavascript", script: scrollScript });
      actions.push({ type: "wait", milliseconds: 1800 });
      actions.push({ type: "screenshot" });
    }

    const result = await firecrawl.scrape(url, {
      formats: ["html"],
      actions,
      timeout: 120_000, // molte azioni in sequenza: il default non basta
    });

    // La SDK non tipizza `actions` sul risultato di scrape() in modo utile
    // (default generico `never`), ma a runtime il campo è popolato.
    const actionsResult = result.actions as { screenshots?: string[] } | undefined;

    return {
      screenshots: actionsResult?.screenshots ?? [],
      html: result.html ?? null,
    };
  } catch {
    return { screenshots: [], html: null };
  }
}
