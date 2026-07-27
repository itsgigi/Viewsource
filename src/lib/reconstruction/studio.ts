import type { ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { reconstructionDir } from "./paths";

/**
 * Generalizzazione di src/lib/render/index.ts: invece di un unico harness
 * condiviso per un componente alla volta, uno per-slug persistente rootato
 * su /reconstructions/<slug>/ (che è già di per sé un piccolo progetto Vite —
 * vedi ensureScaffold in ./paths). Serve sia la preview live con HMR (Fase 4,
 * <iframe> nella route admin) sia gli screenshot Playwright (Verify Fase 4,
 * pubblicazione Fase 6). Gira SOLO in locale/admin, stessa convenzione di
 * src/lib/local-only.ts.
 */

const CAN_RENDER = !process.env.VERCEL;

interface StudioServer {
  viteServer: ViteDevServer;
  url: string;
}

const servers = new Map<string, StudioServer>();

let browser: Browser | null = null;
let page: Page | null = null;
let lastPageError: string | null = null;

export async function ensureStudioServer(slug: string): Promise<{ url: string }> {
  if (!CAN_RENDER) {
    throw new Error('Lo studio di ricostruzione richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.');
  }

  const existing = servers.get(slug);
  if (existing) return { url: existing.url };

  const { createServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const tailwindcss = (await import("@tailwindcss/vite")).default;

  const viteServer = await createServer({
    root: reconstructionDir(slug),
    plugins: [react(), tailwindcss()],
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "error",
    clearScreen: false,
  });
  await viteServer.listen();

  const address = viteServer.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) throw new Error(`Vite dev server dello studio non avviato correttamente per "${slug}"`);

  const url = `http://127.0.0.1:${port}`;
  servers.set(slug, { viteServer, url });
  return { url };
}

export async function closeStudioServer(slug: string): Promise<void> {
  const existing = servers.get(slug);
  if (!existing) return;
  await existing.viteServer.close().catch(() => {});
  servers.delete(slug);
}

async function getPage(): Promise<Page> {
  if (page) return page;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (err) => {
    lastPageError = err.message;
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") lastPageError = msg.text();
  });
  return page;
}

// Stesso passaggio di src/lib/render/index.ts: fa scattare eventuali
// reveal/IntersectionObserver, poi congela animazioni/transizioni.
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

export interface StudioRenderOptions {
  width?: number;
}

/**
 * Screenshot di una singola sezione (?section=<file>) o dell'intera pagina
 * (section null) del progetto Vite dello studio — usato da Verify (Fase 4)
 * e dallo screenshot di pubblicazione (Fase 6).
 */
export async function renderStudio(
  slug: string,
  section: string | null,
  opts: StudioRenderOptions = {}
): Promise<Buffer> {
  const { url } = await ensureStudioServer(slug);
  const p = await getPage();

  lastPageError = null;
  await p.setViewportSize({ width: opts.width ?? 1440, height: 2000 });

  const target = section
    ? `${url}/?section=${encodeURIComponent(section)}&t=${Date.now()}`
    : `${url}/?t=${Date.now()}`;
  await p.goto(target, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => (window as unknown as { __RENDER_READY__?: boolean }).__RENDER_READY__ === true, {
    timeout: 15_000,
  });

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
      lastPageError ? `errore JS: ${lastPageError}` : null,
      html ? `HTML montato: ${html}` : "HTML montato: (vuoto)",
    ]
      .filter(Boolean)
      .join(" — ");
    throw new Error(
      `Render studio fallito (elemento non visibile/screenshot in timeout). ${diagnostics}. ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Cleanup di processo (non richiesto dal flusso normale, utile per test/script). */
export async function closeAllStudioServers(): Promise<void> {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const s of servers.values()) await s.viteServer.close().catch(() => {});
  servers.clear();
  page = null;
  browser = null;
}
