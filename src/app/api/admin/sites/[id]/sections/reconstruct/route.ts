import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { runAutoReconstructionLoop } from "@/lib/sections/pipeline";
import { setReconstructing, setError } from "@/lib/sections/progress";

// Ricostruzione automatica (Fase B/C/D) di tutte le sezioni non ancora
// approvate del sito, in sequenza (il mini-renderer è un singleton di
// processo). Gira SOLO in locale. Fire-and-forget: la risposta parte subito
// (202), il progresso si legge da GET .../sections/status (polling) e
// dall'aggiornamento in tempo reale delle righe in GET .../sections.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json(
      { error: 'La ricostruzione richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.' },
      { status: 501 }
    );
  }

  const { id } = await params;

  const sections = await prisma.section.findMany({
    // "captured" = non ancora passata dall'HITL (confini/annotazione/motion
    // review): non generabile finché l'admin non la segna "pending".
    where: { siteId: id, status: { notIn: ["approved", "captured"] } },
    orderBy: { order: "asc" },
  });

  setError(id, null);
  setReconstructing(id, { total: sections.length, done: 0, current: sections[0]?.name ?? null });

  (async () => {
    let done = 0;
    for (const section of sections) {
      setReconstructing(id, { total: sections.length, done, current: section.name });
      try {
        await runAutoReconstructionLoop(section.id);
      } catch (err) {
        setError(id, `Sezione "${section.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
    }
    setReconstructing(id, null);
  })().catch((err) => {
    setError(id, err instanceof Error ? err.message : String(err));
    setReconstructing(id, null);
  });

  return NextResponse.json({ started: true, total: sections.length }, { status: 202 });
}
