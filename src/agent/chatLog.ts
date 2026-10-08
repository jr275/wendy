/**
 * Conversation log. The agent's AG-UI events are folded back into chat messages (the same shape the
 * client builds) and stored, together with the principal's own messages, in one continuous thread.
 * Re-sent messages are ignored (primary key on the message id).
 */
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { Queryable } from '../db/db.js';

export const MAIN_THREAD = 'main';
const HISTORY_LIMIT = 200;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}

/** Collects the messages a run produces from its event stream. */
export function messageRecorder() {
  const messages: ChatMessage[] = [];
  const text = new Map<string, ChatMessage>();
  const calls = new Map<string, ChatMessage>();
  const record = (e: BaseEvent & Record<string, unknown>) => {
    switch (e.type) {
      case EventType.TEXT_MESSAGE_START: {
        const m: ChatMessage = { id: e.messageId as string, role: 'assistant', content: '' };
        text.set(m.id, m);
        messages.push(m);
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const m = text.get(e.messageId as string);
        if (m) m.content += e.delta as string;
        break;
      }
      case EventType.TOOL_CALL_START: {
        const m: ChatMessage = { id: e.toolCallId as string, role: 'assistant', toolCalls: [{ id: e.toolCallId as string, type: 'function', function: { name: e.toolCallName as string, arguments: '' } }] };
        calls.set(e.toolCallId as string, m);
        messages.push(m);
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const m = calls.get(e.toolCallId as string);
        if (m) m.toolCalls![0]!.function.arguments += e.delta as string;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        messages.push({ id: e.messageId as string, role: 'tool', toolCallId: e.toolCallId as string, content: e.content as string });
        break;
    }
  };
  return { record, messages };
}

export async function saveMessages(q: Queryable, principalId: string, messages: ChatMessage[], now: Date): Promise<void> {
  for (const m of messages) {
    await q.query(
      `INSERT INTO chat_messages(id, principal_id, thread_id, role, content, tool_calls, tool_call_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (principal_id, id) DO NOTHING`,
      [m.id, principalId, MAIN_THREAD, m.role, m.content ?? null, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, now],
    );
  }
}

/** The principal's own messages from a run's input (user role only; the agent's are recorded from events). */
export function userMessages(input: { messages: { id: string; role: string; content?: unknown }[] }): ChatMessage[] {
  return input.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => ({ id: m.id, role: 'user', content: m.content as string }));
}

export async function chatHistory(q: Queryable, principalId: string, limit = HISTORY_LIMIT): Promise<ChatMessage[]> {
  const rows = (
    await q.query<{ id: string; role: ChatMessage['role']; content: string | null; tool_calls: ChatMessage['toolCalls'] | null; tool_call_id: string | null }>(
      `SELECT id, role, content, tool_calls, tool_call_id FROM (
         SELECT * FROM chat_messages WHERE principal_id = $1 AND thread_id = $2 ORDER BY seq DESC LIMIT $3
       ) last ORDER BY seq`,
      [principalId, MAIN_THREAD, limit],
    )
  ).rows;
  // Never start the restored history in the middle of a tool exchange.
  while (rows.length && rows[0]!.role === 'tool') rows.shift();
  return rows.map((r) => ({ id: r.id, role: r.role, ...(r.content !== null ? { content: r.content } : {}), ...(r.tool_calls ? { toolCalls: r.tool_calls } : {}), ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}) }));
}
