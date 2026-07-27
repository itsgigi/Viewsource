import { put } from "@vercel/blob";
import sharp from "sharp";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * Cattura del DOM/CSS reali renderizzati con Playwright.
 *
 * IMPORTANTE: gira SOLO in locale/admin. Non va MAI invocata su Vercel
 * serverless (niente browser binaries lì) — il chiamante (src/lib/ingest/index.ts)
 * verifica `process.env.VERCEL` prima di chiamare `captureSite`. "playwright"
 * è importato dinamicamente qui sotto così il bundler non lo traccia mai nel
 * bundle delle funzioni serverless. `sharp`/`pngjs`/`pixelmatch` sono invece
 * import statici: sono librerie pure Node (sharp con binari prebuilt) già
 * usate allo stesso modo in src/lib/render/diff.ts, supportate su Vercel.
 */

export interface CapturedSection {
  selector: string;
  tag: string;
  html: string;
  css: string;
  screenshot: string | null;
}

export interface CapturedAsset {
  url: string;
  type: "image" | "font" | "other";
}

export interface CaptureResult {
  html: string;
  screenshot: string | null;
  sections: CapturedSection[];
  assets: CapturedAsset[];
}

const MAX_SECTIONS = 15;
const MAX_SECTION_HTML = 8_000;
const MAX_SECTION_CSS = 3_000;

// Proprietà CSS rilevanti per ricostruire fedelmente struttura/stile senza
// portarsi dietro l'intero computed style (centinaia di proprietà, per lo
// più irrilevanti).
const CSS_PROPS = [
  "display", "position", "top", "left", "width", "height",
  "margin", "padding", "gap",
  "background", "background-color", "background-image",
  "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "flex-direction", "align-items", "justify-content",
  "grid-template-columns", "grid-template-rows",
  "border", "border-radius", "box-shadow",
  "opacity", "transform", "transition",
];

/**
 * Apre `url` con Playwright, aspetta il render completo, e cattura HTML,
 * screenshot full-page, sezioni principali (HTML + CSS computato + screenshot
 * per sezione) e la lista degli asset (immagini, font) referenziati.
 *
 * Limite noto: JS/animazioni (GSAP, WebGL, Three.js) non sono catturati come
 * sorgente — solo la struttura statica renderizzata in quel momento.
 */
export async function captureSite(url: string): Promise<CaptureResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2_500); // lascia respirare animazioni iniziali

    const html = await page.content();

    const fullBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
    const screenshot = fullBuffer
      ? await uploadImage(fullBuffer, `${slugifyUrl(url)}-full.png`)
      : null;

    const rawSections = await page.evaluate(captureSectionsInPageFlat, {
      cssProps: CSS_PROPS,
      maxSections: MAX_SECTIONS,
    });

    const sections: CapturedSection[] = [];
    for (const s of rawSections) {
      const shot = await page
        .locator(`[data-capture-marker="${s.marker}"]`)
        .first()
        .screenshot()
        .catch(() => null);
      sections.push({
        selector: s.selector,
        tag: s.tag,
        html: s.html.slice(0, MAX_SECTION_HTML),
        css: s.css.slice(0, MAX_SECTION_CSS),
        screenshot: shot ? await uploadImage(shot, `${slugifyUrl(url)}-${s.marker}.png`) : null,
      });
    }

    const assets = await page.evaluate(collectAssetsInPage);

    return { html, screenshot, sections, assets };
  } finally {
    await browser.close();
  }
}

// Larghezza/altezza viewport usate sia in questa cattura sia dal mini-renderer
// (src/lib/render), così screenshot originale e ricostruito sono confrontabili
// a parità di larghezza fin dalla cattura.
export const SECTION_VIEWPORT_WIDTH = 1440;
export const SECTION_VIEWPORT_HEIGHT = 900;

