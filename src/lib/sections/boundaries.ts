import sharp from "sharp";
import { prisma } from "@/lib/db";
import { assertLocalOnly } from "@/lib/local-only";
import { uploadImage, SECTION_VIEWPORT_WIDTH } from "@/lib/ingest/capture";
import { Prisma, type Section } from "@/generated/prisma/client";

/**
 * Boundary editor HITL (spec Parte 5a): merge/split/discard/rename operano
 * su righe `Section` REALI (non un draft ephemero) — servono ID stabili da
 * PATCHare dalla UI, e comunque nulla a valle (annotazione, generazione) può
 * iniziare finché i confini non sono confermati. Ristretti a
 * status === "captured": prima che l'HITL annotation flippi lo stato a
 * "pending", per evitare di dover riconciliare iterations/generatedCode di
 * sezioni già generate.
 */

async function requireCapturedSection(sectionId: string): Promise<Section> {
  const section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
  if (section.status !== "captured") {
    throw new Error(
      'I confini sono modificabili solo per sezioni in stato "captured" (prima della revisione HITL).'
    );
  }
  return section;
}

async function fetchFullPageBuffer(siteId: string): Promise<Buffer> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  if (!site.sectionsFullPageScreenshot) {
    throw new Error("Nessuno screenshot full-page disponibile per questo sito: rilancia la cattura.");
  }
  // Supporta sia URL Blob che data: URI (stesso pattern già usato in pipeline.ts).
  const res = await fetch(site.sectionsFullPageScreenshot);
  return Buffer.from(await res.arrayBuffer());
}

async function cropFromFullPage(
  fullPageBuffer: Buffer,
  top: number,
  height: number,
  filename: string
): Promise<string> {
  const cropped = await sharp(fullPageBuffer)
    .extract({
      left: 0,
      top: Math.max(0, Math.round(top)),
      width: SECTION_VIEWPORT_WIDTH,
      height: Math.max(1, Math.round(height)),
    })
    .png()
    .toBuffer();
  return uploadImage(cropped, filename);
}

function mergeJsonArrays(a: unknown, b: unknown): Prisma.InputJsonValue {
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])] as Prisma.InputJsonValue;
}

// Ri-numera TUTTE le sezioni rimaste del sito, 0..N-1 per boundsTop
// crescente. Un pass solo: il vincolo (siteId, order) è DEFERRABLE INITIALLY
// DEFERRED in DB (vedi commento in schema.prisma) — Postgres valida
// l'unicità al COMMIT della transazione, non ad ogni singola UPDATE, quindi
// riassegnazioni intermedie che si "scambiano" valori non violano nulla.
async function renumberOrder(tx: Prisma.TransactionClient, siteId: string): Promise<void> {
  const remaining = await tx.section.findMany({
    where: { siteId },
    orderBy: { boundsTop: "asc" },
  });
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].order !== i) {
      await tx.section.update({ where: { id: remaining[i].id }, data: { order: i } });
    }
  }
}

export async function mergeSections(siteId: string, idA: string, idB: string): Promise<void> {
  assertLocalOnly("L'unione di sezioni");
  if (idA === idB) throw new Error("Non puoi unire una sezione con se stessa");

  const [a, b] = await Promise.all([requireCapturedSection(idA), requireCapturedSection(idB)]);
  if (a.siteId !== siteId || b.siteId !== siteId) {
    throw new Error("Le sezioni non appartengono a questo sito");
  }

  const topA = a.boundsTop ?? 0;
  const topB = b.boundsTop ?? 0;
  const top = Math.min(topA, topB);
  const bottom = Math.max(topA + (a.boundsHeight ?? 0), topB + (b.boundsHeight ?? 0));

  const fullPage = await fetchFullPageBuffer(siteId);
  const screenshot = await cropFromFullPage(fullPage, top, bottom - top, `merge-${a.id}-${b.id}.png`);

  const [first, second] = a.order <= b.order ? [a, b] : [b, a];

  await prisma.$transaction(async (tx) => {
    await tx.section.update({
      where: { id: first.id },
      data: {
        boundsTop: top,
        boundsHeight: bottom - top,
        sourceHtml: `${first.sourceHtml}\n<!-- unita con sezione "${second.name}" -->\n${second.sourceHtml}`,
        sourceCss: [first.sourceCss, second.sourceCss].filter(Boolean).join("\n") || null,
        sourceScreenshot: screenshot,
        mediaAssets: mergeJsonArrays(first.mediaAssets, second.mediaAssets),
        filmstrip: mergeJsonArrays(first.filmstrip, second.filmstrip),
        motionHints: mergeJsonArrays(first.motionHints, second.motionHints),
      },
    });
    await tx.section.delete({ where: { id: second.id } });
    await renumberOrder(tx, siteId);
  });
}

