import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { approvalItems } from '../../src/skills/approvalItems.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { executionView } from '../../src/skills/view.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

describe('approvalItems: the card says what will happen', () => {
  it('a new contact shows exactly the name, phone, context and note the principal gave, and nothing else', () => {
    expect(approvalItems('contacts.save', { fullName: 'Alexandre', phone: '+55 21 96737-0405', context: 'contato que compra ingressos' })).toEqual(['Nome: Alexandre', 'Telefone: +55 21 96737-0405', 'Contexto: contato que compra ingressos']);
    expect(approvalItems('contacts.save', { personId: 'x', note: 'prefere de manhã' }, { contactName: 'Alexandre' })).toEqual(['Contato existente: Alexandre', 'Nota: prefere de manhã']);
    expect(approvalItems('contacts.save', { fullName: 'Ana', allowDuplicateName: true })).toContain('Você confirmou que é outra pessoa com o mesmo nome');
  });
  it('a task change lists the task and each change in words', () => {
    expect(approvalItems('tasks.update', { taskId: 't', priority: 'URGENT', category: 'casa', archived: true }, { taskTitle: 'Renovar o seguro' })).toEqual(['Renovar o seguro', 'Prioridade: urgente', 'Categoria: casa', 'Arquivar']);
    expect(approvalItems('tasks.update', { taskId: 't', priority: null, snoozedUntil: null }, { taskTitle: 'X' })).toEqual(['X', 'Remover a prioridade', 'Trazer de volta (sem adiamento)']);
    expect(approvalItems('tasks.update', { taskId: 't', snoozedUntil: '2026-11-02T15:00:00Z' }, { taskTitle: 'X' })[1]).toMatch(/^Adiar até 02\/11\/2026,? 12:00/);
  });
  it('an import shows counts and the promise that nothing is sent, and omits zero lines', () => {
    const lines = approvalItems('contacts.import', { fileName: 'c.csv', summary: { toCreate: 900, alreadyKnown: 3, duplicatesInFile: 0, noPhone: 10, invalidPhone: 90, noName: 0 } });
    expect(lines).toEqual(['Arquivo: c.csv', '900 contatos novos serão criados', '3 já existem (mesmo telefone) e não serão duplicados', '10 sem telefone ficam de fora', '90 com telefone incompleto ficam de fora (listados no relatório)', 'Nada é enviado a ninguém; só são guardados nome e telefone']);
  });
  it('tools without a description return nothing (the caller falls back)', () => {
    expect(approvalItems('web.search', {})).toEqual([]);
  });
});

describe('approvalItems: the real card of a contact waiting for approval', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let pid: string;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  });
  afterAll(() => t.drop());
  it('executionView lists the contact content, so approving is an informed choice (it used to show only the label)', async () => {
    const { runtime, registry } = createSkillRuntime(createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock: fixedClock('2026-10-16T12:00:00Z'), emailProvider: new DevMailboxProvider(db) }), { toolbox: new Toolbox({ search: () => { throw new Error('no'); } }), sleep: async () => {} });
    const id = await runtime.start(pid, 'contact-management', { operation: 'save', fullName: 'Alexandre', phone: '+55 21 96737-0405', context: 'contato que compra ingressos' }, { kind: 'test' });
    await runtime.advance(id);
    const v = (await executionView(db, registry ?? builtinRegistry(), pid, id))!;
    expect(v.approvals).toHaveLength(1);
    expect(v.approvals[0]).toMatchObject({ tool: 'contacts.save', label: 'Salvar contato', state: 'AWAITING_APPROVAL', items: ['Nome: Alexandre', 'Telefone: +55 21 96737-0405', 'Contexto: contato que compra ingressos'] });
  });
});
