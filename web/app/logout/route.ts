import { requestIsSameSite, SESSION_COOKIE } from "@/lib/auth";

/** Ends the session: POST only (a link or an image tag on another site cannot sign anyone out), same-site only. */
export async function POST(req: Request) {
  if (!requestIsSameSite({ origin: req.headers.get("origin"), host: req.headers.get("host"), secFetchSite: req.headers.get("sec-fetch-site") })) return new Response(null, { status: 403 });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`, "cache-control": "no-store" } });
}
