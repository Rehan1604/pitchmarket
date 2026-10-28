import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "pm_session";
const PROTECTED = ["/dashboard", "/market", "/players", "/portfolio", "/leaderboard", "/social", "/leagues", "/fixtures", "/activity", "/settings", "/admin", "/u/", "/onboarding"];

/**
 * Optimistic gate only: if there is no session cookie at all, send the visitor
 * to sign in (preserving where they were going). Real authorisation happens on
 * the server for every page and API route.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!PROTECTED.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || pathname === p.replace(/\/$/, ""))) return NextResponse.next();
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp|woff2?)$).*)"],
};
