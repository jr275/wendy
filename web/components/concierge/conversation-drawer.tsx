"use client";
import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConciergeConversation } from "./conversation";

/**
 * The same conversation as on Hoje (one implementation, one thread "main", one history), as a drawer
 * on the other pages. Docked beside the page where there is room (≥1280px), otherwise a sheet that
 * waits for the button. It stays mounted while closed, so the conversation, its scroll position and a
 * running turn survive opening and closing and navigating between pages.
 */
const WIDE = "(min-width: 1280px)";
const subscribeWide = (fn: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
};

export function ConversationDrawer({ suggestions, unavailableReason }: { suggestions: string[]; unavailableReason?: string }) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? wide;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const moved = useRef(false); // focus is only moved after the principal's own open/close

  // Docked: the page makes room (CSS reads body[data-drawer]); never when it is a sheet.
  useEffect(() => {
    if (open && wide) document.body.dataset.drawer = "docked";
    return () => {
      delete document.body.dataset.drawer;
    };
  }, [open, wide]);

  useEffect(() => {
    if (!moved.current) return;
    if (open) panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    else trigger.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        moved.current = true;
        setChoice(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const set = (v: boolean) => {
    moved.current = true;
    setChoice(v);
  };

  return (
    <>
      {!open ? (
        <button
          ref={trigger}
          type="button"
          onClick={() => set(true)}
          aria-expanded={false}
          aria-controls="wendy-drawer"
          className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-medium text-bg shadow-lg transition-opacity duration-[var(--dur-1)] hover:opacity-90"
        >
          Perguntar à Wendy
        </button>
      ) : null}
      <aside
        id="wendy-drawer"
        ref={panel}
        aria-label="Conversa com a Wendy"
        className={`${open ? "flex" : "hidden"} fixed inset-x-0 bottom-0 top-[var(--header-h)] z-30 flex-col border-l border-line bg-surface sm:left-auto sm:w-[420px] sm:shadow-[var(--shadow)] xl:top-0 xl:shadow-none`}
      >
        <div className="min-h-0 flex-1">
          <CopilotChatConfigurationProvider agentId="wendy" threadId="main">
            <ConciergeConversation
              suggestions={suggestions}
              unavailableReason={unavailableReason}
              headerClassName="border-b border-line"
              trail={
                <button type="button" onClick={() => set(false)} aria-label="Fechar conversa" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2">
                <span aria-hidden className="text-lg leading-none">
                  ×
                </span>
              </button>
              }
            />
          </CopilotChatConfigurationProvider>
        </div>
      </aside>
    </>
  );
}
