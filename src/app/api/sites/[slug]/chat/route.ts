import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  question: z.string().min(1),
});

const COMING_SOON_ANSWER =
  "La chat AI sui progetti è in arrivo — stiamo misurando l'interesse. " +
  "Nel frattempo puoi esplorare i componenti e l'analisi.";

// Fake door test: registra l'intento e risponde con un messaggio fisso.
// Il RAG vero resta disponibile solo lato admin.
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
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
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
