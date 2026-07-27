import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe, getClerkUserId } from "@/lib/stripe";

// Creates a Stripe Checkout Session to permanently unlock a site's code.
// Authenticated via Clerk (public user, separate from admin).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const userId = await getClerkUserId();
  if (!userId) {
    return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  }

  const { slug } = await params;
  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site || site.visibility !== "published") {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }
  if (!site.price || site.price <= 0) {
    return NextResponse.json(
      { error: "This site doesn't have an unlock price configured" },
      { status: 400 }
    );
  }

  const existing = await prisma.unlock.findUnique({
    where: { userId_siteId: { userId, siteId: site.id } },
  });
  if (existing) {
    return NextResponse.json({ error: "Already unlocked" }, { status: 400 });
  }

  // Public user row: created on demand, populated with the Clerk email if available.
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
                name: `Code unlock — ${site.name}`,
                description: "Lifetime access to the code of every component on this site.",
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
