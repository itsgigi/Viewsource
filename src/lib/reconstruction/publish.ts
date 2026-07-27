import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "@/lib/db";
import { assertLocalOnly } from "@/lib/local-only";
import { readMeta, readSpec, sectionsDir } from "./paths";
import { renderStudio } from "./studio";
import { uploadImage } from "@/lib/ingest/capture";
import { setRunning } from "./progress";

const promptModel = new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", temperature: 0.3 });

const promptSchema = z.object({
  prompt: z
    .string()
    .describe(
      "Complete prompt to paste into an LLM to recreate the section: description + visual/behavioral specs + PARTIAL code SNIPPETS as reference (never the complete file)."
    ),
});

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function generatePrompt(sectionName: string, code: string, specMd: string | null): Promise<string> {
  const snippet = code.length > 1_200 ? `${code.slice(0, 1_200)}\n/* ...(truncated)... */` : code;

  const result = await promptModel.withStructuredOutput(promptSchema, { name: "section_prompt" }).invoke([
    {
      role: "system",
      content:
        "You are a prompt engineering expert for frontend development. Write a self-contained prompt (in English) that a user will paste into another LLM (Claude Code, Cursor, ChatGPT...) to recreate THIS UI section in their own project. Include: what to build, visual/behavioral specs drawn from the provided SPEC context, and PARTIAL real code SNIPPETS as reference (cite them in a code block) — NOT the complete code, which is paid. Instruct the model to integrate with the host project's conventions.",
    },
    {
      role: "user",
      content: `SECTION: ${sectionName}\n\n${specMd ? `SPEC (site context):\n${specMd.slice(0, 6_000)}\n\n` : ""}PARTIAL REAL CODE SNIPPET:\n${snippet}`,
    },
  ]);

  return result.prompt;
}

export interface SectionPublishState {
  file: string;
  name: string;
  approved: boolean;
  published: boolean; // a Section row already exists for this filePath
  aligned: boolean; // current file's hash == published contentHash (always true if not published yet)
}

/**
 * Compares the current files in sections/ against the last contentHash
 * published on Section — used by the admin route to show "aligned" /
 * "unpublished changes" for each section (permanent-editability
 * requirement). Doesn't require assertLocalOnly: only reads file+DB.
 */
export async function getSectionPublishState(slug: string, siteId: string): Promise<SectionPublishState[]> {
  const meta = await readMeta(slug);
  const existingRows = await prisma.section.findMany({ where: { siteId, filePath: { not: null } } });
  const existingByFilePath = new Map(existingRows.map((r) => [r.filePath!, r]));

  return Promise.all(
    meta.sections.map(async (s) => {
      const filePath = `reconstructions/${slug}/sections/${s.file}`;
      const existing = existingByFilePath.get(filePath);
      if (!existing) {
        return { file: s.file, name: s.name, approved: s.approved, published: false, aligned: true };
      }
      const code = await fs.readFile(path.join(sectionsDir(slug), s.file), "utf-8").catch(() => null);
      const aligned = code !== null && hashContent(code) === existing.contentHash;
      return { file: s.file, name: s.name, approved: s.approved, published: true, aligned };
    })
  );
}

export interface PublishSummary {
  created: number;
  updated: number;
  removed: number;
  skipped: number; // unchanged, not regenerated
}

/**
 * Phase 6 — publishing: idempotent and re-runnable. Reads the approved
 * sections' files (meta.json), compares the hash against the already
 * published contentHash (logical key: filePath), regenerates
 * screenshot+prompt ONLY if changed, upserts the Section records (never
 * duplicates), removes rows whose sections are no longer approved/present.
 */
export async function publishReconstruction(slug: string, siteId: string): Promise<PublishSummary> {
  assertLocalOnly("Publishing");
  setRunning(slug, { stage: "publishing" });

  try {
    const meta = await readMeta(slug);
    const specMd = await readSpec(slug);
    const approved = meta.sections.filter((s) => s.approved);

    if (approved.length === 0) {
      throw new Error("No approved sections to publish");
    }

    const existingRows = await prisma.section.findMany({
      where: { siteId, filePath: { not: null } },
    });
    const existingByFilePath = new Map(existingRows.map((r) => [r.filePath!, r]));

    const approvedFilePaths = new Set(
      approved.map((s) => `reconstructions/${slug}/sections/${s.file}`)
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Removes previously published rows whose sections are no longer
    // approved/present (criterion 10: remove a section + re-publish).
    const toRemove = existingRows.filter((r) => !approvedFilePaths.has(r.filePath!));
    const removed = toRemove.length;

    await prisma.$transaction(async (tx) => {
      if (toRemove.length > 0) {
        await tx.section.deleteMany({ where: { id: { in: toRemove.map((r) => r.id) } } });
      }

      for (let i = 0; i < approved.length; i++) {
        const s = approved[i];
        const filePath = `reconstructions/${slug}/sections/${s.file}`;
        const absPath = path.join(sectionsDir(slug), s.file);
        const code = await fs.readFile(absPath, "utf-8");
        const contentHash = hashContent(code);

        const existing = existingByFilePath.get(filePath);
        const unchanged = existing && existing.contentHash === contentHash;

        if (unchanged) {
          skipped++;
          if (existing.order !== i || existing.name !== s.name) {
            await tx.section.update({
              where: { id: existing.id },
              data: { order: i, name: s.name },
            });
          }
          continue;
        }

        // Changed or new: regenerate screenshot (Playwright+Vite studio rig)
        // and free prompt (LLM, partial snippets).
        const renderedBuffer = await renderStudio(slug, s.file);
        const renderScreenshot = await uploadImage(
          renderedBuffer,
          `reconstructions/${slug}-${s.file}-published.png`
        );
        const prompt = await generatePrompt(s.name, code, specMd);

        if (existing) {
          await tx.section.update({
            where: { id: existing.id },
            data: {
              order: i,
              name: s.name,
              generatedCode: code,
              renderScreenshot,
              prompt,
              contentHash,
              publishedAt: new Date(),
              status: "published",
            },
          });
          updated++;
        } else {
          await tx.section.create({
            data: {
              siteId,
              order: i,
              name: s.name,
              filePath,
              generatedCode: code,
              renderScreenshot,
              prompt,
              contentHash,
              publishedAt: new Date(),
              status: "published",
            },
          });
          created++;
        }
      }
    });

    await prisma.site.update({ where: { id: siteId }, data: { reconstructionStatus: "published" } });

    return { created, updated, removed, skipped };
  } finally {
    setRunning(slug, null);
  }
}
