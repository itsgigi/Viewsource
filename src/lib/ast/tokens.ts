import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignTokens } from "./types";

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FONT_FAMILY_RE = /font-family:\s*([^;}"']+)/gi;

const GLOBAL_CSS_CANDIDATES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/App.css",
];

/** Palette/font "best effort" via regex su tailwind.config e CSS globali —
 * non un parser JS completo (il config è un modulo eseguibile arbitrario),
 * ma sufficiente per i valori hex/font-family dichiarati staticamente. */
export async function extractDesignTokens(workDir: string): Promise<DesignTokens> {
  const palette = new Set<string>();
  const fonts = new Set<string>();
  const notes: string[] = [];

  for (const name of ["tailwind.config.ts", "tailwind.config.js"]) {
    const text = await readFile(join(workDir, name), "utf-8").catch(() => null);
    if (!text) continue;
    for (const m of text.matchAll(HEX_RE)) palette.add(m[0]);
    notes.push(`tema da ${name}`);
    break;
  }

  for (const rel of GLOBAL_CSS_CANDIDATES) {
    const text = await readFile(join(workDir, rel), "utf-8").catch(() => null);
    if (!text) continue;
    for (const m of text.matchAll(HEX_RE)) palette.add(m[0]);
    for (const m of text.matchAll(FONT_FAMILY_RE)) {
      for (const f of m[1].split(",")) {
        const cleaned = f.trim().replace(/['"]/g, "");
        if (cleaned && !cleaned.includes("var(")) fonts.add(cleaned);
      }
    }
    notes.push(`variabili da ${rel}`);
  }

  return {
    palette: Array.from(palette).slice(0, 20),
    fonts: Array.from(fonts).slice(0, 10),
    notes: notes.length > 0 ? `Design tokens rilevati: ${notes.join(", ")}` : "Nessun file di tema esplicito rilevato",
  };
}
