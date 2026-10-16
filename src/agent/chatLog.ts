/**
 * Conversation log. The agent's AG-UI events are folded back into chat messages (the same shape the
 * client builds) and stored, together with the principal's own messages, in one continuous thread.
 * Re-sent messages are ignored (primary key on the message id).
 */
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { Queryable } from '../db/db.js';
import { maskCardData, maskCardDeep } from '../security/cardRedaction.js';

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
      [m.id, principalId, MAIN_THREAD, m.role, m.content == null ? null : maskCardData(m.content), m.toolCalls ? JSON.stringify(maskCardDeep(m.toolCalls)) : null, m.toolCallId ?? null, now],
    );
  }
}

/** The principal's own messages from a run's input (user role only; the agent's are recorded from events). */
export function userMessages(input: { messages: { id: string; role: string; content?: unknown }[] }): ChatMessage[] {
  return input.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => ({ id: m.id, role: 'user', content: m.content as string }));
}

/**
 * The principal's recent questions, newest first, for resuming ("go back to this"). Taken from the
 * SAME window the conversation restores (the last HISTORY_LIMIT messages), so every entry can be
 * reached in the conversation on screen. Text is clipped for a list; the message stays whole in the log.
 */
export async function recentQuestions(q: Queryable, principalId: string, limit = 15): Promise<{ id: string; text: string; at: Date; runId: string | null }[]> {
  // runId: the task this message started, when it started one (skill_executions.trigger.messageId, written by the agent when it starts a run
  // from a chat turn). Older runs, and questions that did not start one, have none: nothing is guessed from the text.
  const rows = (
    await q.query<{ id: string; content: string | null; created_at: Date; run_id: string | null }>(
      `SELECT last.id, last.content, last.created_at,
              (SELECT e.id::text FROM skill_executions e WHERE e.principal_id = $1 AND e.parent_id IS NULL AND e.trigger->>'messageId' = last.id ORDER BY e.created_at DESC LIMIT 1) AS run_id
         FROM (
           SELECT * FROM chat_messages WHERE principal_id = $1 AND thread_id = $2 ORDER BY seq DESC LIMIT $3
         ) last WHERE last.role = 'user' AND last.content IS NOT NULL ORDER BY last.seq DESC LIMIT $4`,
      [principalId, MAIN_THREAD, HISTORY_LIMIT, limit],
    )
  ).rows;
  return rows.map((r) => ({ id: r.id, text: r.content!.replace(/\s+/g, ' ').trim().slice(0, 200), at: r.created_at, runId: r.run_id }));
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
