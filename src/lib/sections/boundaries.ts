import sharp from "sharp";
import { prisma } from "@/lib/db";
import { assertLocalOnly } from "@/lib/local-only";
import { uploadImage, SECTION_VIEWPORT_WIDTH } from "@/lib/ingest/capture";
import { Prisma, type Section } from "@/generated/prisma/client";

/**
 * HITL boundary editor (spec Part 5a): merge/split/discard/rename operate
 * on REAL `Section` rows (not an ephemeral draft) — stable IDs are needed
 * to PATCH from the UI, and nothing downstream (annotation, generation)
 * can start until the boundaries are confirmed. Restricted to
 * status === "captured": before HITL annotation flips the status to
 * "pending", to avoid having to reconcile iterations/generatedCode of
 * already-generated sections.
 */

async function requireCapturedSection(sectionId: string): Promise<Section> {
  const section = await prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
  if (section.status !== "captured") {
    throw new Error(
      'Boundaries are only editable for sections in "captured" status (before HITL review).'
    );
  }
  return section;
}

async function fetchFullPageBuffer(siteId: string): Promise<Buffer> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  if (!site.sectionsFullPageScreenshot) {
    throw new Error("No full-page screenshot available for this site: re-run the capture.");
  }
  // Supports both Blob URLs and data: URIs (same pattern already used in pipeline.ts).
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

// Renumbers ALL remaining sections of the site, 0..N-1 by increasing
// boundsTop. Single pass: the (siteId, order) constraint is DEFERRABLE
// INITIALLY DEFERRED in the DB (see comment in schema.prisma) — Postgres
// validates uniqueness at transaction COMMIT, not on every single UPDATE,
// so intermediate reassignments that "swap" values don't violate anything.
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
  assertLocalOnly("Merging sections");
  if (idA === idB) throw new Error("You can't merge a section with itself");

  const [a, b] = await Promise.all([requireCapturedSection(idA), requireCapturedSection(idB)]);
  if (a.siteId !== siteId || b.siteId !== siteId) {
    throw new Error("The sections don't belong to this site");
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
        sourceHtml: `${first.sourceHtml}\n<!-- merged with section "${second.name}" -->\n${second.sourceHtml}`,
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
  assertLocalOnly("Splitting a section");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("The section doesn't belong to this site");

  const top = section.boundsTop ?? 0;
  const height = section.boundsHeight ?? 0;
  const bottom = top + height;
  const y = Math.round(atY);
  if (y <= top + 4 || y >= bottom - 4) {
    throw new Error("Cut point too close to the edge or outside the section's bounds");
  }

  const fullPage = await fetchFullPageBuffer(siteId);
  const [topShot, bottomShot] = await Promise.all([
    cropFromFullPage(fullPage, top, y - top, `split-${sectionId}-a.png`),
    cropFromFullPage(fullPage, y, bottom - y, `split-${sectionId}-b.png`),
  ]);

  // Note (known limitation, spec Part 5a): there's no way to know which DOM
  // children fall on which side of an arbitrary pixel cut — sourceHtml/Css
  // get duplicated on both halves. The cropped screenshot is still a
  // correct visual target for the generator regardless.
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
        order: 100_000, // temporary, immediately corrected by renumberOrder below
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
  assertLocalOnly("Discarding a section");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("The section doesn't belong to this site");

  await prisma.$transaction(async (tx) => {
    await tx.section.delete({ where: { id: sectionId } });
    await renumberOrder(tx, siteId);
  });
}

// Rename doesn't need a dedicated module: it reuses
// PATCH /api/admin/sections/[sectionId] with { name } (already handled there),
// no need for re-crop/reconciliation.

// Dragging an edge (top/bottom) in the boundary editor: resizes a
// "captured" section without touching others, re-cropping the screenshot
// from the shared fullPage.
export async function resizeSection(
  siteId: string,
  sectionId: string,
  boundsTop: number,
  boundsHeight: number
): Promise<void> {
  assertLocalOnly("Resizing a section");

  const section = await requireCapturedSection(sectionId);
  if (section.siteId !== siteId) throw new Error("The section doesn't belong to this site");
  if (boundsHeight <= 4) throw new Error("Section height too small");

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
