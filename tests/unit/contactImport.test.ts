/** Concierge 1: importing an address book. Synthetic data only; real skill runtime and approvals; isolated database; nothing is sent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPerson, createPrincipal } from '../../src/events/world.js';
import { findContacts, normalizePhoneLoose } from '../../src/people/contacts.js';
import { applyImport, parseCsv, planImport, readContacts, resolveImportFile, sha256File } from '../../src/people/contactImport.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { executionView } from '../../src/skills/view.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-import-'));
process.env.WENDY_IMPORT_DIR = dir;
const clock = fixedClock('2026-10-16T12:00:00Z');
let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  return t.drop();
});

const CSV = [
  'Name,Phone 1 - Value',
  'Ana Souza,+5511999990001', // already in a clean form
  'Bruno Lima,+55 11 99999-0002', // formatted
  'Carla Dias,11999990003', // area code + number, no country code
  'Davi Reis,5511999990004', // country code, no plus
  'Eva Costa,999990005', // no area code
  'Fabio Nunes,99990006', // no area code (8 digits)
  'Gabi Melo,+21999990007', // plus but missing country code: suspect
  'Hugo Alves,+14155550100', // North America
  'Iara Viana,', // no phone
  ',+5511999990009', // no name
  'Ana Souza,+5511999990001', // same number again in the file
  'Joao Pires,+5511999990010', // a number that is already on file
  '"Maria, a Grande",+5511999990011 ::: +5511999990012', // quoted comma, two numbers in one cell
  'Ana Souza,+5511999990013', // same name, different phone
  '',
].join('\r\n');

describe('phone shapes found in a real address book', () => {
  it('completes what is certain, and refuses to guess what is not', () => {
    const r = (s: string, o = {}) => normalizePhoneLoose(s, o);
    expect(r('+5521967370405')).toEqual({ phone: '+5521967370405' });
    expect(r('+55 21 96737-0405')).toEqual({ phone: '+5521967370405' });
    expect(r('21967370405')).toEqual({ phone: '+5521967370405' }); // area code + number → country code added
    expect(r('2167370405')).toEqual({ phone: '+552167370405' }); // landline
    expect(r('5521967370405')).toEqual({ phone: '+5521967370405' }); // country code without the plus
    expect(r('+14155550100')).toEqual({ phone: '+14155550100' }); // North America
    expect(r('00 351 912 345 678')).toEqual({ phone: '+351912345678' }); // 00 international prefix
    expect(r('967370405')).toEqual({ phone: null, reason: 'sem_ddd' }); // 9 digits: no area code, never guessed
    expect(r('67370405')).toEqual({ phone: null, reason: 'sem_ddd' });
    expect(r('+21967370405')).toEqual({ phone: null, reason: 'suspeito' }); // "+" with 11 digits that is not +1…
    expect(r('(021) 96737-0405')).toEqual({ phone: '+5521967370405' }); // trunk prefix 0 before the area code is only a dialling prefix
    expect(r('(021) 6737-0405')).toEqual({ phone: '+552167370405' });
    expect(r('0967370405')).toEqual({ phone: null, reason: 'invalido' }); // 0 + 9 digits is neither a number with area code nor without one: not guessed
    expect(r('00967370405')).toEqual({ phone: null, reason: 'invalido' }); // an area code cannot start with 0
    expect(r('')).toEqual({ phone: null, reason: 'vazio' });
    expect(r('abc')).toEqual({ phone: null, reason: 'invalido' });
    expect(r('967370405', { area: '21' })).toEqual({ phone: '+5521967370405' }); // only when the principal TELLS the area code
    expect(r('967370405', { area: '0x' })).toEqual({ phone: null, reason: 'sem_ddd' });
  });
});

describe('reading the CSV', () => {
  it('handles BOM, CRLF, quoted commas and doubled quotes, and several numbers in one cell', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    const rows = readContacts(CSV);
    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.name === 'Maria, a Grande')!.phones).toEqual(['+5511999990011', '+5511999990012']);
  });
  it('reads First/Last Name too, ignores every other column, and refuses a file it does not understand', () => {
    expect(readContacts('First Name,Last Name,E-mail 1 - Value,Phone 1 - Value\nAna,Souza,a@b.c,+5511999990001\n')).toEqual([{ line: 2, name: 'Ana Souza', phones: ['+5511999990001'] }]);
    expect(() => readContacts('foo,bar\n1,2\n')).toThrow(/não reconheci as colunas/);
    expect(() => readContacts('Name,Phone 1 - Value\n')).toThrow(/não tem linhas/);
  });
});

describe('planning', () => {
  it('counts each kind exactly, never creates a duplicate phone, and lists what is left out with the reason', async () => {
    await createPerson(db, pid, { fullName: 'Joao Pires', emails: [], source: 'PRINCIPAL_CONTACT' });
    const jp = (await db.query<{ id: string }>(`SELECT id FROM people WHERE full_name = 'Joao Pires'`)).rows[0]!.id;
    await db.query(`INSERT INTO person_identifiers(principal_id, kind, value, person_id) VALUES ($1,'phone','+5511999990010',$2)`, [pid, jp]);
    const plan = await planImport(db, pid, readContacts(CSV));
    expect(plan.summary).toMatchObject({ total: 14, toCreate: 7, alreadyKnown: 1, duplicatesInFile: 1, noName: 1, noPhone: 1, invalidPhone: 3, invalidReasons: { sem_ddd: 2, suspeito: 1 } });
    expect(plan.create.map((c) => c.name)).toEqual(['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Davi Reis', 'Hugo Alves', 'Maria, a Grande', 'Ana Souza']);
    expect(plan.create.find((c) => c.name === 'Maria, a Grande')!.phones).toHaveLength(2);
    expect(plan.summary.sharedNames).toBe(2); // the two Ana Souza stay separate people: the phone tells them apart
    expect(plan.skipped.map((k) => k.reason).sort()).toEqual(['sem nome', 'sem telefone', 'telefone sem DDD', 'telefone sem DDD', 'telefone suspeito (parece faltar o código do país)']);
  });
  it('the import folder is the only place a file can come from: no paths, no traversal, no symlink out', () => {
    fs.writeFileSync(path.join(dir, 'c.csv'), CSV);
    expect(resolveImportFile('c.csv')).toBe(fs.realpathSync(path.join(dir, 'c.csv')));
    for (const bad of ['../x.csv', '/etc/passwd', 'sub/c.csv', '.hidden', '']) expect(() => resolveImportFile(bad), bad).toThrow();
    expect(() => resolveImportFile('missing.csv')).toThrow(/não encontrado/);
    const outside = path.join(os.tmpdir(), `wendy-outside-${process.pid}.csv`);
    fs.writeFileSync(outside, CSV);
    fs.symlinkSync(outside, path.join(dir, 'link.csv'));
    expect(() => resolveImportFile('link.csv')).toThrow(/dentro da pasta/);
    fs.rmSync(outside);
  });
});

describe('the whole flow: plan → approval card → approve → contacts', () => {
  const setup = () => createSkillRuntime(createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) }), { toolbox: new Toolbox({ search: () => { throw new Error('no'); } }), sleep: async () => {} });

  it('writes nothing before approval, shows the counts on the card, imports exactly the approved file, and leaves a private report', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int n FROM people')).rows[0]!.n;
    const { runtime } = setup();
    const id = await runtime.start(pid, 'contact-import', { file: 'c.csv' }, { kind: 'test' });
    await runtime.advance(id);
    const parked = (await runtime.get(id))!;
    expect(parked.status).toBe('waiting_permission');
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM people')).rows[0]!.n).toBe(before);
    const card = (await executionView(db, builtinRegistry(), pid, id))!.approvals[0]!;
    expect(card).toMatchObject({ tool: 'contacts.import', label: 'Importar contatos' });
    expect(card.items).toContain('7 contatos novos serão criados');
    expect(card.items).toContain('Nada é enviado a ninguém; só são guardados nome e telefone');
    const report = path.join(dir, 'c.csv.relatorio.csv');
    expect(fs.statSync(report).mode & 0o777).toBe(0o600); // the report holds personal data: owner only
    expect(fs.readFileSync(report, 'utf8')).toMatch(/telefone sem DDD/);

    await new ActionService(db).approve(pid, parked.wait!.id, clock.now());
    await runtime.runReady();
    expect((await runtime.get(id))!.status).toBe('completed');
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM people')).rows[0]!.n).toBe(before + 7);
    expect((await findContacts(db, pid, { phone: '99990004' }))[0]).toMatchObject({ fullName: 'Davi Reis', phones: ['+5511999990004'], emails: [], origin: 'PRINCIPAL' });
    expect((await findContacts(db, pid, { text: 'maria grande' }))[0]!.phones).toEqual(['+5511999990011', '+5511999990012']);
    expect((await findContacts(db, pid, { text: 'davi' }))[0]!.notes[0]).toMatch(/^\[2026-10-16\] importado de arquivo de contatos \(#imp-/);
    expect((await db.query(`SELECT state FROM actions WHERE id = $1`, [parked.wait!.id])).rows[0]!.state).toBe('VERIFIED');
  });
  it('running the same file again has nothing to import and creates nobody', async () => {
    const { runtime } = setup();
    const id = await runtime.start(pid, 'contact-import', { file: 'c.csv' }, { kind: 'test' });
    await runtime.advance(id);
    const r = (await runtime.get(id))!;
    expect(r.status).toBe('completed');
    expect(r.output).toMatchObject({ status: 'nothing_to_import' });
  });
  it('a file changed after approval is refused, and nothing is imported', async () => {
    const f = path.join(dir, 'd.csv');
    fs.writeFileSync(f, 'Name,Phone 1 - Value\nNovo Contato,+5511988880001\n');
    const { runtime } = setup();
    const id = await runtime.start(pid, 'contact-import', { file: 'd.csv' }, { kind: 'test' });
    await runtime.advance(id);
    const parked = (await runtime.get(id))!;
    fs.writeFileSync(f, 'Name,Phone 1 - Value\nOutra Pessoa,+5511988880002\n'); // swapped after the approval was requested
    await new ActionService(db).approve(pid, parked.wait!.id, clock.now());
    await runtime.runReady();
    expect((await findContacts(db, pid, { text: 'outra pessoa' })).length).toBe(0);
    expect((await findContacts(db, pid, { text: 'novo contato' })).length).toBe(0);
    expect((await runtime.get(id))!.status).toBe('failed');
  });
  it('the ledger records counts only, never a name or a number, and nothing was sent', async () => {
    const text = JSON.stringify((await db.query(`SELECT payload FROM audit_blocks WHERE event_type = 'CONTACTS_IMPORTED'`)).rows);
    expect(text).toContain('created');
    for (const secret of ['Davi', 'Maria', '99990004', '+5511']) expect(text, secret).not.toContain(secret);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM dev_outbound_mail')).rows[0]!.n).toBe(0);
  });
  it('applyImport itself never creates a second person for a number that appeared after the plan', async () => {
    const plan = await planImport(db, pid, [{ line: 2, name: 'Racer', phones: ['+5511977770001'] }]);
    await db.query(`INSERT INTO people(id, principal_id, full_name, source) VALUES ('11111111-1111-4111-8111-111111111111', $1, 'Quem Chegou Antes', 'PRINCIPAL_CONTACT')`, [pid]);
    await db.query(`INSERT INTO person_identifiers(principal_id, kind, value, person_id) VALUES ($1,'phone','+5511977770001','11111111-1111-4111-8111-111111111111')`, [pid]);
    expect((await applyImport(db, pid, plan, sha256File(path.join(dir, 'c.csv')), clock.now())).created).toBe(0);
  });
});
