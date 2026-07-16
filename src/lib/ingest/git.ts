import { simpleGit } from "simple-git";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, extname, basename } from "node:path";
import type { RawDoc } from "./firecrawl";

// Estensioni testuali che ci interessano per l'analisi
const KEEP_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass",
  ".md", ".mdx", ".json", ".html", ".svelte", ".vue", ".astro",
  ".yml", ".yaml", ".toml", ".prisma", ".graphql", ".env.example",
]);

// File di config senza estensione significativa ma preziosi
const KEEP_NAMES = new Set([
  "package.json", "tsconfig.json", "next.config.ts", "next.config.js",
  "tailwind.config.ts", "tailwind.config.js", "vite.config.ts",
  "Dockerfile", "README.md",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out",
  ".turbo", ".vercel", "coverage", ".cache", "public",
]);

const MAX_FILE_BYTES = 200_000; // salta bundle minificati e lockfile giganti

export async function ingestGitRepo(repoUrl: string): Promise<RawDoc[]> {
  const dir = await mkdtemp(join(tmpdir(), "ingest-"));

  try {
    // Shallow clone: solo l'ultimo commit, niente storia
    await simpleGit().clone(repoUrl, dir, ["--depth", "1"]);

    const docs: RawDoc[] = [];
    await walk(dir, dir, docs);
    return docs;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function walk(root: string, current: string, out: RawDoc[]) {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(current, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, full, out);
      continue;
    }

    const name = basename(entry.name);
    const ext = extname(entry.name);
    if (!KEEP_EXT.has(ext) && !KEEP_NAMES.has(name)) continue;
    if (name === "package-lock.json" || name === "yarn.lock") continue;

    const info = await stat(full);
    if (info.size > MAX_FILE_BYTES) continue;

    const content = await readFile(full, "utf-8").catch(() => null);
    if (!content || content.includes("\u0000")) continue; // binario mascherato

    out.push({
      path: relative(root, full),
      kind: "file",
      content,
    });
  }
}
