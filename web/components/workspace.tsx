"use client";
import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { AnswerCard, SiteCard } from "./cards";
import { ConciergeConversation } from "./concierge/conversation";
import { SeeingChip } from "./wendy-chat";
import { useWorkspace, type Mode } from "./workspace-context";

function ModeToggle() {
  const { mode, setMode } = useWorkspace();
  const opt = (m: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${mode === m ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Modo de visualização" className="flex gap-0.5 rounded-full border border-line bg-surface-2 p-0.5">
      {opt("conversa", "Conversa")}
      {opt("painel", "Painel")}
    </div>
  );
}

/** What the conversation brought up, full size, above the Hoje overview. */
function Focus() {
  const { focus, clear } = useWorkspace();
  if (!focus.length) return null;
  return (
    <section aria-label="Em foco" className="order-last mx-auto w-full max-w-5xl px-4 pb-10 pt-8 sm:px-6 lg:order-none lg:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Em foco · da sua conversa</p>
        <button type="button" onClick={clear} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-surface-2">
          Fechar
        </button>
      </div>
      <div className="mt-4 grid gap-6">
        {focus.map((c) => (c.kind === "answer" ? <AnswerCard key={c.id} a={c.a} /> : <SiteCard key={c.id} s={c.s} />))}
      </div>
      <div className="mt-12 border-t border-line" />
    </section>
  );
}

/**
 * Chat + panel. In "painel" the chat is a side column (hidden on phones, where a button opens it);
 * in "conversa" the chat takes the page and the panel is hidden. The chat stays mounted in both.
 */
export function Workspace({ suggestions, children }: { suggestions: string[]; children: React.ReactNode }) {
  const { mode, setMode } = useWorkspace();
  const painel = mode === "painel";
  return (
    <div className="flex h-[calc(100dvh-3.5rem-1px)] min-h-0">
      <section
        aria-label="Conversa com a Wendy"
        className={painel ? "hidden w-[400px] shrink-0 flex-col border-r border-line/70 bg-surface/55 backdrop-blur-xl lg:flex xl:w-[440px]" : "flex min-w-0 flex-1 flex-col"}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <span className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 text-sm font-medium">Wendy</p>
            <SeeingChip />
          </span>
          <ModeToggle />
        </div>
        <div className={`min-h-0 flex-1 ${painel ? "" : "mx-auto w-full max-w-3xl"}`}>
          {/* Every chat hook resolves to Wendy, the only agent (some read only this configuration). */}
          <CopilotChatConfigurationProvider agentId="wendy" threadId="main">
            <ConciergeConversation suggestions={suggestions} />
          </CopilotChatConfigurationProvider>
        </div>
      </section>

      <section aria-label="Painel" className={painel ? "flex min-w-0 flex-1 flex-col overflow-y-auto lg:block" : "hidden"}>
        <Focus />
        {children}
        <button
          type="button"
          onClick={() => setMode("conversa")}
          className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-medium text-bg shadow-lg lg:hidden"
        >
          Perguntar à Wendy
        </button>
      </section>
    </div>
  );
}
