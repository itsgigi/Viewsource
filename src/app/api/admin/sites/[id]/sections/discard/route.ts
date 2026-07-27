import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { discardSection } from "@/lib/sections/boundaries";

const bodySchema = z.object({ sectionId: z.string().min(1) });

// Boundary editor HITL (Parte 5a): scarta (hard delete) una sezione
// "captured" spuria — wrapper residui, banner cookie, ecc.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!CAN_RUN_LOCAL_PIPELINE) {
    return NextResponse.json(
      { error: 'Il boundary editor richiede l\'ambiente locale ("npm run dev"): non è disponibile su Vercel.' },
      { status: 501 }
    );
  }

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await discardSection(id, parsed.data.sectionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
