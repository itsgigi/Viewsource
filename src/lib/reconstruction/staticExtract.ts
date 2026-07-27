import { assertLocalOnly } from "@/lib/local-only";
import { detectAnimationLibsInPage } from "@/lib/ingest/capture";
import { staticExtractionPath, updateMeta } from "./paths";
import { setRunning } from "./progress";
import fs from "node:fs/promises";

export interface StaticMediaAsset {
  kind: "video" | "image" | "bg-image" | "canvas";
  src?: string;
  poster?: string;
  srcset?: string;
}

export interface StaticExtraction {
  html: string;
  stylesheets: string[]; // href dei fogli linkati
  sectionStyles: string[]; // computed styles serializzati dei figli principali di <body>
  media: StaticMediaAsset[];
  fonts: string[];
  palette: string[];
  detectedLibs: string[];
  extractedAt: string;
}

const CSS_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "gap",
  "background", "background-color", "color", "font-family", "font-size",
  "font-weight", "flex-direction", "align-items", "justify-content",
  "grid-template-columns", "border-radius",
];

/** Eseguita nel contesto della pagina (page.evaluate): niente closure sullo
 * scope esterno, solo argomenti espliciti — stessa convenzione di
 * src/lib/ingest/capture.ts. */
function extractStaticInPage(opts: { cssProps: string[] }) {
  const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href
  );

  const sectionStyles = Array.from(document.body.children)
    .slice(0, 30)
    .map((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      const decl = opts.cssProps
        .map((p) => `${p}: ${cs.getPropertyValue(p)}`)
        .filter((d) => !d.endsWith(": "))
        .join("; ");
      const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls} { ${decl} }`;
    });

  const media: StaticMediaAsset[] = [];
  const seenSrc = new Set<string>();
  const addMedia = (asset: StaticMediaAsset) => {
    const key = `${asset.kind}:${asset.src ?? ""}`;
    if (seenSrc.has(key)) return;
    seenSrc.add(key);
    media.push(asset);
  };

  document.querySelectorAll("video").forEach((v) => {
    const video = v as HTMLVideoElement;
    addMedia({ kind: "video", src: video.currentSrc || video.src, poster: video.poster || undefined });
  });
  document.querySelectorAll("img").forEach((i) => {
    const img = i as HTMLImageElement;
    addMedia({ kind: "image", src: img.currentSrc || img.src, srcset: img.srcset || undefined });
  });
  document.querySelectorAll("canvas").forEach(() => addMedia({ kind: "canvas" }));
  document.querySelectorAll("*").forEach((el) => {
    const bg = getComputedStyle(el as HTMLElement).backgroundImage;
    if (bg && bg !== "none") {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) addMedia({ kind: "bg-image", src: m[1] });
    }
  });

  // Fonts: font-family computati sugli elementi testuali principali +
  // @font-face dai fogli same-origin (cross-origin lanciano su cssRules: skip).
  const fontFamilies = new Set<string>();
  document.querySelectorAll("body, h1, h2, h3, p, a, button").forEach((el) => {
    const f = getComputedStyle(el as HTMLElement).fontFamily;
    if (f) fontFamilies.add(f.split(",")[0].trim().replace(/^["']|["']$/g, ""));
  });
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSFontFaceRule) {
          const f = rule.style.getPropertyValue("font-family").replace(/^["']|["']$/g, "");
          if (f) fontFamilies.add(f);
        }
      }
    } catch {
      // foglio cross-origin: cssRules inaccessibile, skip
    }
  }

  // Palette: frequenza di color/background-color sui primi N elementi visibili.
  const colorCounts = new Map<string, number>();
  const els = Array.from(document.querySelectorAll("*")).slice(0, 800);
  for (const el of els) {
    const cs = getComputedStyle(el as HTMLElement);
    for (const c of [cs.backgroundColor, cs.color]) {
      if (!c || c === "rgba(0, 0, 0, 0)" || c === "transparent") continue;
      colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
    }
  }
  const palette = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([c]) => c);

  return {
    stylesheets,
    sectionStyles,
    media,
    fonts: Array.from(fontFamilies),
    palette,
  };
}

/**
 * Estrazione statica dal sito live (Fase 1c): HTML renderizzato, CSS (fogli
 * linkati + computed styles delle sezioni principali), inventario media,
 * librerie di animazione rilevate, font, palette. Gira SOLO in locale
 * (Playwright). Salva su disco, non nel DB — vedi spec.
 */
export async function extractStaticData(slug: string, sourceUrl: string): Promise<StaticExtraction> {
  assertLocalOnly("L'estrazione statica");
  setRunning(slug, { stage: "extracting-static" });

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60_000 });
      await page.waitForTimeout(1_500);

      const html = await page.content();
      const detectedLibs = await page.evaluate(detectAnimationLibsInPage);
      const rest = await page.evaluate(extractStaticInPage, { cssProps: CSS_PROPS });

      const result: StaticExtraction = {
        html,
        stylesheets: rest.stylesheets,
        sectionStyles: rest.sectionStyles,
        media: rest.media,
        fonts: rest.fonts,
        palette: rest.palette,
        detectedLibs,
        extractedAt: new Date().toISOString(),
      };

      await fs.writeFile(staticExtractionPath(slug), JSON.stringify(result, null, 2), "utf-8");
      await updateMeta(slug, (meta) => {
        meta.detectedLibs = detectedLibs;
        meta.palette = rest.palette;
        meta.fonts = rest.fonts;
      });

      return result;
    } finally {
      await browser.close();
    }
  } finally {
    setRunning(slug, null);
  }
}
