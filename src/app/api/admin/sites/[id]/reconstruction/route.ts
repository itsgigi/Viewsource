import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { ensureScaffold, reconstructionExists, readMeta } from "@/lib/reconstruction/paths";
import { getSectionPublishState } from "@/lib/reconstruction/publish";

// Crea (idempotente) o legge lo scaffold /reconstructions/<slug>/ per il sito.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json(
      { error: 'Lo studio di ricostruzione richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.' },
      { status: 501 }
    );
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  const meta = await ensureScaffold(site.slug, site.id, site.sourceUrl);

  if (!site.reconstructionStatus) {
    await prisma.site.update({ where: { id }, data: { reconstructionStatus: meta.phase } });
  }

  return NextResponse.json({ meta });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  if (!(await reconstructionExists(site.slug))) {
    return NextResponse.json({ meta: null });
  }

  const meta = await readMeta(site.slug);
  const publishState = await getSectionPublishState(site.slug, site.id).catch(() => []);
  return NextResponse.json({ meta, publishState });
}
