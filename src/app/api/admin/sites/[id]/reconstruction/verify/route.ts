import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { verifySection } from "@/lib/reconstruction/verify";

const bodySchema = z.object({
  file: z.string(),
  referenceFrame: z.string(),
});

// Fase 4: strumento di verifica a richiesta (mai automatico) — screenshot
// della sezione + confronto pixelmatch col frame scelto dall'admin.
// Sincrono (non fire-and-forget): l'admin aspetta il risultato di un singolo
// confronto, non una pipeline lunga.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json({ error: "Richiede l'ambiente locale" }, { status: 501 });
  }

  const { id } = await params;
  const site = await prisma.site.findUniqueOrThrow({ where: { id } });
  const { file, referenceFrame } = bodySchema.parse(await req.json());

  try {
    const result = await verifySection(site.slug, file, referenceFrame);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