export interface MediaAsset {
  kind: "video" | "image" | "bg-image" | "canvas";
  src?: string;
  poster?: string;
  srcset?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  playsinline?: boolean;
  width?: number;
  height?: number;
  objectFit?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  /** Posizione relativa al top/left della sezione (non della pagina) — usata
   * per mascherare la regione nel pixelmatch dei `<video>` (src/lib/render/diff.ts). */
  top?: number;
  left?: number;
}

export interface FilmstripFrame {
  url: string;
  scrollY: number;
}

export interface MotionHint {
  fromFrame: number;
  toFrame: number;
  /** Coordinate pagina-assolute (verticali soltanto: le sezioni sono full-width). */
  pageTop: number;
  pageBottom: number;
  changedRatio: number;
}

export interface GroundTruthSection {
  selector: string;
  tag: string;
  html: string;
  css: string;
  screenshot: string;
  boundsTop: number;
  boundsHeight: number;
  mediaAssets: MediaAsset[];
  filmstrip: FilmstripFrame[];
  motionHints: MotionHint[];
  detectedLibs: string[];
}

export interface CaptureSiteSectionsResult {
  sections: GroundTruthSection[];
  /** Screenshot full-page condiviso da cui ogni sezione è ritagliata — serve
   * al boundary editor HITL per ri-ritagliare dopo merge/split. Null solo se
   * il fullPage screenshot fallisce anche col fallback. */
  fullPageScreenshot: string | null;
}

const FILMSTRIP_STEPS = 9; // 8-10 frame per spec
const FILMSTRIP_SETTLE_MS = 400;

export interface CaptureProgress {
  stage: "loading" | "filmstriping" | "scrolling" | "detecting" | "shooting";
  /** Presente solo durante "shooting": quante sezioni catturate finora / totale rilevato. */
  found?: number;
  total?: number;
}

/**
 * Cattura le sezioni di `url` come ground truth immutabile per il meccanismo
 * di ricostruzione per-sezione (Section model).
 *
 * Ordine dei passaggi (importante, non riordinabile):
 * 1. Load pristino.
 * 2. Filmstrip a scroll progressivo — PRIMA di qualunque freeze, per
 *    osservare animazioni scroll-driven vive (reveal, parallasse, swap).
 * 3. Scroll fino in fondo e ritorno + freeze CSS (comportamento esistente):
 *    porta gli elementi allo stato "assestato" per la ground truth statica.
 * 4. Section detection ricorsiva + UN screenshot full-page (necessario per
 *    poter ri-ritagliare le sezioni dopo merge/split nel boundary editor) +
 *    crop per-sezione via sharp + inventario media per-sezione.
 */
