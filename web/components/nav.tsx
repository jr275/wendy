"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Hoje" },
  { href: "/sites", label: "Sites" },
  { href: "/memoria", label: "Memória" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Principal" className="flex items-center gap-0.5 sm:gap-1">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" || path.startsWith("/insight") : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-2 py-1.5 text-sm transition-colors sm:px-3 lg:min-h-9 ${active ? "bg-surface-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
