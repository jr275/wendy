import { authMode } from "@/lib/auth";

/**
 * "Sair": ends the session (POST /logout, same-site only). Shown only where sign-in is required (production, or WENDY_AUTH=on); on
 * 127.0.0.1 there is no session to end, so no button. A plain form, no client code: it works before the page hydrates.
 */
export function SignOut() {
  if (authMode({ nodeEnv: process.env.NODE_ENV, wendyAuth: process.env.WENDY_AUTH }) !== "required") return null;
  return (
    <form method="post" action="/logout" className="shrink-0">
      <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-full px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-ink sm:px-3 lg:min-h-9">
        Sair
      </button>
    </form>
  );
}
