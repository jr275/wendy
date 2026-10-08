import Link from "next/link";
import { Nav } from "./nav";
import { ThemeToggle } from "./theme-toggle";

/** Brand + honesty label (which model reasons) + theme. */
export function TopBar({ reasoner, wide = false }: { reasoner: string | null; wide?: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/60 backdrop-blur-xl backdrop-saturate-150">
      <div className={`mx-auto flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6 ${wide ? "" : "max-w-5xl"}`}>
        <Link href="/" className="flex items-center gap-3" aria-label="Wendy — Hoje">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-accent" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-surface" />
          </span>
          <span className="hidden font-semibold tracking-tight sm:inline">Wendy</span>
        </Link>
        <span className="ml-1 hidden h-5 w-px bg-line sm:ml-2 sm:block" aria-hidden />
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
