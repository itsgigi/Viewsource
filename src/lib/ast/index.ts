import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { SKIP_DIRS } from "@/lib/ingest/git";
import { buildBundle } from "./dependencyGraph";
import { detectFramework, readPackageJson } from "./framework";
import { isCandidateFile, parseFile } from "./parseFile";
import { detectRoutes } from "./routes";
import { extractDesignTokens } from "./tokens";
import type { AstComponent, DesignTokens, Framework } from "./types";

export type { AstComponent, Framework, DesignTokens };

const MAX_FILE_BYTES = 200_000;
const MAX_FILES_SCANNED = 800;

async function walkSourceFiles(root: string, current: string, out: string[]) {
  if (out.length >= MAX_FILES_SCANNED) return;
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (out.length >= MAX_FILES_SCANNED) return;
    const full = join(current, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkSourceFiles(root, full, out);
      continue;
    }

    const relPath = relative(root, full);
    if (!isCandidateFile(relPath)) continue;
    out.push(relPath);
  }
}

export interface ExtractProjectResult {
  framework: Framework;
  components: AstComponent[];
  designTokens: DesignTokens;
  packageJson: Record<string, unknown> | null;
  routes: string[];
}

/**
 * Estrazione AST deterministica dell'intero progetto (Fase 2): componenti
 * React esportati con props reali, bundle multi-file, dipendenze npm.
 * Nessuna chiamata LLM — vedi src/lib/analyze/repo.ts per il ranking (Fase 4).
 */
export async function extractProject(workDir: string): Promise<ExtractProjectResult> {
  const framework = await detectFramework(workDir);
  const [designTokens, packageJson, routes] = await Promise.all([
    extractDesignTokens(workDir),
    readPackageJson(workDir),
    detectRoutes(workDir, framework),
  ]);

  const files: string[] = [];
  await walkSourceFiles(workDir, workDir, files);

  const components: AstComponent[] = [];

  for (const relPath of files) {
    const abs = join(workDir, relPath);
    const info = await stat(abs).catch(() => null);
    if (!info || info.size > MAX_FILE_BYTES) continue;

    const content = await readFile(abs, "utf-8").catch(() => null);
    if (content === null) continue;

    const parsed = parseFile(relPath, content);
    if (parsed.length === 0) continue;

    for (const component of parsed) {
      const { bundleFiles, npmDeps } = await buildBundle(workDir, relPath, component.imports);
      components.push({ ...component, bundleFiles, npmDeps });
    }
  }

  return { framework, components, designTokens, packageJson, routes };
}
