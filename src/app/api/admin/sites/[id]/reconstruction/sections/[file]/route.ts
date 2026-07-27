import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { updateMeta } from "@/lib/reconstruction/paths";

const bodySchema = z.object({
  approved: z.boolean().optional(),
  referenceFrame: z.string().nullable().optional(),
});

// Fase 5 (approvazione) + assegnazione del frame di riferimento per Verify
// (Fase 4): entrambe vivono in meta.json, non nel DB — i record Section non
// esistono finché non si pubblica.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const patch = bodySchema.parse(await req.json());
  const filename = decodeURIComponent(file);

  const meta = await updateMeta(site.slug, (m) => {
    const section = m.sections.find((s) => s.file === filename);
    if (!section) throw new Error(`Sezione "${filename}" non trovata in meta.json`);
    if (patch.approved !== undefined) section.approved = patch.approved;
    if (patch.referenceFrame !== undefined) section.referenceFrame = patch.referenceFrame;
  });

  return NextResponse.json({ section: meta.sections.find((s) => s.file === filename) });
}
