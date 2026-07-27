import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { framesDir } from "@/lib/reconstruction/paths";

// Serve un frame estratto (Fase 1b) — vive su disco sotto
// reconstructions/<slug>/material/frames/, fuori da /public: la UI admin lo
// legge da qui invece che come asset statico Next.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const filename = decodeURIComponent(file);

  // Difesa minima contro path traversal: solo nomi file semplici.
  if (filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "Nome file non valido" }, { status: 400 });
  }

  try {
    const buffer = await fs.readFile(path.join(framesDir(site.slug), filename));
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "Frame non trovato" }, { status: 404 });
  }
}
