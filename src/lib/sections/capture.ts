import { prisma } from "@/lib/db";
import { captureSiteSections } from "@/lib/ingest/capture";
import { assertLocalOnly } from "@/lib/local-only";
import { labelSections } from "./label";
import { setCapturing } from "./progress";
import { generateMotionDescription } from "./motion";
import { Prisma, type Section } from "@/generated/prisma/client";

/**
 * Cattura la ground truth (Fase A): apre il sito, ne rileva le sezioni
 * (detection ricorsiva), inventaria i media reali, cattura la filmstrip di
 * scroll, le etichetta e crea le righe `Section` (status "captured" — non
 * ancora generabile: deve prima passare dall'HITL, vedi src/lib/sections/boundaries.ts
 * e la UI di annotazione). Rieseguire la cattura sostituisce la ground truth
 * precedente per il sito — non c'è nulla che dipenda da id di `Section`
 * stabili tra una cattura e l'altra.
 *
 * Riporta lo stato di avanzamento in `./progress` (in memoria) così il
 * pannello admin può fare polling e mostrare cosa sta succedendo invece di
 * uno spinner bloccante e muto.
 */
export async function captureGroundTruthSections(siteId: string): Promise<Section[]> {
  assertLocalOnly("La cattura delle sezioni");

  try {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    if (site.sourceType !== "url") {
      throw new Error('La cattura per-sezione richiede un sito di tipo "url"');
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
