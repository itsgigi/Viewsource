import Stripe from "stripe";

let _stripe: Stripe | null = null;

/**
 * Client Stripe lazy: non istanziato a import-time (evita di far fallire
 * `next build` o l'avvio dell'app quando STRIPE_SECRET_KEY non è ancora
 * configurato). Throw leggibile solo quando davvero serve una chiamata Stripe.
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY non configurato");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

/** userId Clerk dell'utente pubblico corrente, o null se anonimo / Clerk non configurato. */
export async function getClerkUserId(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const { auth } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    return userId ?? null;
  } catch {
    return null;
  }
}
