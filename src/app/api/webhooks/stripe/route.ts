import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

// Chiamata da Stripe, non da un browser: nessuna auth Clerk/admin qui
// (eccezione esplicita, vedi src/proxy.ts). La sicurezza sta tutta nella
// verifica della firma della richiesta.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET non configurato" },
      { status: 500 }
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Firma mancante" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    return NextResponse.json(
      { error: `Firma non valida: ${err instanceof Error ? err.message : err}` },
      { status: 400 }
    );
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const siteId = session.metadata?.siteId;

    if (userId && siteId) {
      const paymentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? session.id;

      // upsert: idempotente se Stripe reinvia lo stesso evento
      await prisma.unlock.upsert({
        where: { userId_siteId: { userId, siteId } },
        create: { userId, siteId, stripePaymentId: paymentId },
        update: { stripePaymentId: paymentId },
      });
    }
  }

  return NextResponse.json({ received: true });
}
