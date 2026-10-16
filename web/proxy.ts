import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, SESSION_COOKIE } from "@/lib/auth";

/**
 * Two jobs, both before anything renders:
 *  1. /dev/* are development-only galleries and fixtures. In production they answer a real 404 from here (a page-level
 *     notFound() cannot do it: with Cache Components the response has already started, so the status stays 200).
 *  2. Sign-in (lib/auth.ts). In production every page and API call needs a valid session cookie; /login is the only open path.
 *     With the password hash or the session secret missing, everything answers 503 rather than opening. In development it is off
 *     unless WENDY_AUTH=on, so 127.0.0.1 keeps behaving as before.
 */
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (process.env.NODE_ENV === "production" && (path === "/dev" || path.startsWith("/dev/"))) return new NextResponse("Not Found", { status: 404 });

  const access = await decideAccess(
    { path, method: req.method, cookie: req.cookies.get(SESSION_COOKIE)?.value, accept: req.headers.get("accept") },
    { nodeEnv: process.env.NODE_ENV, wendyAuth: process.env.WENDY_AUTH, passwordHash: process.env.WENDY_WEB_PASSWORD_HASH, sessionSecret: process.env.WENDY_SESSION_SECRET },
    Date.now(),
  );
  switch (access) {
    case "allow":
      return NextResponse.next();
    case "login": {
      const to = new URL("/login", req.url);
      if (path !== "/") to.searchParams.set("next", path + req.nextUrl.search);
      return NextResponse.redirect(to);
    }
    case "unauthorized":
      return new NextResponse(null, { status: 401 });
    case "unavailable":
      return new NextResponse("Sign-in is not configured for this environment.", { status: 503 });
  }
}

// Everything except the build's static assets and the icon (public files are not secrets; the app has none that are).
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
