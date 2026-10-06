import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService, ALLOWED_TRANSITIONS, IllegalTransitionError, proposeAction, type ActionRow } from '../../src/actions/actions.js';
import { ActionExecutor } from '../../src/actions/executor.js';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { withTx, type Db } from '../../src/db/db.js';
import { ActionState } from '../../src/domain/types.js';
import { createPerson, createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import type { EmailProvider } from '../../src/providers/interfaces.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
let personId: string;
const now = () => new Date();

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'en' });
  personId = await createPerson(db, principalId, { fullName: 'Recipient Person', emails: ['r@example.test'], source: 'TEST' });
});
afterAll(() => t.drop());

const email = { to: ['r@example.test'], to_person_id: '', subject: 'Hello', body: 'Body v1' };

async function propose(type: 'SEND_EMAIL' | 'PREPARE_BRIEFING', expiresAt: Date | null = null): Promise<ActionRow> {
  const content = type === 'SEND_EMAIL' ? { ...email, to_person_id: personId } : { title: 'Brief', sections: [] };
  return withTx(db, (tx) => proposeAction(tx, { principalId, insightId: null, type, targetPersonId: personId, content, expiresAt }));
}

const mailboxCount = async (d: Db = db) => Number((await d.query('SELECT count(*) AS n FROM dev_outbound_mail')).rows[0].n);
const stateOf = async (id: string, d: Db = db) => (await d.query<{ state: string }>('SELECT state FROM actions WHERE id = $1', [id])).rows[0]!.state;
const sentFor = async (actionId: string) => Number((await db.query('SELECT count(*) AS n FROM dev_outbound_mail WHERE idempotency_key = $1', [`wendy-action:${actionId}`])).rows[0].n);
const executionsOf = async (id: string) => Number((await db.query('SELECT count(*) AS n FROM action_executions WHERE action_id = $1', [id])).rows[0].n);

