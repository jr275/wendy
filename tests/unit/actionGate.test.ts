/**
 * Offline-safe mutations. Pure: every dependency of the write path is injected (a vi.fn() for fetch and for refresh),
 * so no agent, database, network or provider is involved. Three layers are covered:
 *   1. the availability mapping (WENDY_AGENT → reason for actions),
 *   2. the server-side write core (postWrite): nothing is requested when the agent is explicitly off, and a failure
 *      is never reported as done,
 *   3. a source-level contract: every server action goes through that one door, and every mutation control is gated.
 * Layer 3 is a regression guard over the source text, NOT behavioural evidence (the browser runtime checks are).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ACTION_OFF_REASON, actionUnavailableReason, parseAgentSetting, unavailableReason } from '../../web/lib/agentConfig.js';
import { friendly, postWrite, type WriteDeps } from '../../web/lib/writeCore.js';

const WEB = path.resolve(__dirname, '../../web');
const src = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

describe('availability → reason for actions', () => {
  it('only an explicit off blocks actions; on, unset, blank and invalid claim nothing', () => {
    expect(actionUnavailableReason({ setting: parseAgentSetting('off') })).toBe(ACTION_OFF_REASON);
    expect(actionUnavailableReason({ setting: parseAgentSetting(' OFF ') })).toBe(ACTION_OFF_REASON);
    for (const v of ['on', undefined, '', '   ', 'ofline', '0', 'false']) expect(actionUnavailableReason({ setting: parseAgentSetting(v) }), String(v)).toBeUndefined();
  });
  it('demo mode alone does not start gating actions (its semantics are unchanged); the conversation reason is untouched', () => {
    expect(actionUnavailableReason({ setting: 'unset' })).toBeUndefined();
    expect(unavailableReason({ demo: true, setting: 'unset' })).toMatch(/Modo demonstração/);
    expect(unavailableReason({ demo: false, setting: 'off' })).toMatch(/desligado neste ambiente/);
  });
  it('the sentence says why, and claims no result', () => {
    expect(ACTION_OFF_REASON).toMatch(/precisam do agente/);
    expect(ACTION_OFF_REASON).not.toMatch(/salv|conclu|enviad|feito|sucesso|erro|falh/i);
  });
});

function deps(over: Partial<WriteDeps> = {}) {
  const fetchImpl = vi.fn();
  const refresh = vi.fn();
  const d: WriteDeps = { agentUrl: 'http://agent.invalid', token: 'T', fetchImpl: fetchImpl as unknown as typeof fetch, refresh, ...over };
  return { d, fetchImpl, refresh };
}
const reply = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

describe('postWrite with the agent explicitly off', () => {
  const NAMES = ['action/approve', 'action/reject', 'execution/cancel', 'site/importance', 'memory/confirm', 'memory/retract']; // one per server action
  it('makes no request and changes nothing, for every action', async () => {
    for (const name of NAMES) {
      const { d, fetchImpl, refresh } = deps({ unavailableReason: ACTION_OFF_REASON });
      const r = await postWrite(name, { id: 'x' }, d);
      expect(r, name).toEqual({ ok: false, error: ACTION_OFF_REASON, offline: true });
      expect(fetchImpl, name).not.toHaveBeenCalled();
      expect(refresh, name).not.toHaveBeenCalled();
    }
  });
  it('repeated invocation never starts a request (no duplicates, no success)', async () => {
    const { d, fetchImpl, refresh } = deps({ unavailableReason: ACTION_OFF_REASON });
    const results = await Promise.all(Array.from({ length: 6 }, () => postWrite('action/approve', { actionId: 'a1' }, d)));
    expect(results.every((r) => r.ok === false && r.offline === true)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(refresh).toHaveBeenCalledTimes(0);
  });
});

describe('postWrite when availability is unknown: the existing contract holds', () => {
  it('success only when the agent answered 2xx AND ok; the page refreshes once', async () => {
    const { d, fetchImpl, refresh } = deps();
    fetchImpl.mockReturnValueOnce(reply(200, { ok: true, result: { status: 'done' } }));
    const r = await postWrite('memory/confirm', { memoryId: 'm1' }, d);
    expect(r).toEqual({ ok: true, result: { status: 'done' } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://agent.invalid/write/memory/confirm');
    expect(init.method).toBe('POST');
  });
  it('a 2xx whose body says not ok is a failure, never success, and nothing refreshes', async () => {
    const { d, fetchImpl, refresh } = deps();
    fetchImpl.mockReturnValueOnce(reply(200, { ok: false, error: 'only AWAITING_APPROVAL can be approved' }));
    const r = await postWrite('action/approve', { actionId: 'a1' }, d);
    expect(r).toEqual({ ok: false, error: 'Esta ação já foi decidida.' });
    expect(refresh).not.toHaveBeenCalled();
  });
  it('an HTTP error, an unreadable body and a transport failure are all failures, each tried exactly once (no retry)', async () => {
    for (const make of [() => reply(502, {}), () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) } as unknown as Response), () => Promise.reject(new TypeError('fetch failed'))]) {
      const { d, fetchImpl, refresh } = deps();
      fetchImpl.mockReturnValueOnce(make());
      const r = await postWrite('execution/cancel', { executionId: 'e1' }, d);
      expect(r.ok).toBe(false);
      expect((r as { offline?: true }).offline).toBeUndefined(); // a runtime failure is not the configured-off state
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
    }
  });
  it('the transport failure text is the existing one, and is distinguishable from the offline result', async () => {
    const { d, fetchImpl } = deps();
    fetchImpl.mockReturnValueOnce(Promise.reject(new TypeError('fetch failed')));
    const failure = await postWrite('site/importance', { propertyId: 'p', importance: 1 }, d);
    expect(failure).toEqual({ ok: false, error: 'A Wendy não respondeu. Verifique se o agente está rodando.' });
    expect(failure).not.toEqual(await postWrite('site/importance', {}, deps({ unavailableReason: ACTION_OFF_REASON }).d));
  });
  it('friendly keeps the known pt-BR translations and passes anything else through', () => {
    expect(friendly('expired')).toMatch(/expirou/);
    expect(friendly('importance out of range')).toMatch(/entre 0 e 1/);
    expect(friendly('something else')).toBe('something else');
  });
});

describe('source contract (regression guard, not behaviour)', () => {
  const actions = src('lib/actions.ts');
  it('every exported server action goes through the single write door; lib/actions.ts has no other fetch', () => {
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual(['approveAction', 'cancelExecution', 'confirmMemory', 'markDigestRead', 'refreshDigest', 'rejectAction', 'retractMemory', 'setSiteImportance']);
    expect((actions.match(/\bwrite\(/g) ?? []).length).toBeGreaterThanOrEqual(exported.length); // one call each (cancelExecution included)
    expect(actions).toMatch(/unavailableReason: ACTION_UNAVAILABLE_REASON/);
    expect(actions.replace(/fetchImpl: fetch/, '')).not.toMatch(/\bfetch\(/);
  });
  const CONTROLS: Record<string, string[]> = {
    'components/approval.tsx': ['approveAction(', 'rejectAction('],
    'components/execution-card.tsx': ['approveAction(', 'rejectAction('],
    'components/concierge/task-object.tsx': ['approveAction(', 'rejectAction(', 'cancelExecution('],
    'components/memory-row.tsx': ['confirmMemory(', 'retractMemory('],
    'components/importance.tsx': ['setSiteImportance('],
  };
  for (const [file, calls] of Object.entries(CONTROLS)) {
    it(`${file}: reads the availability, guards the handler and disables the controls`, () => {
      const s = src(file);
      expect(s).toMatch(/useActionsOffReason\(\)/);
      expect(s).toMatch(/if \(off\) return;/);
      const sites = calls.reduce((n, c) => n + (s.split(c).length - 1), 0) - (s.match(/import \{[^}]*\}/g) ?? []).length * 0;
      const gated = (s.match(/!!off/g) ?? []).length;
      expect(gated, `${file}: ${gated} gated controls for ${sites} call sites`).toBeGreaterThanOrEqual(sites);
    });
  }
  it('the setting never reaches the browser: the client context carries only presentation text, and nothing is NEXT_PUBLIC', () => {
    const ctx = src('components/agent-availability.tsx');
    expect(ctx).not.toMatch(/process\.env/);
    for (const f of ['lib/agentConfig.ts', 'lib/wendy.ts', 'lib/writeCore.ts', 'components/agent-availability.tsx']) expect(src(f)).not.toMatch(/NEXT_PUBLIC_WENDY_AGENT/);
  });
});
