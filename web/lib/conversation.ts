/**
 * The conversation as the home renders it — a pure view of the agent's own messages (the AG-UI
 * messages CopilotKit holds for agent "wendy", thread "main", restored from Wendy's database on
 * connect). No second message store: this only decides what each message looks like.
 *   user text                 → a user bubble
 *   assistant text (markdown) → Wendy's answer (rendered as markdown by the component)
 *   assistant tool call       → one of Wendy's cards (show_answer / show_site / show_execution),
 *                               paired with its tool result message by toolCallId
 * Tool result messages are never shown on their own; unknown tools are not rendered.
 */

export const WENDY_CARDS = ["show_answer", "show_site", "show_execution"] as const;

export interface AgUiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface AgUiMessage {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: AgUiToolCall[];
  toolCallId?: string;
}

export type ConversationItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "card"; id: string; name: (typeof WENDY_CARDS)[number]; toolCall: AgUiToolCall; toolMessage: AgUiMessage | undefined };

/** Text of a message whose content may be a string or AG-UI content parts. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("");
  return "";
}

export function conversationItems(messages: readonly AgUiMessage[]): ConversationItem[] {
  const results = new Map(messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => [m.toolCallId!, m]));
  const items: ConversationItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = textOf(m.content).trim();
      if (text) items.push({ kind: "user", id: m.id, text });
    } else if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) items.push({ kind: "assistant", id: m.id, text });
      for (const tc of m.toolCalls ?? []) {
        const name = tc.function?.name;
        if ((WENDY_CARDS as readonly string[]).includes(name)) items.push({ kind: "card", id: tc.id, name: name as (typeof WENDY_CARDS)[number], toolCall: tc, toolMessage: results.get(tc.id) });
      }
    }
  }
  return items;
}

/**
 * The text to hand back to the composer after a failed turn: the last thing on screen is the principal's
 * own message and Wendy produced nothing after it. It is offered for editing and a NEW send, never
 * re-run: re-running the same message could start a second task (and a second approval) if the first
 * attempt had already begun one, because starting a run is not de-duplicated per message.
 */
export function unansweredUserText(items: readonly ConversationItem[]): string | null {
  const last = items[items.length - 1];
  return last?.kind === "user" ? last.text : null;
}

export type ConversationStatus = "connecting" | "empty" | "ready" | "running" | "error";

/** What the conversation shows around the messages (one place, so it can be tested). */
export function conversationStatus(s: { connected: boolean; connectFailed: boolean; running: boolean; error: string | null; items: number }): ConversationStatus {
  if (s.error) return "error";
  if (s.running) return "running";
  if (!s.connected && !s.connectFailed) return "connecting";
  return s.items ? "ready" : "empty";
}

/** What the principal is told when no answer came back and the client cannot know whether the message arrived. */
export const COMMUNICATION_FAILURE = "Não consegui falar com a Wendy agora. Não tenho confirmação de que esta mensagem chegou até ela.";

/**
 * The sentence shown when a run did not complete, built only from what the client really knows.
 *
 * A RUN_ERROR the agent itself emits carries just a message (src/agent/errors.ts writes it in pt-BR for the
 * principal) and no `code`. One the CopilotKit runtime emits because it could not talk to the agent has a code
 * (for example INCOMPLETE_STREAM with the raw "fetch failed"): that is a communication failure, not something
 * Wendy said, and it must neither be shown raw nor read as "the agent is off" (it is also what a stream cut
 * after the agent started would look like). Whether the message reached the agent is then unknown, and is said so.
 */
export function describeRunFailure(f: { agentEvent: boolean; message?: string; runtimeErrorCode?: unknown }): string {
  const agentSaid = f.agentEvent && !f.runtimeErrorCode && typeof f.message === "string" && f.message.trim();
  return agentSaid ? f.message!.trim().slice(0, 300) : COMMUNICATION_FAILURE;
}
