import Link from "next/link";
import { Nav } from "./nav";
import { ThemeToggle } from "./theme-toggle";

/** Brand + honesty label (which model reasons) + theme. */
export function TopBar({ reasoner }: { reasoner: string | null }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-3" aria-label="Menlo — Hoje">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-accent" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-surface" />
          </span>
          <span className="font-semibold tracking-tight">Menlo</span>
        </Link>
        <span className="ml-2 hidden h-5 w-px bg-line sm:block" aria-hidden />
        <Nav />
        <span className="ml-auto" />
        {reasoner ? (
          <>
            <span className="hidden rounded-full bg-warn-soft px-3 py-1 text-xs text-warn md:inline" title="Modo MVP: o Claude ainda não está disponível">
              Raciocínio: <span className="num">{reasoner}</span> · não é o Claude
            </span>
            <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] text-warn md:hidden" title={`Raciocínio: ${reasoner} — não é o Claude (modo MVP)`}>
              não é o Claude
            </span>
          </>
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
