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

export type ConversationStatus = "connecting" | "empty" | "ready" | "running" | "error";

/** What the conversation shows around the messages (one place, so it can be tested). */
export function conversationStatus(s: { connected: boolean; connectFailed: boolean; running: boolean; error: string | null; items: number }): ConversationStatus {
  if (s.error) return "error";
  if (s.running) return "running";
  if (!s.connected && !s.connectFailed) return "connecting";
  return s.items ? "ready" : "empty";
}
