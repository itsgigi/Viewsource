import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { extractComponent } from "@/lib/extract";
import { getClerkUserId } from "@/lib/stripe";

// Generation via OpenAI can exceed Vercel's default timeout
export const maxDuration = 60;

const bodySchema = z.object({
  mode: z.enum(["code", "prompt"]).default("code"),
});

// Public extraction: lazy with a permanent cache. Fixed target
// (React + TypeScript + Tailwind CSS); if the field is already populated
// it responds from the DB without ever calling OpenAI.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; componentId: string }> }
) {
  const { slug, componentId } = await params;

  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(
      req.cookies.get(ADMIN_COOKIE)?.value
    );
    if (!isAdmin) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
  }

  const component = await prisma.component.findFirst({
    where: { id: componentId, siteId: site.id },
  });
  if (!component) {
    return NextResponse.json(
      { error: "Component not found" },
      { status: 404 }
    );
  }

  const { mode } = bodySchema.parse(await req.json().catch(() => ({})));

  // The prompt always stays free (acquisition lever). The code is paid
  // only for sites with a configured price: lifetime unlock per
  // (Clerk user, site), verified via Unlock.
  if (mode === "code" && site.price && site.price > 0) {
    const userId = await getClerkUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "Sign in to unlock the code", requiresAuth: true, price: site.price },
        { status: 401 }
      );
    }
    const unlock = await prisma.unlock.findUnique({
      where: { userId_siteId: { userId, siteId: site.id } },
    });
    if (!unlock) {
      return NextResponse.json(
        { error: "Site not unlocked", requiresCheckout: true, price: site.price },
        { status: 402 }
      );
    }
  }

  const result = await extractComponent({ ...component, site }, mode);
  return NextResponse.json(result);
}
