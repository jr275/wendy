"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createLiveGate } from "@/lib/focus";
import type { AnswerPayload, SitePayload } from "./cards";

/**
 * The workspace has two modes (the CopilotKit "chat / app" pattern):
 *  - conversa: the chat takes the page; Wendy's cards render full size inside it;
 *  - painel:   the chat is a side column; cards render compact there and full size in the panel,
 *              above the Hoje overview.
 */
export type Mode = "conversa" | "painel";
export type FocusCard = { id: string; kind: "answer"; a: AnswerPayload } | { id: string; kind: "site"; s: SitePayload };

interface Workspace {
  mode: Mode;
  setMode: (m: Mode) => void;
  focus: FocusCard[];
  /** Put one card in the panel (from a click). */
  open: (card: FocusCard) => void;
  /** Called once per card as it arrives: an answer starts a new focus, sites join it — but only during a live turn (lib/focus.ts). */
  arrived: (card: FocusCard) => void;
  /** A turn started from this page begins / ends: cards that appear meanwhile may take the focus. */
  beginLive: () => void;
  endLive: () => void;
  clear: () => void;
}

const Ctx = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("painel");
  const [focus, setFocus] = useState<FocusCard[]>([]);
  const seen = useRef(new Set<string>());
  const gate = useRef(createLiveGate());

  const open = useCallback((card: FocusCard) => {
    setFocus([card]);
    setMode("painel");
  }, []);
  const arrived = useCallback((card: FocusCard) => {
    if (seen.current.has(card.id)) return;
    seen.current.add(card.id);
    if (!gate.current.accepts()) return; // restored from history, not produced now: the panel stays on today's Hoje
    setFocus((f) => (card.kind === "answer" ? [card] : f.some((c) => c.id === card.id) ? f : [...f, card]));
  }, []);
  const clear = useCallback(() => setFocus([]), []);
  const beginLive = useCallback(() => gate.current.begin(), []);
  const endLive = useCallback(() => gate.current.end(), []);

  const value = useMemo(() => ({ mode, setMode, focus, open, arrived, clear, beginLive, endLive }), [mode, focus, open, arrived, clear, beginLive, endLive]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the Hoje workspace (e.g. in the sidebar chat on other pages). */
export function useOptionalWorkspace(): Workspace | null {
  return useContext(Ctx);
}

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWorkspace outside WorkspaceProvider");
  return w;
}
