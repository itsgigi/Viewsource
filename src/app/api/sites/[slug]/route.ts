import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { getClerkUserId } from "@/lib/stripe";

// Public detail by slug: published sites only (drafts stay visible to a
// logged-in admin, so they can preview)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const site = await prisma.site.findUnique({
    where: { slug },
    include: {
      // rank (Phase 4, "ast" origin only) first, then name — "ai" (url-sourced)
      // components have a null rank and Postgres sorts them ASC NULLS LAST.
      components: { orderBy: [{ rank: "asc" }, { name: "asc" }] },
      documents: {
        select: { id: true, path: true, kind: true, summary: true },
        orderBy: { path: "asc" },
      },
      // Sections published by the assisted reconstruction studio
      // (src/lib/reconstruction/publish.ts) — replace Component as the
      // publicly shown unit (see Viewsource v2 plan).
      sections: {
        where: { filePath: { not: null } },
        orderBy: { order: "asc" },
      },
    },
  });

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

  // Free site (no price) → code always unlocked. Paid site → unlocked only
  // if the current Clerk user has an Unlock for this site.
  let unlocked = !site.price;
  if (site.price) {
    const userId = await getClerkUserId();
    if (userId) {
      const unlock = await prisma.unlock.findUnique({
        where: { userId_siteId: { userId, siteId: site.id } },
      });
      unlocked = !!unlock;
    }
  }

  // The cached code (already extracted in the past, e.g. by the admin)
  // must not leak to anyone who hasn't unlocked the site: the gate lives
  // here too, not just on the extraction endpoint — otherwise the GET alone
  // would be enough. `excluded` items are filtered out entirely: the admin
  // kept them out of the showcase, not just hidden in the UI. `bundleFiles`
  // is gated like `code`/`deps` (same reason: it's the full code of the
  // "ast"-origin components).
  const visibleComponents = site.components.filter((c) => !c.excluded);
  const components = site.price && !unlocked
    ? visibleComponents.map((c) => ({ ...c, code: null, deps: null, bundleFiles: null }))
    : visibleComponents;

  // Same gate for published sections: the (free) prompt always stays
  // visible, the full code (generatedCode) doesn't.
  const sections = site.price && !unlocked
    ? site.sections.map((s) => ({ ...s, generatedCode: null }))
    : site.sections;

  return NextResponse.json({ ...site, components, sections, unlocked });
}