describe('state machine & policy', () => {
  it('every non-listed transition is illegal; terminal states have no exits', () => {
    for (const s of ['VERIFIED', 'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const) expect(ALLOWED_TRANSITIONS[s]).toEqual([]);
    expect(ALLOWED_TRANSITIONS.REJECTED.includes('APPROVED' as never)).toBe(false);
  });

  it('external email (level 3) waits for approval; internal briefing (level 1) is auto-approved by policy', async () => {
    const mail = await propose('SEND_EMAIL');
    const brief = await propose('PREPARE_BRIEFING');
    expect(mail.state).toBe(ActionState.AWAITING_APPROVAL);
    expect(mail.policy_decision.mode).toBe('REQUIRE_APPROVAL');
    expect(await executionsOf(mail.id)).toBe(0);
    expect(brief.state).toBe(ActionState.APPROVED);
    expect(await executionsOf(brief.id)).toBe(1);
    const transitions = (await db.query('SELECT from_state, to_state, actor FROM action_transitions WHERE action_id = $1 ORDER BY id', [mail.id])).rows;
    expect(transitions.map((r) => r.to_state)).toEqual(['PROPOSED', 'STAGED', 'AWAITING_APPROVAL']);
  });

  it('rejection persists, writes an outcome memory, and blocks later approval', async () => {
    const svc = new ActionService(db);
    const a = await propose('SEND_EMAIL');
    await svc.reject(principalId, a.id, 'not now', now());
    const fresh = t.reconnect(); // restart
    expect(await stateOf(a.id, fresh)).toBe('REJECTED');
    const outcome = (await fresh.query(`SELECT content FROM memories WHERE kind = 'OUTCOME' AND evidence @> $1::jsonb`, [JSON.stringify([{ kind: 'action', id: a.id }])])).rows[0];
    expect(outcome.content).toContain('REJECTED');
    await expect(new ActionService(fresh).approve(principalId, a.id, now())).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('approval after expiry moves the action to EXPIRED instead', async () => {
    const a = await propose('SEND_EMAIL', new Date(Date.now() - 1000));
    await expect(new ActionService(db).approve(principalId, a.id, now())).rejects.toThrow(/expired/);
    expect(await stateOf(a.id)).toBe('EXPIRED');
  });

  it('expireDue expires pending actions past their deadline', async () => {
    const a = await propose('SEND_EMAIL', new Date(Date.now() + 1000));
    expect(await new ActionService(db).expireDue(principalId, new Date(Date.now() + 5000))).toBeGreaterThanOrEqual(1);
    expect(await stateOf(a.id)).toBe('EXPIRED');
  });

  it('another principal cannot approve the action', async () => {
    const other = await createPrincipal(db, { displayName: 'O', primaryEmail: 'o@example.test', timezone: 'UTC', locale: 'en' });
    const a = await propose('SEND_EMAIL');
    await expect(new ActionService(db).approve(other, a.id, now())).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe('idempotent execution', () => {
  it('concurrent double approval produces exactly one approval and one execution', async () => {
    const a = await propose('SEND_EMAIL');
    const svc = new ActionService(db);
    const results = await Promise.allSettled([svc.approve(principalId, a.id, now()), svc.approve(principalId, a.id, now())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await executionsOf(a.id)).toBe(1);
  });

  it('executes once, verifies by read-back, labels the dev provider as not delivering externally; re-runs do nothing', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now());
    const exec = new ActionExecutor(db, new DevMailboxProvider(db));
    await exec.runPending();
    await exec.runPending();
    await new ActionExecutor(t.reconnect(), new DevMailboxProvider(db)).runPending(); // after "restart"
    expect(await sentFor(a.id)).toBe(1);
    expect(await stateOf(a.id)).toBe('VERIFIED');
    const v = (await db.query('SELECT verification FROM action_executions WHERE action_id = $1', [a.id])).rows[0].verification;
    expect(v).toMatchObject({ provider: 'DEV_LOCAL_MAILBOX', deliversExternally: false, readBackFound: true, contentMatches: true });
  });

  it('edited content becomes a new PRINCIPAL version and that version is what gets executed', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now(), { body: 'Edited by principal' });
    await new ActionExecutor(db, new DevMailboxProvider(db)).runPending();
    const sent = (await db.query(`SELECT body FROM dev_outbound_mail WHERE idempotency_key = $1`, [`wendy-action:${a.id}`])).rows;
    expect(sent).toEqual([{ body: 'Edited by principal' }]);
    const v = (await db.query('SELECT version, author FROM action_versions WHERE action_id = $1 ORDER BY version', [a.id])).rows;
    expect(v).toEqual([{ version: 1, author: 'WENDY' }, { version: 2, author: 'PRINCIPAL' }]);
    expect(await stateOf(a.id)).toBe('VERIFIED');
  });

  it('crash after the provider accepted (before recording) → restart reconciles by key, no duplicate send', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now());
    const before = await mailboxCount();
    const crashing = new ActionExecutor(db, new DevMailboxProvider(db), {
      afterProviderAccepted: () => {
        throw new Error('SIMULATED PROCESS CRASH');
      },
    });
    await expect(crashing.runPending()).rejects.toThrow('SIMULATED PROCESS CRASH');
    expect(await stateOf(a.id)).toBe('EXECUTING');

    const restarted = new ActionExecutor(t.reconnect(), new DevMailboxProvider(db));
    await restarted.reconcileInFlight(new Date(Date.now() + 1000));
    await restarted.runPending();
    expect(await sentFor(a.id)).toBe(1);
    expect(await stateOf(a.id)).toBe('VERIFIED');
  });

  it('provider failure before acceptance → retried safely, sent exactly once', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now());
    const real = new DevMailboxProvider(db);
    let failures = 1;
    const flaky: EmailProvider = {
      name: real.name,
      deliversExternally: false,
      send: async (p, m) => {
        if (failures-- > 0) throw new Error('connection reset');
        return real.send(p, m);
      },
      findByIdempotencyKey: (p, k) => real.findByIdempotencyKey(p, k),
    };
    const before = await mailboxCount();
    const exec = new ActionExecutor(db, flaky);
    await exec.runPending(); // fails, reconciled back to PENDING, then claimed again in the same run
    expect(await sentFor(a.id)).toBe(1);
    expect(await stateOf(a.id)).toBe('VERIFIED');
  });

  it('read-back mismatch fails verification instead of claiming success', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now());
    const real = new DevMailboxProvider(db);
    const lying: EmailProvider = {
      name: real.name,
      deliversExternally: false,
      send: (p, m) => real.send(p, { ...m, body: 'something else' }),
      findByIdempotencyKey: (p, k) => real.findByIdempotencyKey(p, k),
    };
    await new ActionExecutor(db, lying).runPending();
    expect(await stateOf(a.id)).toBe('FAILED');
  });

  it('executor refuses to run on a tampered ledger (fail closed)', async () => {
    const a = await propose('SEND_EMAIL');
    await new ActionService(db).approve(principalId, a.id, now());
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
    await db.query(`UPDATE audit_blocks SET actor = 'forged' WHERE seq = 1`);
    const before = await mailboxCount();
    await expect(new ActionExecutor(db, new DevMailboxProvider(db)).runPending()).rejects.toThrow(/integrity/);
    expect(await mailboxCount()).toBe(before);
    expect(await stateOf(a.id)).toBe('APPROVED');
  });
});
