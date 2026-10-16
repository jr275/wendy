/** Concierge 1: contacts. Real skill runtime and approvals, isolated database, no model, no network, nothing sent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPerson, createPrincipal } from '../../src/events/world.js';
import { findContacts, getContact, normalizeName, normalizePhone, saveContact } from '../../src/people/contacts.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { contactManagement } from '../../src/skills/builtin/contactManagement.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const clock = fixedClock('2026-10-16T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  await createPerson(db, pid, { fullName: 'Lucas Teste', emails: ['lucas@example.test'], source: 'GMAIL' }); // someone found in e-mail
});
afterAll(() => t.drop());

const setup = () => createSkillRuntime(createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) }), { toolbox: new Toolbox({ search: () => { throw new Error('no search'); } }), sleep: async () => {} });
async function run(input: Record<string, unknown>, decision: 'approve' | 'reject' | 'none' = 'approve') {
  const { runtime } = setup();
  const id = await runtime.start(pid, 'contact-management', input, { kind: 'test' });
  await runtime.advance(id);
  let r = (await runtime.get(id))!;
  const actionId = r.status === 'waiting_permission' ? r.wait!.id : null;
  if (actionId && decision !== 'none') {
    if (decision === 'approve') await new ActionService(db).approve(pid, actionId, clock.now());
    else await new ActionService(db).reject(pid, actionId, 'não', clock.now());
    await runtime.runReady();
    r = (await runtime.get(id))!;
  }
  return { r, actionId };
}
const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0]!.n;
const ALEX = { operation: 'save', fullName: 'Alexandre', phone: '+55 21 96737-0405', context: 'contato que compra ingressos' };

describe('helpers', () => {
  it('normalizes a phone to +country digits, and refuses one without a country code instead of guessing it', () => {
    expect(normalizePhone('+55 21 96737-0405')).toBe('+5521967370405');
    expect(normalizePhone('+55 (21) 96737-0405')).toBe('+5521967370405');
    for (const bad of ['21 96737-0405', '96737-0405', '+55', 'abc', '']) expect(normalizePhone(bad), bad).toBeNull();
    expect(normalizeName('  ALÉXANDRE   Silva ')).toBe('alexandre silva');
  });
});

describe('saving a contact (the case that started it)', () => {
  it('asks before storing anything; after approval stores exactly the name, phone and context given, and nothing else', async () => {
    const before = await count('SELECT count(*)::int n FROM people');
    const { r, actionId } = await run(ALEX, 'none');
    expect(r.status).toBe('waiting_permission');
    expect(await count('SELECT count(*)::int n FROM people')).toBe(before); // nothing before approval
    await new ActionService(db).approve(pid, actionId!, clock.now());
    const { runtime } = setup();
    await runtime.runReady();
    const row = (await db.query(`SELECT id, full_name, title, organization_id, birthdate, source FROM people WHERE full_name = 'Alexandre'`)).rows[0];
    expect(row).toMatchObject({ full_name: 'Alexandre', title: null, organization_id: null, birthdate: null, source: 'PRINCIPAL_CONTACT' });
    const c = (await getContact(db, pid, row.id))!;
    expect(c).toMatchObject({ fullName: 'Alexandre', phones: ['+5521967370405'], emails: [], context: 'contato que compra ingressos', notes: [], origin: 'PRINCIPAL' });
    expect(await count('SELECT count(*)::int n FROM people')).toBe(before + 1);
    expect((await db.query(`SELECT state FROM actions WHERE id = $1`, [actionId])).rows[0].state).toBe('VERIFIED');
  });

  it('the same phone is the same person, however it is written: it is not duplicated, the stored name and context stay', async () => {
    const before = await count('SELECT count(*)::int n FROM people');
    const { r } = await run({ operation: 'save', fullName: 'Alex', phone: '+55 (21) 96737-0405', note: 'prefere falar de manhã' });
    expect(r.status).toBe('completed');
    expect(await count('SELECT count(*)::int n FROM people')).toBe(before);
    const [c] = await findContacts(db, pid, { text: 'alexandre' });
    expect(c!.fullName).toBe('Alexandre'); // not renamed to "Alex"
    expect(c!.context).toBe('contato que compra ingressos');
    expect(c!.notes).toHaveLength(1);
    expect(c!.notes[0]).toMatch(/^\[2026-10-16\] prefere falar de manhã/);
  });

  it('the same name without a phone is a possible duplicate: Wendy asks, and no approval is even requested', async () => {
    const before = await count(`SELECT count(*)::int n FROM actions`);
    const { r, actionId } = await run({ operation: 'save', fullName: 'alexandre' }, 'none');
    expect(actionId).toBeNull();
    expect(r.status).toBe('completed');
    expect(r.output).toMatchObject({ status: 'needs_confirmation' });
    expect((r.output as { contacts: unknown[] }).contacts).toHaveLength(1);
    expect(await count(`SELECT count(*)::int n FROM actions`)).toBe(before);
  });

  it('after the principal confirms it is another person, the second contact is created', async () => {
    const { r } = await run({ operation: 'save', fullName: 'Alexandre', context: 'outro Alexandre, vizinho', allowDuplicateName: true });
    expect(r.status).toBe('completed');
    expect(await count(`SELECT count(*)::int n FROM people WHERE full_name = 'Alexandre'`)).toBe(2);
  });

  it('a number without a country code is not guessed: the run stops with a clear reason and stores nothing', async () => {
    const before = await count('SELECT count(*)::int n FROM people');
    const { r, actionId } = await run({ operation: 'save', fullName: 'Beatriz', phone: '21 98888-7777' }, 'none');
    expect(actionId).toBeNull();
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toMatch(/código do país/);
    expect(await count('SELECT count(*)::int n FROM people')).toBe(before);
  });

  it('a refusal stores nothing and is reported honestly', async () => {
    const { r } = await run({ operation: 'save', fullName: 'Carolina', phone: '+55 11 91234-5678' }, 'reject');
    expect(r.status).toBe('completed');
    expect(r.output).toMatchObject({ status: 'declined' });
    expect(await count(`SELECT count(*)::int n FROM people WHERE full_name = 'Carolina'`)).toBe(0);
  });

  it('a retried execution of the same approved action never repeats a note', async () => {
    const [c] = await findContacts(db, pid, { phone: '0405' });
    await saveContact(db, pid, '11111111-2222-3333-4444-555555555555', { personId: c!.id, note: 'só uma vez' }, clock.now());
    await saveContact(db, pid, '11111111-2222-3333-4444-555555555555', { personId: c!.id, note: 'só uma vez' }, clock.now());
    expect((await getContact(db, pid, c!.id))!.notes.filter((n) => n.includes('só uma vez'))).toHaveLength(1);
  });

  it('the service protects itself even when called without the skill\'s pre-check: a known phone attaches to its person and creates nobody', async () => {
    const before = await count('SELECT count(*)::int n FROM people');
    const r = await saveContact(db, pid, '22222222-3333-4444-5555-666666666666', { fullName: 'Outro Nome', phone: '+5521967370405', note: 'direto no serviço' }, clock.now());
    expect(r.created).toBe(false);
    expect(r.contact.fullName).toBe('Alexandre');
    expect(await count('SELECT count(*)::int n FROM people')).toBe(before);
    expect(await count(`SELECT count(*)::int n FROM people WHERE full_name = 'Outro Nome'`)).toBe(0); // no orphan without its phone
  });

  it('the service refuses a second person with the same name unless the principal confirmed it', async () => {
    await expect(saveContact(db, pid, '33333333-4444-5555-6666-777777777777', { fullName: 'ALEXANDRE' }, clock.now())).rejects.toThrow(/já existe um contato/);
  });

  it('the ledger says a contact was saved and which kinds of fact, never the name, number or note', async () => {
    const rows = (await db.query(`SELECT payload FROM audit_blocks WHERE event_type = 'CONTACT_SAVED'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).toContain('phone');
    for (const secret of ['Alexandre', '96737', 'ingressos', 'falar de manhã']) expect(text, secret).not.toContain(secret);
  });
});

describe('finding contacts: by name, phone or context', () => {
  it('finds by name ignoring case and accents, by the last digits of the phone, and by words of the context', async () => {
    expect((await findContacts(db, pid, { text: 'ALÉXANDRE' })).map((c) => c.fullName)).toContain('Alexandre');
    expect((await findContacts(db, pid, { phone: '0405' })).map((c) => c.fullName)).toEqual(['Alexandre']);
    expect((await findContacts(db, pid, { text: 'ingressos' })).map((c) => c.fullName)).toEqual(['Alexandre']);
    expect((await findContacts(db, pid, { text: 'compra ingressos' })).length).toBe(1); // every word must match
  });
  it('answers "who is X" with the stored context, and says nothing more than what is stored', async () => {
    const [c] = await findContacts(db, pid, { text: 'alexandre', phone: '0405' });
    expect(c).toMatchObject({ fullName: 'Alexandre', context: 'contato que compra ingressos', emails: [], origin: 'PRINCIPAL' });
    expect(Object.keys(c!).sort()).toEqual(['context', 'emails', 'fullName', 'id', 'notes', 'origin', 'phones']); // no invented fields
  });
  it('people found in e-mail are searchable too, and are marked as coming from the mailbox', async () => {
    expect(await findContacts(db, pid, { text: 'lucas' })).toMatchObject([{ fullName: 'Lucas Teste', origin: 'MAILBOX', emails: ['lucas@example.test'], phones: [] }]);
  });
  it('an unknown name is an empty answer, a too-short phone fragment is an error, and another principal sees nothing', async () => {
    expect(await findContacts(db, pid, { text: 'zzzz' })).toEqual([]);
    await expect(findContacts(db, pid, { phone: '12' })).rejects.toThrow(/4 dígitos/);
    const other = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
    expect(await findContacts(db, other, { text: 'alexandre' })).toEqual([]);
  });
});

describe('what this can never do', () => {
  it('has no tool to message or call anyone, and sent nothing during all of the above', async () => {
    expect(contactManagement.requiredTools).toEqual(['contacts.find', 'contacts.save']);
    expect(contactManagement.autonomous).toBe(false);
    expect(await count('SELECT count(*)::int n FROM dev_outbound_mail')).toBe(0);
  });
});
