import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";

// Dettaglio pubblico per slug: solo siti published (i draft restano
// visibili all'admin loggato, così può fare preview)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const site = await prisma.site.findUnique({
    where: { slug },
    include: {
      components: { orderBy: { name: "asc" } },
      documents: {
        select: { id: true, path: true, kind: true, summary: true },
        orderBy: { path: "asc" },
      },
    },
  });

  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(
      req.cookies.get(ADMIN_COOKIE)?.value
    );
    if (!isAdmin) {
      return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
    }
  }

  return NextResponse.json(site);
}
