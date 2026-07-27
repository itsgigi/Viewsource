import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { extractComponent } from "@/lib/extract";
import { getClerkUserId } from "@/lib/stripe";

// La generazione via OpenAI può superare il timeout default di Vercel
export const maxDuration = 60;

const bodySchema = z.object({
  mode: z.enum(["code", "prompt"]).default("code"),
});

// Estrazione pubblica: lazy con cache permanente. Target fisso
// (React + TypeScript + Tailwind CSS); se il campo è già popolato
// risponde dal DB senza mai chiamare OpenAI.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; componentId: string }> }
) {
  const { slug, componentId } = await params;

  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(
      req.cookies.get(ADMIN_COOKIE)?.value
    );
    if (!isAdmin) {
      return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
    }
  }

  const component = await prisma.component.findFirst({
    where: { id: componentId, siteId: site.id },
  });
  if (!component) {
    return NextResponse.json(
      { error: "Componente non trovato" },
      { status: 404 }
    );
  }

  const { mode } = bodySchema.parse(await req.json().catch(() => ({})));

  // Il prompt resta gratis sempre (leva di acquisizione). Il codice è a
  // pagamento solo per i siti con un prezzo configurato: sblocco a vita
  // per (utente Clerk, sito), verificato tramite Unlock.
  if (mode === "code" && site.price && site.price > 0) {
    const userId = await getClerkUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "Accedi per sbloccare il codice", requiresAuth: true, price: site.price },
        { status: 401 }
      );
    }
    const unlock = await prisma.unlock.findUnique({
      where: { userId_siteId: { userId, siteId: site.id } },
    });
    if (!unlock) {
      return NextResponse.json(
        { error: "Sito non sbloccato", requiresCheckout: true, price: site.price },
        { status: 402 }
      );
    }
  }

  const result = await extractComponent({ ...component, site }, mode);
  return NextResponse.json(result);
}
