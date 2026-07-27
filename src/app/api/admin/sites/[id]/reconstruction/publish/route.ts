import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { publishReconstruction } from "@/lib/reconstruction/publish";
import { setReconstructionError } from "@/lib/reconstruction/progress";

// Fase 6: idempotente, ri-eseguibile. Sincrono (l'admin aspetta l'esito
// diretto di un publish, non è una pipeline lunga come la generazione).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Richiede l'ambiente locale" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  try {
    setReconstructionError(site.slug, null);
    const summary = await publishReconstruction(site.slug, site.id);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setReconstructionError(site.slug, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
