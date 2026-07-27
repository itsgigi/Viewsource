import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { getClerkUserId } from "@/lib/stripe";

// Returns prompt/code for a section published by the reconstruction
// studio. Unlike .../components/[componentId] (LAZY extraction via LLM),
// here prompt and generatedCode were already generated at publish time
// (src/lib/reconstruction/publish.ts): this route only reads, applying
// the same gate on the paid code.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; sectionId: string }> }
) {
  const { slug, sectionId } = await params;

  const site = await prisma.site.findUnique({ where: { slug } });
  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value);
    if (!isAdmin) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
  }

  const section = await prisma.section.findFirst({
    where: { id: sectionId, siteId: site.id, filePath: { not: null } },
  });
  if (!section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const mode: "code" | "prompt" = body?.mode === "prompt" ? "prompt" : "code";

  if (mode === "prompt") {
    return NextResponse.json({ mode: "prompt", prompt: section.prompt ?? "" });
  }

  // The code is paid only for sites with a configured price, same gate
  // as .../components/[componentId] (lifetime unlock via Unlock).
  if (site.price && site.price > 0) {
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

  return NextResponse.json({
    mode: "code",
    code: section.generatedCode ?? "",
    filename: `${section.name.replace(/\s+/g, "")}.tsx`,
  });
}
