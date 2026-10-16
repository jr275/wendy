import Link from "next/link";
import { DEMO } from "@/lib/wendy";
import { Nav } from "./nav";
import { SignOut } from "./sign-out";
import { ThemeToggle } from "./theme-toggle";

/** Brand + honesty label (which model reasons) + theme. */
export function TopBar({ reasoner, wide = false }: { reasoner: string | null; wide?: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/60 backdrop-blur-xl backdrop-saturate-150">
      <div className={`mx-auto flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6 ${wide ? "" : "max-w-5xl"}`}>
        <Link href="/" className="-mx-2 flex min-h-11 items-center gap-3 px-2" aria-label="Wendy — Hoje">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-accent" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-surface" />
          </span>
          <span className="hidden font-semibold tracking-tight sm:inline">Wendy</span>
        </Link>
        <span className="ml-1 hidden h-5 w-px bg-line sm:ml-2 sm:block" aria-hidden />
        <Nav />
        <span className="ml-auto" />
        {DEMO ? (
          <span className="hidden shrink-0 whitespace-nowrap rounded-full bg-info-soft px-3 py-1 text-xs text-info lg:inline" title="Modo demonstração: só a interface. Nenhum dado real, e a Wendy não responde aqui.">
            Demonstração · sem dados reais
          </span>
        ) : null}
        {reasoner ? (
          <span className="hidden rounded-full bg-warn-soft px-3 py-1 text-xs text-warn lg:inline" title="Modo MVP: o Claude ainda não está disponível">
            Raciocínio: <span className="num">{reasoner}</span> · não é o Claude
          </span>
        ) : null}
        <ThemeToggle />
        <SignOut />
      </div>
      {/* Honesty labels never compete with the controls on narrow screens: they get their own strip. */}
      {reasoner || DEMO ? (
        <div data-header-strip className="flex h-6 items-center justify-center gap-3 whitespace-nowrap border-t border-line/50 px-4 text-micro lg:hidden">
          {DEMO ? <span className="text-info">Demonstração · sem dados reais</span> : null}
          {reasoner ? (
            <span className="text-warn" title={`Raciocínio: ${reasoner} — não é o Claude (modo MVP)`}>
              <span className="num">{reasoner}</span> · não é o Claude
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
