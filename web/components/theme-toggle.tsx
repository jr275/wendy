"use client";
import { useEffect, useSyncExternalStore } from "react";

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

/** Light/dark switch. Server snapshot is null, so markup matches until the browser knows the theme. */
export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme | null>(subscribe, current, () => null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wendy.theme") as Theme | null;
      if (saved) {
        document.documentElement.dataset.theme = saved;
        listeners.forEach((l) => l());
      }
    } catch {}
  }, []);
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
      className="min-w-[72px] rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2"
      aria-label={theme === null ? "Tema" : `Mudar para tema ${next === "dark" ? "escuro" : "claro"}`}
    >
      {theme === null ? "Tema" : next === "dark" ? "Escuro" : "Claro"}
    </button>
  );
}