export async function captureSiteSections(
  url: string,
  onProgress?: (progress: CaptureProgress) => void
): Promise<CaptureSiteSectionsResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  try {
    onProgress?.({ stage: "loading" });
    const page = await browser.newPage({
      viewport: { width: SECTION_VIEWPORT_WIDTH, height: SECTION_VIEWPORT_HEIGHT },
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1_500);

    onProgress?.({ stage: "filmstriping" });
    const globalFilmstrip = await captureFilmstrip(page, url);

    onProgress?.({ stage: "scrolling" });
    await page.evaluate(autoScrollInPage);
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
    await page.waitForTimeout(300);

    const detectedLibs = await page.evaluate(detectAnimationLibsInPage);

    onProgress?.({ stage: "detecting" });
    const rawSections = await page.evaluate(captureSectionsInPage, {
      cssProps: CSS_PROPS,
      maxSections: MAX_SECTIONS,
    });

    onProgress?.({ stage: "shooting", found: 0, total: rawSections.length });

    // Sticky/fixed renderizzano "sganciati" in uno screenshot fullPage
    // (difetto noto Playwright/Puppeteer): neutralizzali temporaneamente,
    // scoped ai soli elementi coinvolti, e ripristinali subito dopo.
    const neutralizedMarkers = await page.evaluate(neutralizeStickyForFullPageShot);
    let fullPageBuffer: Buffer | null = null;
    try {
      fullPageBuffer = await page.screenshot({ fullPage: true, timeout: 30_000 });
    } catch {
      fullPageBuffer = null; // pagina patologicamente lunga o altro errore: fallback sotto
    }
    await page.evaluate(restoreStickyAfterFullPageShot, neutralizedMarkers);

    const fullPageScreenshot = fullPageBuffer
      ? await uploadImage(fullPageBuffer, `${slugifyUrl(url)}-fullpage.png`)
      : null;

    const sections: GroundTruthSection[] = [];
    for (const s of rawSections) {
      onProgress?.({ stage: "shooting", found: sections.length, total: rawSections.length });

      let shotBuffer: Buffer | null = null;
      if (fullPageBuffer) {
        try {
          shotBuffer = await sharp(fullPageBuffer)
            .extract({
              left: 0,
              top: Math.max(0, s.top),
              width: SECTION_VIEWPORT_WIDTH,
              height: Math.max(1, s.height),
            })
            .png()
            .toBuffer();
        } catch {
          shotBuffer = null;
        }
      }
      if (!shotBuffer) {
        // Fallback: fullPage screenshot fallito/mancante — screenshot per-elemento.
        shotBuffer = await page
          .locator(`[data-capture-marker="${s.marker}"]`)
          .first()
          .screenshot()
          .catch(() => null);
      }
      if (!shotBuffer) continue; // senza screenshot non c'è ground truth: la sezione va scartata

      const mediaAssets = await page.evaluate(collectMediaInPage, s.marker);

      sections.push({
        selector: s.selector,
        tag: s.tag,
        html: s.html.slice(0, MAX_SECTION_HTML),
        css: s.css.slice(0, MAX_SECTION_CSS),
        screenshot: await uploadImage(shotBuffer, `${slugifyUrl(url)}-${s.marker}.png`),
        boundsTop: s.top,
        boundsHeight: s.height,
        mediaAssets,
        filmstrip: [],
        motionHints: [],
        detectedLibs,
      });
    }

    // Filmstrip + motionHints per-sezione, ritagliati dai frame globali usando
    // scrollY per allineare coordinate pagina-assolute a frame viewport-relative.
    const globalMotionHints = await computeMotionHints(globalFilmstrip);
    for (const section of sections) {
      section.filmstrip = await cropFilmstripForSection(globalFilmstrip, section, url);
      section.motionHints = globalMotionHints.filter((hint) =>
        rangesOverlap(hint.pageTop, hint.pageBottom, section.boundsTop, section.boundsTop + section.boundsHeight)
      );
    }

    onProgress?.({ stage: "shooting", found: sections.length, total: rawSections.length });
    return { sections, fullPageScreenshot };
  } finally {
    await browser.close();
  }
}

// Eseguita nel contesto della pagina: scrolla a step fino in fondo (fa
// scattare le reveal animation legate a IntersectionObserver/scroll), poi
// torna in cima prima del freeze CSS.
function autoScrollInPage() {
  return new Promise<void>((resolve) => {
    let total = 0;
    const step = window.innerHeight;
    const timer = setInterval(() => {
      window.scrollBy(0, step);
      total += step;
      if (total >= document.body.scrollHeight) {
        clearInterval(timer);
        window.scrollTo(0, 0);
        setTimeout(resolve, 300);
      }
    }, 200);
  });
}

// ---------- Filmstrip (Node-side: orchestrazione scroll+screenshot+diff) ----------

interface FilmstripFrameInternal {
  url: string;
  scrollY: number;
  buffer: Buffer;
}

/**
 * Cattura N screenshot a scroll progressivo, dallo scroll 0 fino in fondo
 * alla pagina, PRIMA di qualunque freeze — deve osservare animazioni vive.
 * Limite noto: media lazy-loaded potrebbero non aver fatto in tempo a
 * caricare nei frame iniziali; accettato, la filmstrip alimenta solo la
 * motionDescription (non è ground truth pixel-perfect).
 */
