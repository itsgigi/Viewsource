import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { readSpec, writeSpec, updateMeta } from "@/lib/reconstruction/paths";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const content = await readSpec(site.slug);
  return NextResponse.json({ content });
}

const bodySchema = z.object({ content: z.string() });

// Salva la SPEC.md così com'è (markdown libero, nessun re-parsing): l'admin
// la corregge/conferma, non deve scriverla da zero. "confirm" bumpa la fase.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const { content } = bodySchema.parse(await req.json());

  await writeSpec(site.slug, content);
  const meta = await updateMeta(site.slug, (m) => {
    if (m.phase === "collecting") m.phase = "analyzed";
  });

  if (site.reconstructionStatus !== meta.phase) {
    await prisma.site.update({ where: { id }, data: { reconstructionStatus: meta.phase } });
  }

  return NextResponse.json({ ok: true });
}
