/** The conversation is kept: events fold into messages, re-sent messages are not duplicated, order holds. */
import { EventType, type BaseEvent } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatHistory, messageRecorder, saveMessages, userMessages } from '../../src/agent/chatLog.js';
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
