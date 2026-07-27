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
    return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
  }

  return NextResponse.redirect(new URL("/admin/login", request.url));
}

// Se CLERK_SECRET_KEY non è configurato, l'app resta buildabile e usabile:
// si applica solo la logica admin, senza contesto Clerk (nessun accesso a
// auth() per le route utente finché le chiavi non vengono aggiunte).
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
  // Copre tutte le pagine (esclusi asset statici) + tutte le API, così
  // Clerk può popolare auth() ovunque e la logica admin resta protetta.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