export async function splitSection(siteId: string, sectionId: string, atY: number): Promise<void> {
  assertLocalOnly("La divisione di una sezione");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("La sezione non appartiene a questo sito");

  const top = section.boundsTop ?? 0;
  const height = section.boundsHeight ?? 0;
  const bottom = top + height;
  const y = Math.round(atY);
  if (y <= top + 4 || y >= bottom - 4) {
    throw new Error("Punto di taglio troppo vicino al bordo o fuori dai bounds della sezione");
  }

  const fullPage = await fetchFullPageBuffer(siteId);
  const [topShot, bottomShot] = await Promise.all([
    cropFromFullPage(fullPage, top, y - top, `split-${sectionId}-a.png`),
    cropFromFullPage(fullPage, y, bottom - y, `split-${sectionId}-b.png`),
  ]);

  // Nota (limite noto, spec Parte 5a): non c'è modo di sapere quali figli DOM
  // cadono da un lato o l'altro di un taglio pixel arbitrario — sourceHtml/Css
  // vengono duplicati su entrambe le metà. Lo screenshot ritagliato resta
  // comunque un target visivo corretto per il generatore.
  await prisma.$transaction(async (tx) => {
    await tx.section.update({
      where: { id: section.id },
      data: {
        boundsTop: top,
        boundsHeight: y - top,
        sourceScreenshot: topShot,
        name: `${section.name} (1)`,
      },
    });
    await tx.section.create({
      data: {
        siteId,
        order: 100_000, // temporaneo, corretto subito da renumberOrder sotto
        name: `${section.name} (2)`,
        sourceHtml: section.sourceHtml,
        sourceCss: section.sourceCss,
        sourceScreenshot: bottomShot,
        boundsTop: y,
        boundsHeight: bottom - y,
        mediaAssets: (section.mediaAssets as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        filmstrip: (section.filmstrip as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        motionHints: (section.motionHints as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        detectedLibs: (section.detectedLibs as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        status: "captured",
      },
    });
    await renumberOrder(tx, siteId);
  });
}

export async function discardSection(siteId: string, sectionId: string): Promise<void> {
  assertLocalOnly("Lo scarto di una sezione");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("La sezione non appartiene a questo sito");

  await prisma.$transaction(async (tx) => {
    await tx.section.delete({ where: { id: sectionId } });
    await renumberOrder(tx, siteId);
  });
}

// Il rename non ha bisogno di un modulo dedicato: riusa
// PATCH /api/admin/sections/[sectionId] con { name } (già gestito lì),
// nessuna necessità di re-crop/riconciliazione.

// Drag di un bordo (alto/basso) nel boundary editor: ridimensiona una
// sezione "captured" senza toccarne altre, ri-ritagliando lo screenshot dal
// fullPage condiviso.
export async function resizeSection(
  siteId: string,
  sectionId: string,
  boundsTop: number,
  boundsHeight: number
): Promise<void> {
  assertLocalOnly("Il ridimensionamento di una sezione");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("La sezione non appartiene a questo sito");
  if (boundsHeight <= 4) throw new Error("Altezza sezione troppo piccola");

  const fullPage = await fetchFullPageBuffer(siteId);
  const screenshot = await cropFromFullPage(
    fullPage,
    boundsTop,
    boundsHeight,
    `resize-${sectionId}.png`
  );

  await prisma.$transaction(async (tx) => {
    await tx.section.update({
      where: { id: sectionId },
      data: { boundsTop: Math.round(boundsTop), boundsHeight: Math.round(boundsHeight), sourceScreenshot: screenshot },
    });
    await renumberOrder(tx, siteId);
  });
}
