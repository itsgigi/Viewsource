import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  visibility: z.enum(["draft", "published"]).optional(),
  featured: z.boolean().optional(),
  cover: z.string().url().nullable().optional(),
  price: z.number().int().positive().nullable().optional(), // centesimi; null = non in vendita
  stripePriceId: z.string().nullable().optional(),
  description: z.string().nullable().optional(), // AI Analysis, editabile a mano dall'admin
  deployedUrl: z.string().url().nullable().optional(), // per iframe preview + fallback screenshot
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const site = await prisma.site.findUnique({
    where: { id },
    include: {
      _count: { select: { sections: true } },
      // Admin vede TUTTI i componenti (anche excluded): deve poterli
      // ripromuovere, a differenza della GET pubblica che li filtra via.
      components: { orderBy: [{ rank: "asc" }, { name: "asc" }] },
    },
  });

  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  return NextResponse.json(site);
}

// Publish/unpublish (e featured) dal pannello admin
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const site = await prisma.site
    .update({ where: { id }, data: parsed.data })
    .catch(() => null);

  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  return NextResponse.json(site);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // onDelete: Cascade nello schema elimina anche Document, Component e Source
  await prisma.site.delete({ where: { id } }).catch(() => null);

  return NextResponse.json({ ok: true });
}
