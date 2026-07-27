import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { regenerateWithFeedback } from "@/lib/sections/pipeline";

const bodySchema = z.object({ feedback: z.string().min(1) });

// Rigenera SOLO questa sezione con il feedback admin: un'unica iterazione,
// nessun loop automatico. Gira SOLO in locale.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json(
      { error: 'La rigenerazione richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.' },
      { status: 501 }
    );
  }

  const { sectionId } = await params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const section = await regenerateWithFeedback(sectionId, parsed.data.feedback);
    return NextResponse.json({
      ...section,
      iterations: section.iterations ? JSON.parse(section.iterations) : [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
