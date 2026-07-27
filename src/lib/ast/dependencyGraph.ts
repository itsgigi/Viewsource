import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { extractImports, isCandidateFile } from "./parseFile";
import type { BundleFile, ImportRef } from "./types";

const RESOLVE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];
const CSS_EXTS = [".css", ".scss", ".sass"];
const MAX_BUNDLE_FILES = 20;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 200_000;

interface TsconfigPaths {
  baseUrl: string; // absolute
  paths: Record<string, string[]>;
}

async function loadTsconfigPaths(workDir: string): Promise<TsconfigPaths | null> {
  const raw = await readFile(join(workDir, "tsconfig.json"), "utf-8").catch(() => null);
  if (!raw) return null;
  try {
    // tsconfig ammette commenti/trailing comma (JSONC): strip minimale prima del parse.
    const jsonText = raw.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    const json = JSON.parse(jsonText);
    const co = json.compilerOptions ?? {};
    if (!co.paths) return null;
    return { baseUrl: join(workDir, co.baseUrl ?? "."), paths: co.paths };
  } catch {
    return null;
  }
}

function resolveAlias(source: string, tsconfig: TsconfigPaths | null): string | null {
  if (!tsconfig) return null;
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const prefix = pattern.replace(/\*$/, "");
    if (!source.startsWith(prefix)) continue;
    const rest = source.slice(prefix.length);
    const target = targets[0]?.replace(/\*$/, "") ?? "";
    return join(tsconfig.baseUrl, target + rest);
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}

async function resolveModuleFile(absNoExt: string): Promise<string | null> {
  for (const ext of RESOLVE_EXTS) {
    const candidate = absNoExt + ext;
    if (await exists(candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTS) {
    const candidate = join(absNoExt, "index" + ext);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function resolveImportSource(
  source: string,
  fromFileAbs: string,
  workDir: string,
  tsconfig: TsconfigPaths | null
): Promise<string | null> {
  let absNoExt: string;
  if (source.startsWith(".")) {
    absNoExt = resolve(dirname(fromFileAbs), source);
  } else if (source.startsWith("/")) {
    absNoExt = join(workDir, source);
  } else {
    const aliased = resolveAlias(source, tsconfig);
    if (!aliased) return null; // pacchetto npm, o alias non risolvibile: non locale
    absNoExt = aliased;
  }

  if (CSS_EXTS.some((ext) => source.endsWith(ext))) {
    return (await exists(absNoExt)) ? absNoExt : null;
  }

  return resolveModuleFile(absNoExt);
}

function packageNameFromSpecifier(source: string): string {
  if (source.startsWith("@")) return source.split("/").slice(0, 2).join("/");
  return source.split("/")[0];
}

export interface BundleResult {
  bundleFiles: BundleFile[];
  npmDeps: string[];
}

/**
 * Da un file componente, risolve ricorsivamente gli import LOCALI (custom
 * hook, utility, CSS module, tipi) per costruire il bundle multi-file
 * completo — questo è il vantaggio chiave sullo scraping: si consegna un
 * componente funzionante, non uno snippet isolato. Colleziona in parallelo
 * i pacchetti npm toccati lungo il grafo.
 */
export async function buildBundle(
  workDir: string,
  entryRelPath: string,
  entryImports: ImportRef[]
): Promise<BundleResult> {
  const tsconfig = await loadTsconfigPaths(workDir);
  const bundleFiles = new Map<string, string>();
  const npmDeps = new Set<string>();
  const visited = new Set<string>();

  const entryAbs = join(workDir, entryRelPath);
  const entryContent = await readFile(entryAbs, "utf-8").catch(() => null);
  if (entryContent !== null) bundleFiles.set(entryRelPath, entryContent);
  visited.add(entryAbs);

  const queue: { absPath: string; imports: ImportRef[]; depth: number }[] = [
    { absPath: entryAbs, imports: entryImports, depth: 0 },
  ];

  while (queue.length > 0 && bundleFiles.size < MAX_BUNDLE_FILES) {
    const item = queue.shift()!;
    if (item.depth > MAX_DEPTH) continue;

    for (const imp of item.imports) {
      if (!imp.isLocal) {
        npmDeps.add(packageNameFromSpecifier(imp.source));
        continue;
      }

      const resolved = await resolveImportSource(imp.source, item.absPath, workDir, tsconfig);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      if (bundleFiles.size >= MAX_BUNDLE_FILES) continue;

      const info = await stat(resolved).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const content = await readFile(resolved, "utf-8").catch(() => null);
      if (content === null) continue;

      const relPath = relative(workDir, resolved);
      bundleFiles.set(relPath, content);

      if (isCandidateFile(relPath)) {
        queue.push({ absPath: resolved, imports: extractImports(content), depth: item.depth + 1 });
      }
    }
  }

  return {
    bundleFiles: Array.from(bundleFiles.entries()).map(([path, content]) => ({ path, content })),
    npmDeps: Array.from(npmDeps),
  };
}
