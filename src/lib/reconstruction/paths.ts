import path from "node:path";
import fs from "node:fs/promises";

/**
 * Studio di ricostruzione assistita (Viewsource v2): tutto il materiale di
 * lavoro vive su disco sotto /reconstructions/<slug>/, MAI nel DB — è
 * l'unica fonte di verità (vedi spec Fase 3-6). Il DB (`Section`) è solo una
 * proiezione popolata da `publish` (src/lib/reconstruction/publish.ts).
 */

export const RECONSTRUCTIONS_ROOT = path.join(process.cwd(), "reconstructions");

export type ReconstructionPhase =
  | "collecting"
  | "analyzed"
  | "generated"
  | "refining"
  | "published";

export interface ReconstructionFrame {
  file: string; // relativo a material/frames/, es. "frame_004.jpg"
  timestampMs: number;
}

export interface ReconstructionSectionMeta {
  file: string; // relativo a sections/, es. "01-Hero.tsx"
  name: string;
  approved: boolean;
  referenceFrame: string | null; // file frame scelto dall'admin per il Verify (Fase 4)
}

export interface ReconstructionMeta {
  slug: string;
  siteId: string;
  sourceUrl: string;
  phase: ReconstructionPhase;
  detectedLibs: string[];
  palette: string[];
  fonts: string[];
  video: { human: string | null; scripted: string | null };
  frames: ReconstructionFrame[];
  sections: ReconstructionSectionMeta[];
  createdAt: string;
  updatedAt: string;
}

export function reconstructionDir(slug: string): string {
  return path.join(RECONSTRUCTIONS_ROOT, slug);
}

export function materialDir(slug: string): string {
  return path.join(reconstructionDir(slug), "material");
}

export function framesDir(slug: string): string {
  return path.join(materialDir(slug), "frames");
}

export function videoDir(slug: string): string {
  return path.join(materialDir(slug), "video");
}

export function sectionsDir(slug: string): string {
  return path.join(reconstructionDir(slug), "sections");
}

export function assetsDir(slug: string): string {
  return path.join(reconstructionDir(slug), "assets");
}

export function metaPath(slug: string): string {
  return path.join(reconstructionDir(slug), "meta.json");
}

export function specPath(slug: string): string {
  return path.join(reconstructionDir(slug), "SPEC.md");
}

export function staticExtractionPath(slug: string): string {
  return path.join(materialDir(slug), "static-extraction.json");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function reconstructionExists(slug: string): Promise<boolean> {
  return exists(metaPath(slug));
}

export async function readMeta(slug: string): Promise<ReconstructionMeta> {
  const raw = await fs.readFile(metaPath(slug), "utf-8");
  return JSON.parse(raw) as ReconstructionMeta;
}

export async function writeMeta(slug: string, meta: ReconstructionMeta): Promise<void> {
  meta.updatedAt = new Date().toISOString();
  await fs.writeFile(metaPath(slug), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

export async function updateMeta(
  slug: string,
  patch: (meta: ReconstructionMeta) => ReconstructionMeta | void
): Promise<ReconstructionMeta> {
  const meta = await readMeta(slug);
  const next = patch(meta) ?? meta;
  await writeMeta(slug, next);
  return next;
}

export async function readSpec(slug: string): Promise<string | null> {
  try {
    return await fs.readFile(specPath(slug), "utf-8");
  } catch {
    return null;
  }
}

export async function writeSpec(slug: string, content: string): Promise<void> {
  await fs.writeFile(specPath(slug), content, "utf-8");
}

// ---------- Scaffolding (Vite root minimale, scritto una volta sola) ----------

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div id="render-root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
`;

const STYLES_CSS = `@import "tailwindcss";\n`;

// import.meta.glob permette di montare una singola sezione per nome file a
// runtime (Fase 4 Verify, Fase 6 screenshot di pubblicazione) senza un
// import dinamico per-slug lato Next (vedi piano — evitiamo di scommettere
// sul supporto Turbopack a import(`...${variabile}...`)): è una feature
// nativa e stabile di Vite, con HMR incluso.
const MAIN_TSX = `import { createRoot } from "react-dom/client";
import Page from "./page";

const sectionModules = import.meta.glob("./sections/*.tsx");

async function main() {
  const root = createRoot(document.getElementById("render-root")!);
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");

  if (section) {
    const loader = sectionModules[\`./sections/\${section}\`];
    if (!loader) throw new Error(\`Sezione non trovata nello studio: \${section}\`);
    const mod = (await loader()) as { default: React.ComponentType };
    root.render(<mod.default />);
  } else {
    root.render(<Page />);
  }

  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 150));
  (window as unknown as { __RENDER_READY__?: boolean }).__RENDER_READY__ = true;
}

main();
`;

const PAGE_TSX_PLACEHOLDER = `export default function Page() {
  return (
    <main className="p-12 text-center text-zinc-400">
      Nessuna sezione generata ancora — esegui "Genera demo" (Fase 3).
    </main>
  );
}
`;

/**
 * Crea la cartella /reconstructions/<slug>/ con lo scaffold minimo (Fase 1):
 * idempotente, non sovrascrive file già esistenti (in particolare non
 * tocca mai page.tsx/sections/ una volta che l'admin ci ha messo mano).
 */
export async function ensureScaffold(
  slug: string,
  siteId: string,
  sourceUrl: string
): Promise<ReconstructionMeta> {
  await fs.mkdir(reconstructionDir(slug), { recursive: true });
  await fs.mkdir(framesDir(slug), { recursive: true });
  await fs.mkdir(videoDir(slug), { recursive: true });
  await fs.mkdir(sectionsDir(slug), { recursive: true });
  await fs.mkdir(assetsDir(slug), { recursive: true });

  const writeIfMissing = async (p: string, content: string) => {
    if (!(await exists(p))) await fs.writeFile(p, content, "utf-8");
  };

  await writeIfMissing(path.join(reconstructionDir(slug), "index.html"), INDEX_HTML);
  await writeIfMissing(path.join(reconstructionDir(slug), "styles.css"), STYLES_CSS);
  await writeIfMissing(path.join(reconstructionDir(slug), "main.tsx"), MAIN_TSX);
  await writeIfMissing(path.join(reconstructionDir(slug), "page.tsx"), PAGE_TSX_PLACEHOLDER);

  if (await reconstructionExists(slug)) {
    return readMeta(slug);
  }

  const meta: ReconstructionMeta = {
    slug,
    siteId,
    sourceUrl,
    phase: "collecting",
    detectedLibs: [],
    palette: [],
    fonts: [],
    video: { human: null, scripted: null },
    frames: [],
    sections: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(slug, meta);
  return meta;
}