async function captureFilmstrip(
  page: import("playwright").Page,
  url: string
): Promise<FilmstripFrameInternal[]> {
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const maxScroll = Math.max(0, scrollHeight - SECTION_VIEWPORT_HEIGHT);
  const frames: FilmstripFrameInternal[] = [];

  for (let i = 0; i < FILMSTRIP_STEPS; i++) {
    const targetY = Math.round((maxScroll * i) / (FILMSTRIP_STEPS - 1));
    await page.evaluate((y) => window.scrollTo(0, y), targetY);
    await page.waitForTimeout(FILMSTRIP_SETTLE_MS);

    const buffer = await page.screenshot().catch(() => null);
    if (!buffer) continue;
    const scrollY = await page.evaluate(() => window.scrollY);
    frames.push({
      url: await uploadImage(buffer, `${slugifyUrl(url)}-filmstrip-${i}.png`),
      scrollY,
      buffer,
    });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return frames;
}

const MOTION_DIFF_THRESHOLD = 0.15;

/** pixelmatch tra frame filmstrip globali consecutivi, bounding box verticale
 * (page-absolute via scrollY) delle regioni cambiate. */
async function computeMotionHints(frames: FilmstripFrameInternal[]): Promise<MotionHint[]> {
  const hints: MotionHint[] = [];

  for (let i = 0; i < frames.length - 1; i++) {
    const a = PNG.sync.read(frames[i].buffer);
    const b = PNG.sync.read(frames[i + 1].buffer);
    if (a.width !== b.width || a.height !== b.height) continue; // difensivo, stesso viewport atteso

    const diff = new PNG({ width: a.width, height: a.height });
    const numDiff = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
      threshold: MOTION_DIFF_THRESHOLD,
      diffMask: true, // solo pixel diversi restano opachi, il resto trasparente
    });
    if (numDiff === 0) continue;

    let minY = a.height;
    let maxY = 0;
    for (let y = 0; y < a.height; y++) {
      let rowHasDiff = false;
      for (let x = 0; x < a.width; x++) {
        if (diff.data[(a.width * y + x) * 4 + 3] > 0) {
          rowHasDiff = true;
          break;
        }
      }
      if (rowHasDiff) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (minY > maxY) continue;

    hints.push({
      fromFrame: i,
      toFrame: i + 1,
      pageTop: frames[i].scrollY + minY,
      pageBottom: frames[i].scrollY + maxY,
      changedRatio: numDiff / (a.width * a.height),
    });
  }

  return hints;
}

function rangesOverlap(aTop: number, aBottom: number, bTop: number, bBottom: number): boolean {
  return aTop < bBottom && bTop < aBottom;
}

/** Ritaglia dai frame globali solo quelli il cui viewport intersecava la
 * sezione, ciascuno ritagliato al range verticale locale della sezione. */
async function cropFilmstripForSection(
  globalFrames: FilmstripFrameInternal[],
  section: { boundsTop: number; boundsHeight: number },
  url: string
): Promise<FilmstripFrame[]> {
  const sectionBottom = section.boundsTop + section.boundsHeight;
  const result: FilmstripFrame[] = [];

  for (const frame of globalFrames) {
    const frameTop = frame.scrollY;
    const frameBottom = frame.scrollY + SECTION_VIEWPORT_HEIGHT;
    if (!rangesOverlap(frameTop, frameBottom, section.boundsTop, sectionBottom)) continue;

    const localTop = Math.max(0, section.boundsTop - frameTop);
    const localBottom = Math.min(SECTION_VIEWPORT_HEIGHT, sectionBottom - frameTop);
    if (localBottom <= localTop) continue;

    try {
      const cropped = await sharp(frame.buffer)
        .extract({
          left: 0,
          top: Math.round(localTop),
          width: SECTION_VIEWPORT_WIDTH,
          height: Math.round(localBottom - localTop),
        })
        .png()
        .toBuffer();
      result.push({
        url: await uploadImage(cropped, `${slugifyUrl(url)}-fs-${frame.scrollY}.png`),
        scrollY: frame.scrollY,
      });
    } catch {
      // crop fallito per questo frame: skip, non blocca il resto
    }
  }

  return result;
}

