import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { getClerkUserId } from "@/lib/stripe";

// Restituisce prompt/codice di una sezione pubblicata dallo studio di
// ricostruzione. A differenza di .../components/[componentId] (estrazione
// LAZY via LLM), qui prompt e generatedCode sono già stati generati al
// momento della pubblicazione (src/lib/reconstruction/publish.ts): questa
// route legge soltanto, applicando lo stesso gate sul codice a pagamento.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; sectionId: string }> }
) {
  const { slug, sectionId } = await params;

  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value);
    if (!isAdmin) {
      return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
    }
  }

  const section = await prisma.section.findFirst({
    where: { id: sectionId, siteId: site.id, filePath: { not: null } },
  });
  if (!section) {
    return NextResponse.json({ error: "Sezione non trovata" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const mode: "code" | "prompt" = body?.mode === "prompt" ? "prompt" : "code";

  if (mode === "prompt") {
    return NextResponse.json({ mode: "prompt", prompt: section.prompt ?? "" });
  }

  // Il codice è a pagamento solo per i siti con un prezzo configurato,
  // stesso gate di .../components/[componentId] (sblocco a vita via Unlock).
  if (site.price && site.price > 0) {
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

  return NextResponse.json({
    mode: "code",
    code: section.generatedCode ?? "",
    filename: `${section.name.replace(/\s+/g, "")}.tsx`,
  });
}
