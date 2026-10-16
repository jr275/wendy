import { createSession, LoginLimiter, requestIsSameSite, safeNext, SESSION_COOKIE, SESSION_TTL_S, verifyPassword } from "@/lib/auth";

/**
 * Sign-in page (GET) and form handler (POST). A route handler rather than a page: it reads the request directly and needs no
 * Suspense boundary under Cache Components. The proxy (proxy.ts) leaves /login open; everything else needs the session cookie.
 */
const limiter = new LoginLimiter();

const PAGE = (error: string, next: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Entrar · Wendy</title>
<style>
:root{--bg:#f6f1e7;--ink:#1f2a22;--muted:#6b7468;--moss:#3f6b4e;--line:#d9d2c2;--err:#9a3b2e}
@media (prefers-color-scheme:dark){:root{--bg:#121410;--ink:#ece7da;--muted:#9aa294;--moss:#7fb08f;--line:#2b3027;--err:#e08a7c}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 ui-serif,Georgia,serif}
main{width:min(92vw,360px);padding:16px}h1{font-size:28px;margin:0 0 4px}p{margin:0 0 20px;color:var(--muted)}
label{display:block;font:13px ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:12px 14px;font:16px ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:12px}
input:focus-visible,button:focus-visible{outline:2px solid var(--moss);outline-offset:2px}
button{margin-top:14px;width:100%;padding:12px;font:600 16px ui-sans-serif,system-ui,sans-serif;color:#fff;background:var(--moss);border:0;border-radius:999px;cursor:pointer}
.err{margin:12px 0 0;color:var(--err);font:14px ui-sans-serif,system-ui,sans-serif}
</style></head><body><main>
<h1>Wendy</h1><p>Entre para continuar.</p>
<form method="post" action="/login">
<label for="p">Senha</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${next.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}">
<button type="submit">Entrar</button>${error ? `<p class="err" role="alert">${error}</p>` : ""}
</form></main></body></html>`;

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin" } });

export async function GET(req: Request) {
  return html(PAGE("", safeNext(new URL(req.url).searchParams.get("next"))));
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const next = safeNext(String(form?.get("next") ?? ""));
  if (!form || !requestIsSameSite({ origin: req.headers.get("origin"), host: req.headers.get("host"), secFetchSite: req.headers.get("sec-fetch-site") })) return html(PAGE("Pedido recusado. Recarregue a página e tente de novo.", next), 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  const now = Date.now();
  if (limiter.blocked(ip, now)) return html(PAGE("Muitas tentativas. Aguarde alguns minutos.", next), 429);

  const secret = process.env.WENDY_SESSION_SECRET;
  const hash = process.env.WENDY_WEB_PASSWORD_HASH;
  if (!secret || secret.length < 32 || !hash) return html(PAGE("O login não está configurado neste ambiente.", next), 503);

  if (!(await verifyPassword(String(form.get("password") ?? ""), hash))) {
    limiter.fail(ip, now);
    return html(PAGE("Senha incorreta.", next), 401);
  }
  limiter.reset(ip);
  const token = await createSession(secret, now);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: { location: next, "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}${secure}`, "cache-control": "no-store" },
  });
}