// ---------- Funzioni eseguite nel contesto della pagina ----------
// (page.evaluate serializza queste funzioni ed esegue nel browser: niente
// closures sullo scope esterno, solo argomenti passati esplicitamente)

/** Section detection ricorsiva: parte da `body`, scende nei wrapper (>80%
 * altezza pagina) fino a profondità 6, si ferma su elementi in [15%,80%]
 * (generici) o tag semantici oltre una soglia più bassa (~2%/60px). */
function captureSectionsInPage(opts: { cssProps: string[]; maxSections: number }) {
  const totalPageHeight = document.body.scrollHeight;
  const SEMANTIC_TAGS = new Set(["section", "header", "footer", "nav"]);
  const MAX_DEPTH = 6;
  const GENERIC_MIN_RATIO = 0.15;
  const MAX_RATIO = 0.8;
  const SEMANTIC_MIN_RATIO = 0.02;
  const SEMANTIC_MIN_PX = 60;

  const seen = new Set<Element>();
  const found: { el: HTMLElement; top: number; height: number }[] = [];

  function visibleAndSized(el: HTMLElement, rect: DOMRect): boolean {
    if (rect.height < 20 || rect.width < 100) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return true;
  }

  function walk(el: HTMLElement, depth: number) {
    if (seen.has(el) || found.length >= opts.maxSections) return;

    const rect = el.getBoundingClientRect();
    // Elemento trascurabile/non visibile: scarta il branch, non ricorre oltre.
    // Limite noto non gestito: un elemento con overflow:visible e figli
    // assoluti che escono dal box avrebbe qui un rect piccolo pur
    // "contenendo" contenuto grande — i suoi figli non vengono visitati.
    if (!visibleAndSized(el, rect)) return;

    const heightRatio = rect.height / totalPageHeight;
    const semantic = SEMANTIC_TAGS.has(el.tagName.toLowerCase());

    const isValidSection = semantic
      ? heightRatio > SEMANTIC_MIN_RATIO && rect.height > SEMANTIC_MIN_PX && heightRatio <= MAX_RATIO
      : heightRatio >= GENERIC_MIN_RATIO && heightRatio <= MAX_RATIO;

    if (isValidSection) {
      seen.add(el);
      found.push({ el, top: Math.round(rect.top + window.scrollY), height: Math.round(rect.height) });
      return;
    }

    if (heightRatio > MAX_RATIO) {
      if (depth >= MAX_DEPTH) return; // wrapper troppo profondo: rinuncia su questo branch
      for (const child of Array.from(el.children)) walk(child as HTMLElement, depth + 1);
    }
    // altrimenti: troppo piccolo per essere sezione, non abbastanza grande da
    // essere wrapper (es. spacer, banner minuscolo) — scarta senza ricorrere.
  }

  for (const child of Array.from(document.body.children)) walk(child as HTMLElement, 0);

  found.sort((a, b) => a.top - b.top);

  const results: {
    marker: string;
    selector: string;
    tag: string;
    html: string;
    css: string;
    top: number;
    height: number;
  }[] = [];

  let i = 0;
  for (const { el, top, height } of found) {
    const marker = `sec-${i++}`;
    el.setAttribute("data-capture-marker", marker);

    const cssLines: string[] = [];
    const collect = (node: Element, depth: number) => {
      if (depth > 3 || cssLines.length > 50) return;
      const cs = getComputedStyle(node);
      const decl = opts.cssProps
        .map((p) => `${p}: ${cs.getPropertyValue(p)}`)
        .filter((d) => !d.endsWith(": "))
        .join("; ");
      const cls = node.className && typeof node.className === "string"
        ? "." + node.className.trim().split(/\s+/).join(".")
        : "";
      cssLines.push(`${node.tagName.toLowerCase()}${cls} { ${decl} }`);
      for (const child of Array.from(node.children)) collect(child, depth + 1);
    };
    collect(el, 0);

    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).join(".")
      : "";
    results.push({
      marker,
      selector: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`,
      tag: el.tagName.toLowerCase(),
      html: el.outerHTML,
      css: cssLines.join("\n"),
      top,
      height,
    });
  }

  return results;
}

/** Vecchia euristica flat, usata SOLO da `captureSite` (pipeline Component
 * legacy, fuori scope per questa revisione) — non toccare, non condivisa con
 * `captureSectionsInPage` (che ora usa la detection ricorsiva). */
function captureSectionsInPageFlat(opts: { cssProps: string[]; maxSections: number }) {
  const candidates = Array.from(
    document.querySelectorAll(
      "body > *, main > *, header, footer, nav, section, [class*='hero' i]"
    )
  ) as HTMLElement[];

  const seen = new Set<HTMLElement>();
  const results: {
    marker: string;
    selector: string;
    tag: string;
    html: string;
    css: string;
  }[] = [];

  let i = 0;
  for (const el of candidates) {
    if (seen.has(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 40 || rect.width < 100) continue;
    if (results.length >= opts.maxSections) break;
    seen.add(el);

    const marker = `sec-${i++}`;
    el.setAttribute("data-capture-marker", marker);

    const cssLines: string[] = [];
    const collect = (node: Element, depth: number) => {
      if (depth > 3 || cssLines.length > 50) return;
      const cs = getComputedStyle(node);
      const decl = opts.cssProps
        .map((p) => `${p}: ${cs.getPropertyValue(p)}`)
        .filter((d) => !d.endsWith(": "))
        .join("; ");
      const cls = node.className && typeof node.className === "string"
        ? "." + node.className.trim().split(/\s+/).join(".")
        : "";
      cssLines.push(`${node.tagName.toLowerCase()}${cls} { ${decl} }`);
      for (const child of Array.from(node.children)) collect(child, depth + 1);
    };
    collect(el, 0);

    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).join(".")
      : "";
    results.push({
      marker,
      selector: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`,
      tag: el.tagName.toLowerCase(),
      html: el.outerHTML,
      css: cssLines.join("\n"),
    });
  }

  return results;
}

