"use client";
import { useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useRef } from "react";

/**
 * Shared state (CopilotKit read-only pattern): the page tells Wendy's agent what is on screen.
 * Only kind + id travel; the agent resolves them in the database, scoped to the principal.
 * The label is for the "Vendo: …" chip; the agent ignores it.
 */
export type Viewing = { kind: "today" | "sites" | "site" | "insight"; id?: string; label: string };

function usePublish() {
  const { agent } = useAgent({ agentId: "wendy" });
  return (viewing: Viewing) => {
    const cur = (agent.state as { viewing?: Viewing } | undefined)?.viewing;
    if (cur?.kind === viewing.kind && cur?.id === viewing.id) return;
    agent.setState({ ...((agent.state as object | undefined) ?? {}), viewing });
  };
}

export function ShareViewing({ viewing }: { viewing: Viewing }) {
  const publish = usePublish();
  const { kind, id, label } = viewing;
  useEffect(() => publish({ kind, id, label }), [kind, id, label]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** On the Sites page: the site whose section is in the middle of the screen; none → the list. */
export function SiteViewingTracker() {
  const publish = usePublish();
  const visible = useRef(new Map<string, number>());
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-site-id]")];
    const pick = () => {
      let best: HTMLElement | null = null;
      let bestRatio = 0;
      for (const el of els) {
        const r = visible.current.get(el.dataset.siteId!) ?? 0;
        if (r > bestRatio) [best, bestRatio] = [el, r];
      }
      publish(best ? { kind: "site", id: best.dataset.siteId, label: best.dataset.siteLabel ?? "Site" } : { kind: "sites", label: "Sites" });
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.current.set((e.target as HTMLElement).dataset.siteId!, e.isIntersecting ? e.intersectionRect.height : 0);
        pick();
      },
      { rootMargin: "-35% 0px -35% 0px", threshold: [0, 0.01, 0.25, 0.5, 1] },
    );
    els.forEach((el) => io.observe(el));
    pick();
    return () => io.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
