import sharp from "sharp";
import { uploadImage } from "@/lib/ingest/capture";
import type { AstComponent } from "@/lib/ast/types";

/**
 * Cattura reale, per componente, via ispezione dell'albero fiber di React —
 * stessa tecnica di React DevTools (Fase 3 della spec). Gira SOLO in
 * locale/admin (Playwright + dev server del progetto clonato): il chiamante
 * (src/lib/ingest/repo.ts) verifica CAN_RUN_LOCAL_PIPELINE prima di
 * invocare questa funzione. "playwright" è importato dinamicamente per non
 * finire mai nel bundle serverless, come in src/lib/ingest/capture.ts.
 */

const VIEWPORT = { width: 1440, height: 900 };
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_200;

export interface PreviewCaptureResult {
  previews: Map<string, string>; // filePath -> URL Blob dello screenshot ritagliato
  coverScreenshot: string | null; // screenshot full-page della homepage
}

export async function capturePreviews(
  baseUrl: string,
  components: AstComponent[],
  routes: string[]
): Promise<PreviewCaptureResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  const previews = new Map<string, string>();
  let coverScreenshot: string | null = null;
  const componentNames = Array.from(new Set(components.map((c) => c.name)));
  const filePathByName = new Map(components.map((c) => [c.name, c.filePath]));

  try {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.addInitScript(installFiberHookInPage);

      try {
        await page.goto(new URL(route, baseUrl).toString(), {
          waitUntil: "networkidle",
          timeout: NAV_TIMEOUT_MS,
        });
        await page.waitForTimeout(SETTLE_MS);

        const fullPageBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
        if (!fullPageBuffer) continue;

        if (!coverScreenshot) {
          coverScreenshot = await uploadImage(fullPageBuffer, `repo-cover-${slug(route)}.png`);
        }

        const found = await page.evaluate(walkFibersInPage, componentNames);

        for (const box of found) {
          const filePath = filePathByName.get(box.name);
          if (!filePath || previews.has(filePath)) continue;
          if (box.width < 4 || box.height < 4) continue;

          try {
            const cropped = await sharp(fullPageBuffer)
              .extract({
                left: Math.max(0, Math.round(box.left)),
                top: Math.max(0, Math.round(box.top)),
                width: Math.max(1, Math.round(box.width)),
                height: Math.max(1, Math.round(box.height)),
              })
              .png()
              .toBuffer();
            previews.set(filePath, await uploadImage(cropped, `${slug(box.name)}-${Date.now()}.png`));
          } catch {
            // bounding box fuori dai limiti dello screenshot full-page (es. overlay/portal): skip, non bloccare gli altri
          }
        }
      } catch (err) {
        console.error(`Preview fallita per route "${route}":`, err instanceof Error ? err.message : err);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return { previews, coverScreenshot };
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60) || "root";
}

// ---------- Eseguite nel contesto della pagina (page.evaluate/addInitScript) ----------
// Niente closure sullo scope esterno: solo argomenti passati esplicitamente,
// stessa convenzione di src/lib/ingest/capture.ts.

/**
 * Iniettato PRIMA della navigazione via page.addInitScript: React chiama il
 * devtools hook solo se questo esiste già al momento in cui il modulo
 * reconciler viene valutato — per questo non si può aspettare che la pagina
 * sia carica e installarlo dopo. Lo shim registra ogni fiber root committata
 * su window.__VIEWSOURCE_FIBER_ROOTS__, da cui walkFibersInPage parte.
 */
function installFiberHookInPage() {
  const roots: unknown[] = [];
  const renderers = new Map<number, unknown>();
  (window as unknown as Record<string, unknown>).__VIEWSOURCE_FIBER_ROOTS__ = roots;

  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    inject(renderer: unknown) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_rendererId: number, root: { current?: unknown }) {
      if (root?.current && roots.indexOf(root.current) === -1) {
        roots.push(root.current);
      }
    },
    onCommitFiberUnmount() {},
    checkDCE() {},
  };
}

interface FiberBox {
  name: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Cammina ogni fiber root registrata dallo shim (child/sibling), matcha il
 * nome del componente (fiber.type.name/displayName) contro l'elenco estratto
 * in Fase 2, e trova il primo nodo host (DOM) discendente per il bounding box. */
function walkFibersInPage(componentNames: string[]): FiberBox[] {
  interface Fiber {
    type: unknown;
    stateNode?: unknown;
    child?: Fiber | null;
    sibling?: Fiber | null;
  }

  const roots = ((window as unknown as Record<string, unknown>).__VIEWSOURCE_FIBER_ROOTS__ as Fiber[]) ?? [];
  const wanted = new Set(componentNames);
  const results: FiberBox[] = [];
  const seen = new Set<string>();

  function componentName(fiber: Fiber): string | null {
    const type = fiber.type;
    if (typeof type === "function") {
      const fn = type as { name?: string; displayName?: string };
      return fn.displayName || fn.name || null;
    }
    if (type && typeof type === "object") {
      const obj = type as { render?: { name?: string; displayName?: string } };
      if (obj.render) return obj.render.displayName || obj.render.name || null;
    }
    return null;
  }

  function findHostNode(root: Fiber): HTMLElement | null {
    const queue: Fiber[] = [root];
    let first = true;
    while (queue.length > 0) {
      const fiber = queue.shift();
      if (!fiber) continue;
      if (typeof fiber.type === "string" && fiber.stateNode instanceof HTMLElement) {
        return fiber.stateNode;
      }
      if (fiber.child) queue.push(fiber.child);
      if (!first && fiber.sibling) queue.push(fiber.sibling);
      first = false;
    }
    return null;
  }

  function walk(fiber: Fiber | null | undefined) {
    if (!fiber) return;
    const name = componentName(fiber);
    if (name && wanted.has(name) && !seen.has(name)) {
      const host = findHostNode(fiber);
      if (host) {
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          seen.add(name);
          results.push({
            name,
            top: rect.top + window.scrollY,
            left: rect.left + window.scrollX,
            width: rect.width,
            height: rect.height,
          });
        }
      }
    }
    walk(fiber.child);
    walk(fiber.sibling);
  }

  for (const root of roots) walk(root);
  return results;
}
