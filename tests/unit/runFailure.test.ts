/**
 * What the principal is told when a run did not complete (web/lib/conversation.ts, describeRunFailure). Pure: no
 * database, no network. The facts it encodes were observed on the real path with the agent down: the runtime answers
 * HTTP 200 with RUN_ERROR { message: "fetch failed", code: "INCOMPLETE_STREAM" }, while a RUN_ERROR the agent itself
 * emits (src/agent/server.ts, run.ts) carries only a pt-BR message and no code.
 */
import { describe, expect, it } from 'vitest';
import { COMMUNICATION_FAILURE, describeRunFailure } from '../../web/lib/conversation.js';

describe('describeRunFailure', () => {
  it("shows the agent's own sentence when the agent reported the error (no runtime code)", () => {
    expect(describeRunFailure({ agentEvent: true, message: 'O modelo recusou este pedido. Reformule ou peça de outro jeito.' })).toBe('O modelo recusou este pedido. Reformule ou peça de outro jeito.');
  });

  it('does not repeat or add claims to the agent sentence (no "ficou na conversa" appended)', () => {
    const t = describeRunFailure({ agentEvent: true, message: 'A Wendy não conseguiu responder por um erro interno.' });
    expect(t).toBe('A Wendy não conseguiu responder por um erro interno.');
    expect(t).not.toMatch(/ficou na conversa/);
  });

  it('a runtime failure (code INCOMPLETE_STREAM, raw "fetch failed") is a communication failure: raw text never shown', () => {
    const t = describeRunFailure({ agentEvent: true, message: 'fetch failed', runtimeErrorCode: 'INCOMPLETE_STREAM' });
    expect(t).toBe(COMMUNICATION_FAILURE);
    expect(t).not.toMatch(/fetch failed/);
  });

  it('failures that are not agent events (network, HTTP) are communication failures too', () => {
    expect(describeRunFailure({ agentEvent: false, message: 'Failed to fetch' })).toBe(COMMUNICATION_FAILURE);
    expect(describeRunFailure({ agentEvent: false })).toBe(COMMUNICATION_FAILURE);
  });

  it('an agent event with no usable message falls back to the communication failure', () => {
    for (const message of [undefined, '', '   ']) expect(describeRunFailure({ agentEvent: true, message })).toBe(COMMUNICATION_FAILURE);
  });

  it('the communication sentence never claims the agent is off, nor that the message was or was not received', () => {
    expect(COMMUNICATION_FAILURE).not.toMatch(/desligad|indispon|offline|ficou na conversa|n[ãa]o foi enviada|foi enviada/i);
    expect(COMMUNICATION_FAILURE).toMatch(/não tenho confirmação/i);
  });

  it('long agent messages are clipped', () => {
    expect(describeRunFailure({ agentEvent: true, message: 'x'.repeat(1000) }).length).toBe(300);
  });
});
