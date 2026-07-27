import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dirExists } from "./framework";
import type { Framework } from "./types";

const MAX_ROUTES = 6;
const MAX_DEPTH = 4;

/**
 * Route principali del progetto, per la cattura preview (Fase 3). Solo
 * Next.js App Router è risolto strutturalmente (folder → URL); gli altri
 * framework/route dinamiche ripiegano sulla sola homepage — sufficiente
 * per il caso comune, il resto dei componenti resta comunque estratto via
 * AST anche senza preview individuale.
 */
export async function detectRoutes(workDir: string, framework: Framework): Promise<string[]> {
  if (framework !== "next-app") return ["/"];

  const appDir = (await dirExists(join(workDir, "src", "app")))
    ? join(workDir, "src", "app")
    : join(workDir, "app");

  const routes = new Set<string>(["/"]);
  await walkAppDir(appDir, "", routes, 0);
  return Array.from(routes).slice(0, MAX_ROUTES);
}

async function walkAppDir(dir: string, urlPrefix: string, routes: Set<string>, depth: number) {
  if (depth > MAX_DEPTH || routes.size >= MAX_ROUTES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPage = entries.some((e) => e.isFile() && /^page\.(tsx|jsx|ts|js)$/.test(e.name));
  if (hasPage && urlPrefix) routes.add(urlPrefix);

  for (const entry of entries) {
    if (routes.size >= MAX_ROUTES) return;
    if (!entry.isDirectory()) continue;
    // Route dinamiche ([slug]) escluse: nessun param reale da fornire.
    // api/ non è una pagina. _private e simili sono convenzioni interne.
    if (entry.name.startsWith("[") || entry.name.startsWith("_") || entry.name === "api") continue;

    const segment = entry.name.startsWith("(") && entry.name.endsWith(")") ? "" : `/${entry.name}`;
    await walkAppDir(join(dir, entry.name), urlPrefix + segment, routes, depth + 1);
  }
}