/** Inventario media reale per una sezione già marcata (data-capture-marker):
 * video (source/poster/attributi), img (src/srcset/object-fit), background-image
 * da computed style (non solo inline, copre anche le classi CSS), canvas (solo
 * flag presenza). Gli URL reali arrivano al generatore — niente placeholder
 * prima della generazione. */
function collectMediaInPage(marker: string) {
  const root = document.querySelector(`[data-capture-marker="${marker}"]`);
  const assets: {
    kind: "video" | "image" | "bg-image" | "canvas";
    src?: string;
    poster?: string;
    srcset?: string;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    playsinline?: boolean;
    width?: number;
    height?: number;
    objectFit?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    top?: number;
    left?: number;
  }[] = [];
  if (!root) return assets;

  const rootRect = root.getBoundingClientRect();
  const relativePos = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top - rootRect.top), left: Math.round(r.left - rootRect.left) };
  };

  const els = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of els) {
    const tag = el.tagName.toLowerCase();

    if (tag === "video") {
      const v = el as HTMLVideoElement;
      const sourceSrcs = Array.from(v.querySelectorAll("source")).map(
        (s) => (s as HTMLSourceElement).src
      );
      assets.push({
        kind: "video",
        src: v.currentSrc || v.src || sourceSrcs[0],
        poster: v.poster || undefined,
        autoplay: v.autoplay,
        loop: v.loop,
        muted: v.muted,
        playsinline: v.hasAttribute("playsinline"),
        width: v.videoWidth || v.clientWidth,
        height: v.videoHeight || v.clientHeight,
        ...relativePos(v),
      });
    } else if (tag === "img") {
      const img = el as HTMLImageElement;
      const cs = getComputedStyle(img);
      assets.push({
        kind: "image",
        src: img.currentSrc || img.src,
        srcset: img.srcset || undefined,
        width: img.clientWidth,
        height: img.clientHeight,
        objectFit: cs.objectFit,
        ...relativePos(img),
      });
    } else if (tag === "canvas") {
      assets.push({ kind: "canvas", ...relativePos(el) });
    } else {
      const cs = getComputedStyle(el as HTMLElement);
      const bg = cs.backgroundImage;
      if (bg && bg !== "none") {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m) {
          assets.push({
            kind: "bg-image",
            src: m[1],
            backgroundSize: cs.backgroundSize,
            backgroundPosition: cs.backgroundPosition,
            ...relativePos(el),
          });
        }
      }
    }
  }

  return assets;
}

