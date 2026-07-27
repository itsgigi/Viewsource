import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { extractAnimationSignals } from "@/lib/analyze/animationSignals";
import { extractComponentSource } from "@/lib/ast/parseFile";
import type { CapturedSection } from "@/lib/ingest/capture";
import type { Component, Site } from "@/generated/prisma/client";

// Single target: the public UI no longer offers a stack choice
export const EXTRACTION_TARGET = "React + TypeScript + Tailwind CSS";

const chatModel = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  temperature: 0.2,
});

const codeSchema = z.object({
  code: z
    .string()
    .describe("The complete component code, in a single file, ready to use"),
  filename: z.string().describe("Suggested filename, e.g. Hero.tsx"),
  deps: z
    .array(z.string())
    .describe("npm dependencies needed beyond the target's base ones"),
  notes: z
    .string()
    .describe("Usage notes: props, what to customize, what was reconstructed"),
});

const promptSchema = z.object({
  prompt: z
    .string()
    .describe(
      "A complete, self-contained prompt to paste into an LLM (Claude, ChatGPT, Cursor...) to recreate the component in another project. Includes description, visual and behavioral specs, code references, and adaptation instructions."
    ),
  notes: z
    .string()
    .describe("Tips on how to use the prompt and what else to specify"),
});

export type ExtractionMode = "code" | "prompt";

export interface BundleFile {
  path: string;
  content: string;
}

export interface ExtractionResult {
  mode: ExtractionMode;
  code?: string;
  filename?: string;
  deps?: string[];
  prompt?: string;
  notes?: string;
  files?: BundleFile[]; // full multi-file bundle ("ast"-origin components only)
}

export function suggestedFilename(componentName: string): string {
  return `${componentName.replace(/\s+/g, "")}.tsx`;
}

/**
 * Lazy extraction with a permanent cache: if the field is already populated
 * it returns the saved value WITHOUT calling OpenAI; otherwise it generates
 * once and persists.
 */
