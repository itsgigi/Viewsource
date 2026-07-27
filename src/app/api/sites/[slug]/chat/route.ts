import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  question: z.string().min(1),
});

const COMING_SOON_ANSWER =
  "AI chat about projects is coming soon — we're gauging interest. " +
  "In the meantime you can explore the components and the analysis.";

// Fake door test: logs the intent and replies with a fixed message.
// The real RAG stays available admin-side only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const site = await prisma.site.findUnique({
    where: { slug },
    select: { id: true, visibility: true },
  });
  if (!site || site.visibility !== "published") {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await prisma.chatIntent.create({
    data: { siteId: site.id, question: parsed.data.question },
  });

  return NextResponse.json({ answer: COMING_SOON_ANSWER, sources: [] });
}
