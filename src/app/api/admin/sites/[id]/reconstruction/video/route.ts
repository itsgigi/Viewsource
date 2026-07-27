import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { saveHumanVideo } from "@/lib/reconstruction/video";

// Uploads the human video (Phase 1a): captures hover/click/menu that a
// script wouldn't know how to trigger. Saved to disk under
// reconstructions/<slug>/, not to Blob — it's local working material, not
// a public asset.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Requires the local environment" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (!file.type.startsWith("video/")) {
    return NextResponse.json({ error: "Video only" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = await saveHumanVideo(site.slug, buffer, file.name);

  return NextResponse.json({ filename });
}
