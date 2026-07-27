import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe, getClerkUserId } from "@/lib/stripe";

// Crea una Stripe Checkout Session per sbloccare a vita il codice di un
// sito. Autenticata via Clerk (utente pubblico, separato dall'admin).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const userId = await getClerkUserId();
  if (!userId) {
    return NextResponse.json({ error: "Accedi per continuare" }, { status: 401 });
  }

  const { slug } = await params;
  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site || site.visibility !== "published") {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }
  if (!site.price || site.price <= 0) {
    return NextResponse.json(
      { error: "Questo sito non ha un prezzo di sblocco configurato" },
      { status: 400 }
    );
  }

  const existing = await prisma.unlock.findUnique({
    where: { userId_siteId: { userId, siteId: site.id } },
  });
  if (existing) {
    return NextResponse.json({ error: "Già sbloccato" }, { status: 400 });
  }

  // Riga utente pubblico: creata al bisogno, popolata con l'email Clerk se disponibile.
  let email: string | undefined;
  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    email = user?.primaryEmailAddress?.emailAddress;
  } catch {
    // best-effort
  }
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, email },
    update: email ? { email } : {},
  });

  const origin = req.nextUrl.origin;
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      site.stripePriceId
        ? { price: site.stripePriceId, quantity: 1 }
        : {
            quantity: 1,
            price_data: {
              currency: "eur",
              unit_amount: site.price,
              product_data: {
                name: `Sblocco codice — ${site.name}`,
                description: "Accesso a vita al codice di tutti i componenti di questo sito.",
              },
            },
          },
    ],
    metadata: { userId, siteId: site.id },
    success_url: `${origin}/sites/${site.slug}?unlocked=1`,
    cancel_url: `${origin}/sites/${site.slug}?checkout=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
