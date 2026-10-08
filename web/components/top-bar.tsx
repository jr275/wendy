import { ThemeToggle } from "./theme-toggle";

/** Brand + honesty label (which model reasons) + theme. */
export function TopBar({ reasoner }: { reasoner: string | null }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-surface" />
        </span>
        <span className="font-semibold tracking-tight">Menlo</span>
        <span className="eyebrow hidden sm:inline">Remax AI Platform · Wendy</span>
        <span className="ml-auto" />
        {reasoner ? (
          <span className="hidden rounded-full bg-warn-soft px-3 py-1 text-xs text-warn md:inline" title="Modo MVP: o Claude ainda não está disponível">
            Raciocínio: <span className="num">{reasoner}</span> · não é o Claude
          </span>
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
