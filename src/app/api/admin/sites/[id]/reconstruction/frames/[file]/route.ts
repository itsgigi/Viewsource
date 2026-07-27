import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { framesDir } from "@/lib/reconstruction/paths";

// Serves an extracted frame (Phase 1b) — lives on disk under
// reconstructions/<slug>/material/frames/, outside /public: the admin UI
// reads it from here instead of as a static Next asset.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const filename = decodeURIComponent(file);

  // Minimal defense against path traversal: only simple filenames.
  if (filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  try {
    const buffer = await fs.readFile(path.join(framesDir(site.slug), filename));
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "Frame not found" }, { status: 404 });
  }
}
