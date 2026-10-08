"use client";
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", fn);
  return () => {
    listeners.delete(fn);
    mq.removeEventListener("change", fn);
  };
};
const current = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Light/dark switch. The saved theme is applied before paint by the boot script in the root layout. */
export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme | null>(subscribe, current, () => null);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      disabled={theme === null}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("wendy.theme", next);
        } catch {}
        listeners.forEach((l) => l());
      }}
      className="shrink-0 rounded-full border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-surface-2 sm:min-w-[72px] sm:px-3"
      aria-label={theme === null ? "Tema" : `Mudar para tema ${next === "dark" ? "escuro" : "claro"}`}
    >
      {theme === null ? "Tema" : next === "dark" ? "Escuro" : "Claro"}
    </button>
  );
}
