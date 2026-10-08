"use client";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/** Light/dark switch. Renders a neutral label until mounted, so server and client markup match. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    let saved: Theme | null = null;
    try {
      saved = localStorage.getItem("wendy.theme") as Theme | null;
    } catch {}
    const initial = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    if (saved) document.documentElement.dataset.theme = saved;
    setTheme(initial);
  }, []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      disabled={theme === null}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        setTheme(next);
        try {
          localStorage.setItem("wendy.theme", next);
        } catch {}
      }}
      className="min-w-[72px] rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2"
      aria-label={theme === null ? "Tema" : `Mudar para tema ${next === "dark" ? "escuro" : "claro"}`}
    >
      {theme === null ? "Tema" : next === "dark" ? "Escuro" : "Claro"}
    </button>
  );
}
