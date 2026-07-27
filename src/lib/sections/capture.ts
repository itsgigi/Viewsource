import { prisma } from "@/lib/db";
import { captureSiteSections } from "@/lib/ingest/capture";
import { assertLocalOnly } from "@/lib/local-only";
import { labelSections } from "./label";
import { setCapturing } from "./progress";
import { generateMotionDescription } from "./motion";
import { Prisma, type Section } from "@/generated/prisma/client";

/**
 * Captures the ground truth (Phase A): opens the site, detects its
 * sections (recursive detection), inventories the real media, captures the
 * scroll filmstrip, labels them, and creates the `Section` rows (status
 * "captured" — not yet generatable: it must first go through HITL, see
 * src/lib/sections/boundaries.ts and the annotation UI). Re-running the
 * capture replaces the site's previous ground truth — nothing depends on
 * `Section` IDs being stable across captures.
 *
 * Reports progress in `./progress` (in memory) so the admin panel can poll
 * and show what's happening instead of a blocking, silent spinner.
 */
export async function captureGroundTruthSections(siteId: string): Promise<Section[]> {
  assertLocalOnly("Section capture");

  try {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    if (site.sourceType !== "url") {
      throw new Error('Per-section capture requires a site of type "url"');
    }

    const { sections: groundTruth, fullPageScreenshot } = await captureSiteSections(
      site.sourceUrl,
      (progress) => {
        setCapturing(siteId, progress);
      }
    );
    if (groundTruth.length === 0) {
      throw new Error("Nessuna sezione rilevata sulla pagina");
    }

    setCapturing(siteId, { stage: "labeling" });
    const names = await labelSections(groundTruth);

    setCapturing(siteId, { stage: "saving", found: 0, total: groundTruth.length });
    const created = await prisma.$transaction(async (tx) => {
      await tx.section.deleteMany({ where: { siteId } });
      await tx.site.update({
        where: { id: siteId },
        data: { sectionsFullPageScreenshot: fullPageScreenshot },
      });

      const rows: Section[] = [];
      for (let i = 0; i < groundTruth.length; i++) {
        const s = groundTruth[i];
        rows.push(
          await tx.section.create({
            data: {
              siteId,
              order: i,
              name: names[i],
              sourceHtml: s.html,
              sourceCss: s.css,
              sourceScreenshot: s.screenshot,
              boundsTop: s.boundsTop,
              boundsHeight: s.boundsHeight,
              mediaAssets: s.mediaAssets as unknown as Prisma.InputJsonValue,
              filmstrip: s.filmstrip as unknown as Prisma.InputJsonValue,
              motionHints: s.motionHints as unknown as Prisma.InputJsonValue,
              detectedLibs: s.detectedLibs as unknown as Prisma.InputJsonValue,
              status: "captured",
            },
          })
        );
      }
      return rows;
    });

    // motionDescription (Parte 4): automatica, subito dopo la cattura, MAI
    // richiesta all'admin di scriverla da zero — la rivede/corregge dopo
    // (Fase 5c). Una sezione singola che fallisce non blocca le altre: log e
    // avanti (la sezione resta senza motionDescription, editabile a mano).
    for (let i = 0; i < created.length; i++) {
      setCapturing(siteId, { stage: "saving", found: i, total: created.length });
      try {
        const description = await generateMotionDescription(created[i]);
        await prisma.section.update({
          where: { id: created[i].id },
          data: { motionDescription: description },
        });
      } catch (err) {
        console.error(`motionDescription fallita per sezione "${created[i].name}":`, err);
      }
    }

    return created;
  } finally {
    setCapturing(siteId, null);
  }
}
