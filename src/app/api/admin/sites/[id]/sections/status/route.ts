import { NextRequest, NextResponse } from "next/server";
import { getProgress } from "@/lib/sections/progress";

// Stato "in corso" di cattura/ricostruzione per il sito (in memoria, locale).
// Il pannello admin fa polling qui per mostrare una schermata discorsiva.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(getProgress(id));
}
