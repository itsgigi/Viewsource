import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { ensureStudioServer } from "@/lib/reconstruction/studio";

// Assicura il Vite dev server dello studio per questo sito e ne restituisce
// l'URL locale, per l'<iframe> di preview live (Fase 4) nella route admin.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Requires the local environment" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  const { url } = await ensureStudioServer(site.slug);
  return NextResponse.json({ url });
}
