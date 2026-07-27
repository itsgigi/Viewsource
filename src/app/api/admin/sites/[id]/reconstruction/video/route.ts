import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { saveHumanVideo } from "@/lib/reconstruction/video";

// Carica il video umano (Fase 1a): cattura hover/click/menu che uno script
// non saprebbe innescare. Salvato su disco sotto reconstructions/<slug>/,
// non su Blob — è materiale di lavoro locale, non un asset pubblico.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Richiede l'ambiente locale" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "File mancante" }, { status: 400 });
  }
  if (!file.type.startsWith("video/")) {
    return NextResponse.json({ error: "Solo video" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = await saveHumanVideo(site.slug, buffer, file.name);

  return NextResponse.json({ filename });
}
