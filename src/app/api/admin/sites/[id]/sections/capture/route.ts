import { NextRequest, NextResponse } from "next/server";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { captureGroundTruthSections } from "@/lib/sections/capture";
import { setError } from "@/lib/sections/progress";

// Cattura ground truth (Fase A): gira SOLO in locale (npm run dev).
// Fire-and-forget: la risposta parte subito (202), il progresso si legge da
// GET .../sections/status (polling lato admin).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json(
      { error: 'La cattura delle sezioni richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.' },
      { status: 501 }
    );
  }

  const { id } = await params;

  setError(id, null);
  captureGroundTruthSections(id).catch((err) => {
    setError(id, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ started: true }, { status: 202 });
}
