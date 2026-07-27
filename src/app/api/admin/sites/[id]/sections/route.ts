import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Lista sezioni del sito, ordinate per diffScore desc (le peggiori in cima,
// dove lavorare) — il client può poi riordinare per `order`/nome/stato.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const sections = await prisma.section.findMany({
    where: { siteId: id },
    orderBy: [{ diffScore: "desc" }, { order: "asc" }],
    select: {
      id: true,
      order: true,
      name: true,
      sourceScreenshot: true,
      renderScreenshot: true,
      diffScore: true,
      status: true,
      updatedAt: true,
      boundsTop: true,
      boundsHeight: true,
    },
  });

  return NextResponse.json({ sections });
}
