import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { CommitmentService, CommitmentTransitionError, proposeCommitment } from '../../src/commitments/commitmentService.js';
import { withTx, type Db } from '../../src/db/db.js';
import { createPerson, createPrincipal, storeMessage } from '../../src/events/world.js';
import { pgRepositories } from '../../src/repositories/pg.js';
import { DAY_MS } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
let otherPrincipalId: string;
let personId: string;
let messageId: string;
const now = new Date('2026-10-06T12:00:00Z');
const friday = new Date('2026-10-09T21:00:00Z');
const repos = pgRepositories();

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
  otherPrincipalId = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
  personId = await createPerson(db, principalId, { fullName: 'Ana', emails: ['ana@example.test'], source: 'TEST' });
  messageId = (
    await withTx(db, (tx) =>
      storeMessage(tx, principalId, { provider: 'test', externalId: 'promise', from: 'p@example.test', to: ['ana@example.test'], subject: 'Proposta', body: 'Oi Ana,\nvou te enviar a proposta revisada até sexta.\nAbraço', sentAt: now }),
    )
  ).messageId;
});
afterAll(() => t.drop());

const propose = (quote: string, pid = principalId) =>
  withTx(db, (tx) => proposeCommitment(tx, { principalId: pid, owner: 'PRINCIPAL', counterpartyPersonId: personId, description: 'Enviar a proposta revisada para a Ana', dueAt: friday, sourceMessageId: messageId, quote, source: 'WENDY', now }));
const statusOf = async (id: string) => (await repos.commitments.get(db, principalId, id))!.status;

describe('commitment proposals', () => {
  it('are rejected unless the quote is literally in the source message (no invented promises)', async () => {
    await expect(propose('vou te mandar o contrato amanhã')).rejects.toBeInstanceOf(CommitmentTransitionError);
    await expect(propose('   ')).rejects.toBeInstanceOf(CommitmentTransitionError);
    await expect(propose('vou te enviar a proposta revisada até sexta', otherPrincipalId)).rejects.toBeInstanceOf(CommitmentTransitionError);
  });

  it('are recorded once (whitespace/case-insensitive quote match) and stay out of reasoning while PROPOSED', async () => {
    const id = await propose('Vou te enviar a proposta   revisada até sexta');
    expect(await propose('vou te enviar a proposta revisada até sexta')).toBe(id);
    expect(await statusOf(id)).toBe('PROPOSED');
    expect(await repos.commitments.openForPerson(db, principalId, personId)).toHaveLength(0);
    expect(await repos.commitments.search(db, principalId, ['proposta'], 10)).toHaveLength(0);
    expect(await repos.commitments.openDueBefore(db, principalId, new Date(friday.getTime() + DAY_MS))).toHaveLength(0);
  });
});

describe('commitment lifecycle', () => {
  it('confirm (with corrected date) → open and visible to reasoning → done; terminal afterwards', async () => {
    const svc = new CommitmentService(db);
    const id = (await db.query(`SELECT id FROM commitments WHERE status = 'PROPOSED'`)).rows[0].id as string;
    const monday = new Date('2026-10-12T15:00:00Z');
    await svc.confirm(principalId, id, now, monday);
    expect(await statusOf(id)).toBe('OPEN');
    expect((await repos.commitments.get(db, principalId, id))!.due_at.getTime()).toBe(monday.getTime());
    expect((await repos.commitments.openForPerson(db, principalId, personId)).map((c) => c.id)).toEqual([id]);
    await expect(svc.discard(principalId, id, null, now)).rejects.toThrow(/only proposed/);
    await svc.complete(principalId, id, now);
    expect(await statusOf(id)).toBe('DONE');
    await expect(svc.cancel(principalId, id, null, now)).rejects.toBeInstanceOf(CommitmentTransitionError);
    await expect(svc.reschedule(principalId, id, monday, now)).rejects.toBeInstanceOf(CommitmentTransitionError);
  });

  it('discarding a proposal cancels it; other principals cannot touch it; everything is audited', async () => {
    const svc = new CommitmentService(db);
    const id = await withTx(db, (tx) =>
      proposeCommitment(tx, { principalId, owner: 'PRINCIPAL', counterpartyPersonId: personId, description: 'x', dueAt: friday, sourceMessageId: messageId, quote: 'Abraço', source: 'WENDY', now }),
    );
    await expect(svc.discard(otherPrincipalId, id, null, now)).rejects.toThrow(/not found/);
    await svc.discard(principalId, id, 'não era uma promessa', now);
    expect(await statusOf(id)).toBe('CANCELLED');
    const types = (await db.query(`SELECT event_type FROM audit_blocks WHERE event_type LIKE 'COMMITMENT_%'`)).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['COMMITMENT_PROPOSED', 'COMMITMENT_OPEN', 'COMMITMENT_DONE', 'COMMITMENT_CANCELLED']));
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });

  it('the database refuses a PROPOSED commitment without a source quote', async () => {
    await expect(
      db.query(`INSERT INTO commitments(id, principal_id, owner, counterparty_person_id, description, due_at, status, source, created_at) VALUES (gen_random_uuid(), $1, 'PRINCIPAL', $2, 'x', now(), 'PROPOSED', 'X', now())`, [principalId, personId]),
    ).rejects.toThrow(/commitments_proposed_quote_check/);
  });
});
