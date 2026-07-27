import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Due sistemi di auth separati, gestiti nello stesso proxy:
 * - /admin/* e /api/admin/*: cookie di sessione admin (JWT firmato), invariato.
 * - il resto: contesto Clerk per gli utenti pubblici (unlock/checkout), che
 *   NON viene fuso con l'auth admin — clerkMiddleware si limita a popolare
 *   auth() per le route che lo usano, non blocca nulla di suo (nessun
 *   .protect() qui: il gating vive nelle singole route, es. checkout/estrazione
 *   codice). Il webhook Stripe passa quindi senza intoppi (lo chiama Stripe,
 *   non un browser autenticato).
 */
function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
}

async function handleAdmin(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/admin/login" || pathname === "/api/admin/login") {
    return NextResponse.next();
  }

  const valid = await verifySessionToken(
    request.cookies.get(ADMIN_COOKIE)?.value
  );
  if (valid) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.redirect(new URL("/admin/login", request.url));
}

// If CLERK_SECRET_KEY isn't configured, the app stays buildable and usable:
// only the admin logic applies, with no Clerk context (no access to
// auth() for user routes until the keys are added).
const hasClerk = !!process.env.CLERK_SECRET_KEY;

export const proxy = hasClerk
  ? clerkMiddleware(async (_auth, request) => {
      if (isAdminPath(request.nextUrl.pathname)) return handleAdmin(request);
      return NextResponse.next();
    })
  : async function proxy(request: NextRequest) {
      if (isAdminPath(request.nextUrl.pathname)) return handleAdmin(request);
      return NextResponse.next();
    };

export const config = {
  // Covers all pages (excluding static assets) + all APIs, so Clerk can
  // populate auth() everywhere and the admin logic stays protected.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
