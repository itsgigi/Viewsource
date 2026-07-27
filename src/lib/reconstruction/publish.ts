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
      "Prompt completo da incollare in un LLM per ricreare la sezione: descrizione + specifiche visive/comportamentali + SNIPPET PARZIALI di codice come riferimento (mai il file completo)."
    ),
});

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function generatePrompt(sectionName: string, code: string, specMd: string | null): Promise<string> {
  const snippet = code.length > 1_200 ? `${code.slice(0, 1_200)}\n/* ...(troncato)... */` : code;

  const result = await promptModel.withStructuredOutput(promptSchema, { name: "section_prompt" }).invoke([
    {
      role: "system",
      content:
        "Sei un esperto di prompt engineering per frontend. Scrivi un prompt autonomo (in italiano) che un utente incollerà in un altro LLM (Claude Code, Cursor, ChatGPT...) per ricreare QUESTA sezione UI in un suo progetto. Includi: cosa costruire, specifiche visive/comportamentali tratte dal contesto SPEC fornito, e SNIPPET PARZIALI di codice reale come riferimento (citali in un blocco di codice) — NON il codice completo, che è a pagamento. Istruisci il modello a integrarsi con le convenzioni del progetto ospite.",
    },
    {
      role: "user",
      content: `SEZIONE: ${sectionName}\n\n${specMd ? `SPEC (contesto del sito):\n${specMd.slice(0, 6_000)}\n\n` : ""}SNIPPET PARZIALE DEL CODICE REALE:\n${snippet}`,
    },
  ]);

  return result.prompt;
}

export interface SectionPublishState {
  file: string;
  name: string;
  approved: boolean;
  published: boolean; // esiste già una riga Section per questo filePath
  aligned: boolean; // hash del file corrente == contentHash pubblicato (sempre true se non ancora pubblicato)
}

/**
 * Confronta i file correnti in sections/ con l'ultimo contentHash pubblicato
 * su Section — usato dalla route admin per mostrare "allineato" / "modifiche
 * non pubblicate" per ciascuna sezione (requisito di modificabilità
 * permanente). Non richiede assertLocalOnly: legge solo file+DB.
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
  skipped: number; // invariate, non rigenerate
}

/**
 * Fase 6 — pubblicazione: idempotente e ri-eseguibile. Legge i file delle
 * sezioni approvate (meta.json), confronta l'hash col contentHash già
 * pubblicato (chiave logica: filePath), rigenera screenshot+prompt SOLO se
 * cambiato, upserta i record Section (mai duplica), rimuove le righe le cui
 * sezioni non sono più approvate/presenti.
 */
export async function publishReconstruction(slug: string, siteId: string): Promise<PublishSummary> {
  assertLocalOnly("La pubblicazione");
  setRunning(slug, { stage: "publishing" });

  try {
    const meta = await readMeta(slug);
    const specMd = await readSpec(slug);
    const approved = meta.sections.filter((s) => s.approved);

    if (approved.length === 0) {
      throw new Error("Nessuna sezione approvata da pubblicare");
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

    // Rimuove le righe pubblicate in precedenza le cui sezioni non sono più
    // approvate/presenti (criterio 10: rimuovere una sezione + re-publish).
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

        // Cambiata o nuova: rigenera screenshot (rig Playwright+Vite dello
        // studio) e prompt gratuito (LLM, snippet parziali).
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
