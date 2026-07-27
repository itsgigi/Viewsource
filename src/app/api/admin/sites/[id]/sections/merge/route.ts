import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CAN_RUN_LOCAL_PIPELINE } from "@/lib/local-only";
import { mergeSections } from "@/lib/sections/boundaries";

const bodySchema = z.object({ idA: z.string().min(1), idB: z.string().min(1) });

// Boundary editor HITL (Parte 5a): unisce due sezioni "captured" in una sola.
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
    await mergeSections(id, parsed.data.idA, parsed.data.idB);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