export async function extractComponent(
  component: Component & { site: Site },
  mode: ExtractionMode
): Promise<ExtractionResult> {
  if (component.origin === "ast") {
    return extractAstComponent(component, mode);
  }

  if (mode === "code" && component.code) {
    return {
      mode: "code",
      code: component.code,
      filename: suggestedFilename(component.name),
      deps: (component.deps as string[] | null) ?? [],
    };
  }
  if (mode === "prompt" && component.prompt) {
    return { mode: "prompt", prompt: component.prompt };
  }

  const site = component.site;

  // Fetch the source document (exact match, then partial)
  const sourceDoc = component.sourcePath
    ? await prisma.document.findFirst({
        where: {
          siteId: site.id,
          OR: [
            { path: component.sourcePath },
            { path: { contains: lastSegment(component.sourcePath) } },
          ],
        },
      })
    : null;

  // package.json for context on real dependencies (git repos only)
  const pkgDoc = await prisma.document.findFirst({
    where: { siteId: site.id, path: { endsWith: "package.json" } },
  });

  // Section captured from the real DOM (Playwright, Phase A) matching this
  // component: primary source of real HTML/CSS for code and prompt.
  const capturedSections = (site.capturedSections as CapturedSection[] | null) ?? [];
  const capturedSection = component.sourcePath
    ? capturedSections.find(
        (s) =>
          s.selector === component.sourcePath ||
          s.selector.includes(component.sourcePath!) ||
          component.sourcePath!.includes(s.selector)
      )
    : undefined;

  const designInfo = site.designInfo
    ? JSON.stringify(site.designInfo)
    : "not available";

  const isAnimation = component.kind === "animation";
  const scrollScreenshots: string[] = isAnimation
    ? (site.scrollScreenshots as string[] | null) ?? []
    : [];
  const animationSignals = isAnimation
    ? extractAnimationSignals(sourceDoc?.html)
    : "";

  const sharedContext = `PROJECT: ${site.name} (${site.sourceUrl})

COMPONENT: ${component.name} (${component.kind})
DESCRIPTION: ${component.description}

TARGET STACK: ${EXTRACTION_TARGET}

PROJECT DESIGN INFO:
${designInfo}

${
  capturedSection
    ? `SECTION CAPTURED FROM THE REAL DOM (Playwright, selector "${capturedSection.selector}") — primary source, faithful to the real render:\nHTML:\n${capturedSection.html.slice(0, 8_000)}\nComputed CSS:\n${capturedSection.css.slice(0, 3_000)}`
    : ""
}

${
  sourceDoc
    ? `SOURCE${capturedSection ? " (additional context)" : ""} (${sourceDoc.path}):\n${sourceDoc.content.slice(0, 30_000)}`
    : !capturedSection
    ? "SOURCE: not available — base your work on the description and design info."
    : ""
}

${pkgDoc ? `PROJECT PACKAGE.JSON:\n${pkgDoc.content.slice(0, 4_000)}` : ""}

${
  animationSignals
    ? `ANIMATION SIGNALS (rendered HTML of the source page):\n${animationSignals}`
    : ""
}`;

  const userContent =
    scrollScreenshots.length > 0
      ? [
          { type: "text" as const, text: sharedContext },
          ...scrollScreenshots.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : sharedContext;

  const animationGuidance = isAnimation
    ? " If images are provided in sequence, they represent the page scrolling from top to bottom: use them to infer the animation technique actually used (parallax, scroll-linked transform, progress/fill bar, sticky reveal...) and implement it idiomatically for the target stack (e.g. framer-motion or GSAP ScrollTrigger for React, IntersectionObserver or CSS scroll-timeline for vanilla), instead of producing a static placeholder."
    : "";

  if (mode === "code") {
    const structured = chatModel.withStructuredOutput(codeSchema, {
      name: "component_extraction",
    });

    const result = await structured.invoke([
      {
        role: "system",
        content: `You are a senior frontend engineer. Extract or reconstruct a UI component from an existing project, producing ready-to-use code in the requested stack.

Rules:
- Output in a SINGLE self-contained file, with no imports from the original project's files.
- If a SECTION CAPTURED FROM THE REAL DOM is present, it's the primary source: it's HTML/CSS actually rendered by the browser, not derived text. Faithfully reproduce its DOM structure, classes/styles, and hierarchy, adapting them to the target stack.
- If you only have the source code (git repo), adapt it faithfully to the target stack while preserving behavior and style.
- If you only have textual content (crawled page, no real capture available), RECONSTRUCT the component faithfully to the described structure, content, and design.
- Respect the original project's palette and fonts.
- Use clear placeholders where real content isn't available.
- Production-quality code: typed, accessible, responsive.
- IMPORTANT — known limitation: JS and animations (GSAP, WebGL, Three.js, scroll-hijacking...) aren't captured as source, only the static structure rendered at one instant. If the component has dynamic behavior, the "code" field must combine the captured real structure with a plausible reconstruction of the behavior, and the "notes" field MUST state this explicitly (e.g. "animation reconstructed by AI, not captured from source").${animationGuidance}`,
      },
      { role: "user", content: userContent },
    ]);

    await prisma.component.update({
      where: { id: component.id },
      data: { code: result.code, deps: result.deps },
    });

    return { mode: "code", ...result };
  }

  // mode === "prompt"
  const structured = chatModel.withStructuredOutput(promptSchema, {
    name: "component_prompt",
  });

  const result = await structured.invoke([
    {
      role: "system",
      content: `You are a prompt engineering expert for frontend development. Your job is to write a PROMPT that the user will paste into another LLM (Claude Code, Cursor, ChatGPT...) to recreate a UI component inside THEIR OWN existing project.

The prompt you produce must be self-contained and complete, and must include:
1. WHAT TO BUILD: a clear description of the component, structure, and element hierarchy.
2. VISUAL SPECS: palette (hex values), typography, spacing, responsive breakpoints — drawn from the provided design info.
3. BEHAVIOR: interactions, animations, states (hover, focus, loading...).
4. REAL CODE REFERENCES: this is REQUIRED, not optional — the prompt must include real pieces of HTML/CSS (not just a description in words). If a SECTION CAPTURED FROM THE REAL DOM is present, paste the most significant excerpts of its HTML and computed CSS into the prompt (in a code block, citing the source selector) as a faithful reference for the LLM that will use it. If you only have the repo's source, paste the most significant excerpts from there. If you have neither, state that and rely on the description.
5. ADAPTATION INSTRUCTIONS: instruct the LLM to integrate with the host project's conventions (design tokens, existing UI components, folder structure) instead of introducing hardcoded styles, asking the user for context if needed.

The prompt must be written in the indicated target stack, in English, well structured with clear sections. Do not write the COMPLETE component code: write the instructions, PLUS real code excerpts as reference, so an LLM can build it well in the destination context. If the component is of type animation, explicitly state that the dynamic behavior isn't capturable from static source and needs to be reconstructed.${animationGuidance}`,
    },
    { role: "user", content: userContent },
  ]);

  await prisma.component.update({
    where: { id: component.id },
    data: { prompt: result.prompt },
  });

  return { mode: "prompt", ...result };
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// ---------- "ast" origin (Phase 5, repo ingestion) ----------
// Unlike "ai"/"source" components, here code, props, and dependencies are
// already known by construction (deterministically extracted in Phase 2):
// "code" mode never calls the LLM, "prompt" mode uses it only for the prose
// (description/adaptation), not to invent code or props.

interface AstPropField {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
}

const astPromptProseSchema = z.object({
  description: z
    .string()
    .describe("What the component does and how it behaves, in English, for whoever will integrate it into another project"),
  adaptationNotes: z
    .string()
    .describe(
      "Instructions to integrate it into the host project's conventions (design tokens, existing UI components, folder structure) instead of introducing hardcoded styles"
    ),
});

async function extractAstComponent(
  component: Component & { site: Site },
  mode: ExtractionMode
): Promise<ExtractionResult> {
  const bundleFiles = safeParseJson<BundleFile[]>(component.bundleFiles, []);
  const npmDeps = safeParseJson<string[]>(component.npmDeps, []);
  const mainFile = bundleFiles.find((f) => f.path === component.filePath) ?? bundleFiles[0];

  if (mode === "code") {
    // No LLM call: the multi-file bundle is already complete, extracted
    // deterministically at ingestion time (Phase 2/3). The paywall lives in
    // the caller (route); here the real data is always returned.
    return {
      mode: "code",
      code: mainFile?.content ?? "",
      filename: mainFile ? lastSegment(mainFile.path) : suggestedFilename(component.name),
      deps: npmDeps,
      files: bundleFiles,
    };
  }

  if (component.prompt) {
    return { mode: "prompt", prompt: component.prompt };
  }

  const propsSchema = safeParseJson<AstPropField[]>(component.propsSchema, []);
  const snippet = mainFile
    ? (extractComponentSource(mainFile.content, component.name) ?? mainFile.content).slice(0, 3_000)
    : "";

  const structured = chatModel.withStructuredOutput(astPromptProseSchema, {
    name: "ast_component_prompt",
  });

  const result = await structured.invoke([
    {
      role: "system",
      content:
        "You are a prompt engineering expert for frontend development. You're given a REAL component (extracted from the source code of an actual project, not reconstructed): props and code snippet are real data, don't invent or rewrite them. Write only the behavior description and adaptation instructions for the host project: they'll be automatically merged with the real data to form the final prompt.",
    },
    {
      role: "user",
      content: `COMPONENT: ${component.name}\nREAL PROPS: ${JSON.stringify(propsSchema)}\nNPM DEPENDENCIES: ${JSON.stringify(npmDeps)}\nREAL CODE SNIPPET (${mainFile?.path ?? component.filePath}):\n${snippet}`,
    },
  ]);

  const propsLines = propsSchema.length
    ? propsSchema
        .map((p) => `- \`${p.name}\`${p.optional ? "?" : ""}: ${p.type}${p.defaultValue ? ` (default: ${p.defaultValue})` : ""}`)
        .join("\n")
    : "No props detected.";

  const prompt = `${result.description}

## Props
${propsLines}

## npm dependencies
${npmDeps.length ? npmDeps.join(", ") : "none beyond the project's base dependencies"}

## Real code snippet (${mainFile?.path ?? component.filePath})
\`\`\`tsx
${snippet}
\`\`\`

## Adaptation instructions
${result.adaptationNotes}`;

  await prisma.component.update({ where: { id: component.id }, data: { prompt } });

  return { mode: "prompt", prompt };
}

function safeParseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
