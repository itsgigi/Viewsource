import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Lista pubblica: solo siti published
export async function GET() {
  const sites = await prisma.site.findMany({
    where: { visibility: "published" },
    orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      sourceType: true,
      sourceUrl: true,
      screenshot: true,
      cover: true,
      techStack: true,
      featured: true,
      createdAt: true,
      _count: { select: { components: true } },
    },
  });
  return NextResponse.json(sites);
}
