import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { extractFrames } from "@/lib/reconstruction/frames";
import { setReconstructionError } from "@/lib/reconstruction/progress";

const bodySchema = z.object({
  source: z.enum(["human", "scripted"]).default("scripted"),
});

// Estrazione frame con scene detection (Fase 1b, ffmpeg): fire-and-forget,
// progresso via GET .../reconstruction/status.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Richiede l'ambiente locale" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const { source } = bodySchema.parse(await req.json().catch(() => ({})));

  setReconstructionError(site.slug, null);
  extractFrames(site.slug, source).catch((err) => {
    setReconstructionError(site.slug, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
