import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Framework } from "./types";

export async function readPackageJson(workDir: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(join(workDir, "package.json"), "utf-8").catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

export async function detectFramework(workDir: string): Promise<Framework> {
  const pkg = await readPackageJson(workDir);
  const deps = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };

  if (deps.next) {
    const hasApp =
      (await dirExists(join(workDir, "src", "app"))) || (await dirExists(join(workDir, "app")));
    return hasApp ? "next-app" : "next-pages";
  }
  if (deps["@remix-run/react"] || deps["@remix-run/dev"]) return "remix";
  if (deps.astro) return "astro";
  if (deps.vite) return "vite";
  return "unknown";
}

/** Flag CLI per forzare la porta del dev server, per framework rilevato — usato in Fase 3. */
export function devPortFlag(framework: Framework, port: number): string[] {
  switch (framework) {
    case "next-app":
    case "next-pages":
      return ["-p", String(port)];
    case "vite":
    case "remix":
    case "astro":
      return ["--port", String(port)];
    default:
      return [];
  }
}
