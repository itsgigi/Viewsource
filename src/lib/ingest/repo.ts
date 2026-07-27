import { assertLocalOnly } from "@/lib/local-only";
import { extractProject } from "@/lib/ast";
import type { AstComponent } from "@/lib/ast/types";
import { capturePreviews } from "@/lib/preview/fiber";
import { startDevServer, stopDevServer } from "@/lib/preview/devserver";
import { ingestRepo } from "./git";
import { uploadImage } from "./capture";
import type { RawDoc } from "./firecrawl";
import type { RepoMetadata } from "./github";

export interface RepoIngestionResult {
  docs: RawDoc[];
  workDir: string;
  license: string;
  metadata: RepoMetadata;
  packageJson: Record<string, unknown> | null;
  astComponents: AstComponent[];
  previews: Map<string, string>; // filePath -> previewImage URL
  designTokens: { palette: string[]; fonts: string[]; notes: string };
  cover: string | null;
}

/**
 * Orchestratore Fasi 1-3 della spec: clone autenticato + metadati GitHub,
 * estrazione AST deterministica, preview via dev server + albero fiber
 * React. Il ranking/descrizione LLM (Fase 4) e la persistenza dei Component
 * sono responsabilità del chiamante (src/lib/ingest/index.ts).
 */
export async function runRepoIngestion(
  siteId: string,
  sourceUrl: string,
  branch: string | null
): Promise<RepoIngestionResult> {
  assertLocalOnly("ingestion da repo GitHub (clone, dev server, Playwright)");

  const { docs, workDir, metadata, license } = await ingestRepo(siteId, sourceUrl, branch);

  const project = await extractProject(workDir);

  let cover: string | null = null;
  let previews = new Map<string, string>();

  try {
    const handle = await startDevServer(workDir, project.framework);
    try {
      const result = await capturePreviews(handle.url, project.components, project.routes);
      previews = result.previews;
      cover = result.coverScreenshot;
    } finally {
      stopDevServer(handle);
    }
  } catch (err) {
    // Fallback (criterio di accettazione 5): il dev server non parte o non
    // è React — l'ingestion prosegue comunque, i componenti restano senza
    // preview individuale. Se è nota una URL deployata, prova almeno la
    // cover del sito da lì.
    console.error(
      `Preview via dev server fallita per site ${siteId}, si procede senza:`,
      err instanceof Error ? err.message : err
    );
    if (metadata.homepage) {
      cover = await captureFallbackCover(metadata.homepage).catch(() => null);
    }
  }

  return {
    docs,
    workDir,
    license,
    metadata,
    packageJson: project.packageJson,
    astComponents: project.components,
    previews,
    designTokens: project.designTokens,
    cover,
  };
}

async function captureFallbackCover(url: string): Promise<string | null> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buffer = await page.screenshot({ fullPage: true }).catch(() => null);
    return buffer ? await uploadImage(buffer, `repo-cover-fallback-${Date.now()}.png`) : null;
  } finally {
    await browser.close();
  }
}
