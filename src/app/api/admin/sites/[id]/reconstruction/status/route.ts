import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getReconstructionProgress } from "@/lib/reconstruction/progress";

// Stato "in corso" delle operazioni dello studio (in memoria, locale). Il
// pannello admin fa polling qui, stesso pattern di .../sections/status.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  return NextResponse.json(getReconstructionProgress(site.slug));
}
