/** The conversation is kept: events fold into messages, re-sent messages are not duplicated, order holds. */
import { EventType, type BaseEvent } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatHistory, messageRecorder, recentQuestions, saveMessages, userMessages } from '../../src/agent/chatLog.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
});
afterAll(() => t.drop());

const ev = (e: Record<string, unknown>) => e as BaseEvent & Record<string, unknown>;

describe('chat log', () => {
  it('folds a run into messages and restores the thread in order, without duplicates', async () => {
    const now = new Date('2026-10-08T12:00:00Z');
    await saveMessages(db, pid, userMessages({ messages: [{ id: 'u1', role: 'user', content: 'Oi Wendy' }] }), now);

    const r = messageRecorder();
    for (const e of [
      { type: EventType.TEXT_MESSAGE_START, messageId: 'a1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'Olá, ' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'João.' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'a1' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'show_execution' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"id":"x"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: EventType.TOOL_CALL_RESULT, messageId: 'r1', toolCallId: 'tc1', content: 'rendered' },
      { type: EventType.RUN_FINISHED },
    ])
      r.record(ev(e));
    await saveMessages(db, pid, r.messages, now);

    // The client re-sends the whole history on the next turn: only the new message is added.
    await saveMessages(db, pid, userMessages({ messages: [{ id: 'u1', role: 'user', content: 'Oi Wendy' }, { id: 'a1', role: 'assistant', content: 'x' }, { id: 'u2', role: 'user', content: 'Obrigado' }] }), now);

    const h = await chatHistory(db, pid);
    expect(h.map((m) => `${m.role}:${m.id}`)).toEqual(['user:u1', 'assistant:a1', 'assistant:tc1', 'tool:r1', 'user:u2']);
    expect(h[1]).toMatchObject({ content: 'Olá, João.' });
    expect(h[2]!.toolCalls![0]).toMatchObject({ id: 'tc1', function: { name: 'show_execution', arguments: '{"id":"x"}' } });
    expect(h[3]).toMatchObject({ toolCallId: 'tc1' });
  });

  it('never restores a history that starts in the middle of a tool exchange', async () => {
    const h = await chatHistory(db, pid, 2); // last two: tool r1, user u2
    expect(h.map((m) => m.id)).toEqual(['u2']);
  });
});

describe('recent questions (resume list)', () => {
  it('lists only the principal\'s own questions, newest first, clipped, from the window the conversation restores', async () => {
    const db2 = t.db;
    const p2 = await createPrincipal(db2, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
    const other = await createPrincipal(db2, { displayName: 'O', primaryEmail: 'o@example.test', timezone: 'UTC', locale: 'pt-BR' });
    const at = (n: number) => new Date(Date.UTC(2026, 9, 8, 12, n));
    await saveMessages(db2, p2, [{ id: 'q1', role: 'user', content: 'primeira   pergunta\ncom quebra' }], at(1));
    await saveMessages(db2, p2, [{ id: 'a1', role: 'assistant', content: 'resposta' }], at(2));
    await saveMessages(db2, p2, [{ id: 'q2', role: 'user', content: 'x'.repeat(500) }], at(3));
    await saveMessages(db2, other, [{ id: 'oq', role: 'user', content: 'pergunta de outra pessoa' }], at(4));
    const r = await recentQuestions(db2, p2);
    expect(r.map((x) => x.id)).toEqual(['q2', 'q1']); // newest first; the assistant message and the other principal are not here
    expect(r[1]!.text).toBe('primeira pergunta com quebra'); // whitespace collapsed
    expect(r[0]!.text).toHaveLength(200); // clipped for a list
    expect((await recentQuestions(db2, p2, 1)).map((x) => x.id)).toEqual(['q2']);
  });

  it('only reaches what the restored conversation reaches: older than the restore window is not listed', async () => {
    const p3 = await createPrincipal(t.db, { displayName: 'W', primaryEmail: 'w@example.test', timezone: 'UTC', locale: 'pt-BR' });
    const msgs = Array.from({ length: 205 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: `pergunta ${i}` }));
    for (let i = 0; i < msgs.length; i += 50) await saveMessages(t.db, p3, msgs.slice(i, i + 50), new Date(Date.UTC(2026, 9, 8, 12, 0, i)));
    const restored = new Set((await chatHistory(t.db, p3)).map((m) => m.id));
    const listed = await recentQuestions(t.db, p3, 500);
    expect(listed.length).toBe(200); // the same 200-message window
    expect(listed.every((q) => restored.has(q.id))).toBe(true); // every entry can be reached on screen
    expect(listed.some((q) => q.id === 'm0')).toBe(false);
  });
});
