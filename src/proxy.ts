import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Protegge le pagine /admin/* e le API /api/admin/* con il cookie di sessione
 * admin (JWT firmato). Login escluso. Le route pubbliche (lettura, estrazione
 * componenti, chat fake door) vivono fuori da questi prefissi e non passano di qui.
 */
export async function proxy(request: NextRequest) {
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

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
