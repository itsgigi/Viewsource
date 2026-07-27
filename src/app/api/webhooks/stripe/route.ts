import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

// Called by Stripe, not a browser: no Clerk/admin auth here
// (explicit exception, see src/proxy.ts). Security relies entirely on
// verifying the request signature.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid signature: ${err instanceof Error ? err.message : err}` },
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

      // upsert: idempotent if Stripe resends the same event
      await prisma.unlock.upsert({
        where: { userId_siteId: { userId, siteId } },
        create: { userId, siteId, stripePaymentId: paymentId },
        update: { stripePaymentId: paymentId },
      });
    }
  }

  return NextResponse.json({ received: true });
}
