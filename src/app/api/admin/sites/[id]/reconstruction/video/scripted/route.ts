import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { captureScriptedVideo } from "@/lib/reconstruction/video";
import { setReconstructionError } from "@/lib/reconstruction/progress";

// Video scriptato (Fase 1a, Playwright): fire-and-forget, progresso via
// GET .../reconstruction/status.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Richiede l'ambiente locale" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  setReconstructionError(site.slug, null);
  captureScriptedVideo(site.slug, site.sourceUrl).catch((err) => {
    setReconstructionError(site.slug, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
