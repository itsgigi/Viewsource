import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { runIngestion } from "@/lib/ingest";
import { uniqueSlug } from "@/lib/slug";

const createSchema = z.object({
  name: z.string().min(1),
  sourceType: z.enum(["url", "git"]),
  sourceUrl: z.string().url(),
  awwwardsUrl: z.string().url().optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const slug = await uniqueSlug(parsed.data.name);
  const site = await prisma.site.create({ data: { ...parsed.data, slug } });

  // Fire-and-forget: la risposta parte subito, l'ingestion gira in background.
  // La UI fa polling su GET /api/admin/sites leggendo site.status.
  runIngestion(site.id).catch(console.error);

  return NextResponse.json(site, { status: 201 });
}

// Lista completa (draft + published) + conteggio ChatIntent per il fake door
export async function GET() {
  const [sites, intentsBySite, intentTotal] = await Promise.all([
    prisma.site.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { documents: true, components: true } } },
    }),
    prisma.chatIntent.groupBy({ by: ["siteId"], _count: { _all: true } }),
    prisma.chatIntent.count(),
  ]);

  const chatIntentsBySite = Object.fromEntries(
    intentsBySite.map((g) => [g.siteId, g._count._all])
  );

  return NextResponse.json({
    sites: sites.map((s) => ({
      ...s,
      chatIntents: chatIntentsBySite[s.id] ?? 0,
    })),
    chatIntentTotal: intentTotal,
  });
}
