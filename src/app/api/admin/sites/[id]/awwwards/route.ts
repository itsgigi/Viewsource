import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { fetchAwwwardsData } from "@/lib/ingest/awwwards";

const bodySchema = z.object({
  awwwardsUrl: z.string().url().nullable().optional(),
});

// On-demand Awwwards fetch/refresh, independent of the ingestion pipeline.
// Originally only "url"-sourced sites got this at ingestion time
// (runUrlIngestionPipeline); "git"-sourced sites have no live URL to
// auto-discover from (sourceUrl is the repo, not the deployed site), so
// this route lets the admin attach a manual Awwwards URL to any site
// (git or url) after the fact and fetch it directly — scrapeAwwwardsPage
// doesn't need host verification when the URL is given explicitly.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  const awwwardsUrl =
    parsed.data.awwwardsUrl !== undefined ? parsed.data.awwwardsUrl : site.awwwardsUrl;

  const referenceUrl = site.deployedUrl ?? site.sourceUrl;
  const awwwards = await fetchAwwwardsData(referenceUrl, awwwardsUrl);

  if (!awwwards) {
    return NextResponse.json(
      { error: awwwardsUrl ? "Could not fetch that Awwwards page" : "No Awwwards page found" },
      { status: 404 }
    );
  }

  const updated = await prisma.site.update({
    where: { id },
    data: { awwwardsUrl, awwwards: awwwards as unknown as Prisma.InputJsonValue },
  });

  return NextResponse.json(updated);
}
