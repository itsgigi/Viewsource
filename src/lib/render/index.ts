import path from "node:path";
import fs from "node:fs/promises";
import type { ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";

/**
 * Mini-renderer riusabile: monta codice di un componente React+TS+Tailwind
 * (stringa) in un progetto Vite persistente e ne cattura uno screenshot con
 * Playwright. Gira SOLO in locale/admin — stessa convenzione di
 * `ingest/capture.ts` ("vite" e "playwright" importati dinamicamente così il
 * bundler non li traccia mai nel bundle delle funzioni serverless).
 *
 * Riusato dal loop di ricostruzione per-sezione (Fase B/C) e, in futuro, dal
 * rendering pubblico (Sandpack/compile-at-publish, fuori scope qui).
 */

const CAN_RENDER = !process.env.VERCEL;

const HARNESS_DIR = path.join(process.cwd(), "src", "lib", "render", "harness");
const HARNESS_SRC_DIR = path.join(HARNESS_DIR, "src");

const COMPONENT_FILE = path.join(HARNESS_SRC_DIR, "Component.tsx");
const COMPONENT_URL = "/src/Component.tsx";
const CSS_URL = "/src/index.css";

let viteServer: ViteDevServer | null = null;
let serverUrl: string | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let lastPageError: string | null = null;

async function getServerUrl(): Promise<string> {
  if (viteServer && serverUrl) return serverUrl;

  const { createServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const tailwindcss = (await import("@tailwindcss/vite")).default;

  viteServer = await createServer({
    root: HARNESS_DIR,
    plugins: [react(), tailwindcss()],
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "error",
    clearScreen: false,
  });
  await viteServer.listen();

  const address = viteServer.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) throw new Error("Vite dev server (mini-renderer) non avviato correttamente");

  serverUrl = `http://127.0.0.1:${port}`;
  return serverUrl;
}

async function getPage(): Promise<Page> {
  if (page) return page;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  page = await browser.newPage();
  // Cattura errori JS non gestiti dell'harness (es. il componente generato
  // lancia in render): senza questo, un mount fallito si manifesta solo come
  // "#render-root non visibile" al momento dello screenshot, senza indicare
  // la vera causa.
  page.on("pageerror", (err) => {
    lastPageError = err.message;
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") lastPageError = msg.text();
  });
  return page;
}

async function settleBeforeScreenshot(p: Page): Promise<void> {
  await p.evaluate(() => {
    return new Promise<void>((resolve) => {
      let total = 0;
      const step = window.innerHeight;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(resolve, 200);
        }
      }, 100);
    });
  });
  await p.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
  await p.waitForTimeout(200);
}

export interface RenderOptions {
  /** Larghezza viewport, in px — deve coincidere con quella usata in cattura (1440). */
  width: number;
}

/**
 * Monta `code` (un componente .tsx con default export) e restituisce lo
 * screenshot PNG dell'elemento montato (#render-root, altezza naturale).
 *
 * Scrive SEMPRE sullo stesso file (Component.tsx) e invalida esplicitamente
 * i moduli corrispondenti nel module graph di Vite prima di navigare: non ci
 * si affida al timing del file watcher (chokidar) per accorgersi che il file
 * è cambiato — con un nome di file nuovo ad ogni render, Tailwind poteva non
 * aver ancora rilevato le classi del componente al momento della richiesta,
 * servendo un CSS senza quelle utility (componente montato ma "collassato" ad
 * altezza 0, quindi "non visibile" per Playwright).
 */
export async function renderComponent(code: string, opts: RenderOptions): Promise<Buffer> {
  if (!CAN_RENDER) {
    throw new Error("renderComponent gira solo in locale (npm run dev), non è disponibile su Vercel.");
  }

  const url = await getServerUrl();
  const p = await getPage();

  await fs.writeFile(COMPONENT_FILE, code, "utf-8");

  const componentMod = await viteServer!.moduleGraph.getModuleByUrl(COMPONENT_URL);
  if (componentMod) viteServer!.moduleGraph.invalidateModule(componentMod);
  const cssMod = await viteServer!.moduleGraph.getModuleByUrl(CSS_URL);
  if (cssMod) viteServer!.moduleGraph.invalidateModule(cssMod);

  // Forza la ritransformazione (e quindi la ri-scansione delle classi
  // Tailwind) PRIMA di navigare, invece di sperare che sia già avvenuta.
  await viteServer!.transformRequest(CSS_URL);
  await viteServer!.transformRequest(COMPONENT_URL);

  lastPageError = null;

  await p.setViewportSize({ width: opts.width, height: 2000 });
  await p.goto(`${url}/?t=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => (window as unknown as { __RENDER_READY__?: boolean }).__RENDER_READY__ === true, {
    timeout: 15_000,
  });

  // Replica lo stesso passaggio usato in cattura (autoScrollInPage + freeze,
  // src/lib/ingest/capture.ts): fa scattare eventuali reveal/IntersectionObserver
  // nel render isolato, poi congela animazioni/transizioni prima dello
  // screenshot. Senza questo, un componente che implementa correttamente un
  // reveal-on-scroll verrebbe fotografato "non rivelato" mentre la ground
  // truth è catturata già "assestata" — penalizzando il codice più corretto
  // invece di quello che ignora lo scroll e mostra subito lo stato finale.
  await settleBeforeScreenshot(p);

  try {
    return await p.locator("#render-root").screenshot({ timeout: 8_000 });
  } catch (err) {
    const box = await p.locator("#render-root").boundingBox().catch(() => null);
    const html = await p
      .locator("#render-root")
      .innerHTML()
      .then((h) => h.slice(0, 500))
      .catch(() => null);
    const diagnostics = [
      `bounding box: ${box ? `${box.width}x${box.height}` : "n/a"}`,
      lastPageError ? `errore JS nell'harness: ${lastPageError}` : null,
      html ? `HTML montato: ${html}` : "HTML montato: (vuoto)",
    ]
      .filter(Boolean)
      .join(" — ");
    throw new Error(
      `Render fallito (elemento non visibile/screenshot in timeout). ${diagnostics}. ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Chiude il dev server Vite e il browser Playwright (cleanup di processo). */
export async function closeRenderer(): Promise<void> {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await viteServer?.close().catch(() => {});
  page = null;
  browser = null;
  viteServer = null;
  serverUrl = null;
}
