/** Search ignores accents and reduces words to their stem in Portuguese and English (migration 004). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx, type Db } from '../../src/db/db.js';
import { createPerson, createPrincipal, storeMessage } from '../../src/events/world.js';
import { pgRepositories } from '../../src/repositories/pg.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const repos = pgRepositories();
const far = [new Date('2000-01-01'), new Date('2100-01-01')] as const;
const subjects = ['Renovação do contrato', 'Reunião do conselho', 'Proposta comercial', 'Preço por usuário', 'Volume discounts', 'Orçamento aprovado', 'Almoço sexta'];

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
  await createPerson(db, pid, { fullName: 'Ana', emails: ['ana@example.test'], source: 'TEST' });
  await withTx(db, async (tx) => {
    for (const [i, s] of subjects.entries()) await storeMessage(tx, pid, { provider: 'test', externalId: `s${i}`, from: 'ana@example.test', to: ['p@example.test'], subject: s, body: '', sentAt: new Date('2026-09-01') });
  });
});
afterAll(() => t.drop());

const find = async (term: string) => (await repos.messages.search(db, pid, [term], far[0], far[1], 10)).map((m) => m.subject).sort();

describe('search', () => {
  it.each([
    ['renovações', ['Renovação do contrato']], // Portuguese plural, accented
    ['reuniao', ['Reunião do conselho']], // typed without accent
    ['propostas', ['Proposta comercial']],
    ['precos', ['Preço por usuário']], // plural and no accent
    ['discount', ['Volume discounts']], // English stem
    ['orcamento', ['Orçamento aprovado']],
  ])('"%s" finds %j', async (term, expected) => {
    expect(await find(term)).toEqual(expected);
  });

  it('does not invent matches: synonyms and translations are not found lexically', async () => {
    expect(await find('acordo')).toEqual([]);
    expect(await find('budget')).toEqual([]);
  });
});