/** Librerie di animazione rilevate dagli script REALMENTE caricati dalla
 * pagina (src + contenuto inline), non da un pattern-match sull'HTML statico.
 * Esportata: riusata anche da src/lib/reconstruction/staticExtract.ts
 * (Fase 1 dello studio di ricostruzione assistita) via page.evaluate. */
export function detectAnimationLibsInPage() {
  const MARKERS: Record<string, RegExp> = {
    gsap: /\bgsap\b/i,
    ScrollTrigger: /ScrollTrigger/,
    "framer-motion": /framer-motion/i,
    three: /\bthree(\.min)?\.js\b|\bTHREE\b/,
    "locomotive-scroll": /locomotive-scroll/i,
    lenis: /\blenis\b/i,
    swiper: /\bswiper\b/i,
  };

  const found = new Set<string>();
  for (const script of Array.from(document.querySelectorAll("script"))) {
    const s = script as HTMLScriptElement;
    const haystack = `${s.src}\n${s.textContent ?? ""}`;
    for (const [lib, re] of Object.entries(MARKERS)) {
      if (re.test(haystack)) found.add(lib);
    }
  }
  if (document.querySelector("canvas")) found.add("canvas");
  return Array.from(found);
}

/** Forza position:static (scoped, marcato) sugli elementi sticky/fixed prima
 * di uno screenshot fullPage — altrimenti Chromium li renderizza "sganciati"
 * dalla loro posizione pinned reale (difetto noto Playwright/Puppeteer). */
function neutralizeStickyForFullPageShot() {
  const markers: string[] = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const cs = getComputedStyle(el);
    if (cs.position === "sticky" || cs.position === "fixed") {
      const marker = `sticky-${i++}`;
      (el as HTMLElement).setAttribute("data-sticky-neutralize", marker);
      (el as HTMLElement).style.setProperty("position", "static", "important");
      markers.push(marker);
    }
  }
  return markers;
}

function restoreStickyAfterFullPageShot(markers: string[]) {
  for (const marker of markers) {
    const el = document.querySelector(`[data-sticky-neutralize="${marker}"]`) as HTMLElement | null;
    if (el) {
      el.style.removeProperty("position");
      el.removeAttribute("data-sticky-neutralize");
    }
  }
}

function collectAssetsInPage() {
  const assets: { url: string; type: "image" | "font" | "other" }[] = [];
  const seen = new Set<string>();

  const add = (url: string | null | undefined, type: "image" | "font" | "other") => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    assets.push({ url, type });
  };

  document.querySelectorAll("img[src]").forEach((img) => add((img as HTMLImageElement).src, "image"));
  document.querySelectorAll("[style*='background-image']").forEach((el) => {
    const m = (el as HTMLElement).style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (m) add(m[1], "image");
  });
  document.querySelectorAll("link[rel='preload'][as='font'], link[rel='stylesheet']").forEach((link) => {
    const href = (link as HTMLLinkElement).href;
    const as = link.getAttribute("as");
    add(href, as === "font" ? "font" : "other");
  });

  return assets.slice(0, 100);
}

// ---------- Upload screenshot ----------

/**
 * Carica uno screenshot su Vercel Blob. Se BLOB_READ_WRITE_TOKEN non è
 * configurato, torna un data URI (fallback per sviluppo locale senza Blob:
 * va bene solo per immagini piccole, vedi spec Fase A punto 3).
 */
export async function uploadImage(buffer: Buffer, filename: string): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`captures/${Date.now()}-${filename}`, buffer, {
      access: "public",
      contentType: "image/png",
    });
    return blob.url;
  }
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function slugifyUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60);
}
