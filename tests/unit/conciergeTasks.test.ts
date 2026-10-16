/** Concierge 1: tasks with the person's own priority/category, snooze and archive. Real runtime, isolated database, no model, no network. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import { getTask, listTasks, TaskService } from '../../src/tasks/taskService.js';
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
});
afterAll(() => t.drop());

const setup = () => createSkillRuntime(createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) }), { toolbox: new Toolbox({ search: () => { throw new Error('no search expected'); } }), sleep: async () => {} });

async function createTask(input: Record<string, unknown>): Promise<string> {
  const { runtime } = setup();
  const id = await runtime.start(pid, 'task-management', { operation: 'create', tasks: [input] }, { kind: 'test' });
  await runtime.advance(id);
  const parked = (await runtime.get(id))!;
  expect(parked.status).toBe('waiting_permission'); // creating still asks
  await new ActionService(db).approve(pid, parked.wait!.id, clock.now());
  await runtime.runReady();
  expect((await runtime.get(id))!.status).toBe('completed');
  return (await db.query<{ id: string }>(`SELECT id FROM tasks WHERE created_by_action = $1`, [parked.wait!.id])).rows[0]!.id;
}
async function update(patch: Record<string, unknown>) {
  const { runtime } = setup();
  const id = await runtime.start(pid, 'task-management', { operation: 'update', ...patch }, { kind: 'test' });
  await runtime.advance(id);
  await runtime.runReady();
  return (await runtime.get(id))!;
}

describe('tasks: priority and category are the person\'s words', () => {
  it('a task is created with the priority and category the person gave, after approval, and the list shows them', async () => {
    const id = await createTask({ title: 'Renovar o seguro', priority: 'HIGH', category: 'casa' });
    const row = await getTask(db, pid, id);
    expect(row).toMatchObject({ title: 'Renovar o seguro', priority: 'HIGH', category: 'casa', status: 'OPEN', due_at: null });
  });
  it('without them the task keeps priority and category empty (nothing is guessed), and no due date appears out of thin air', async () => {
    const id = await createTask({ title: 'Pensar no aniversário' });
    expect(await getTask(db, pid, id)).toMatchObject({ priority: null, category: null, due_at: null });
  });
  it('a due date that already passed is refused for confirmation: no action, no task', async () => {
    const before = (await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n;
    const { runtime } = setup();
    const id = await runtime.start(pid, 'task-management', { operation: 'create', tasks: [{ title: 'Pagar a conta', dueAt: '2025-10-17T12:00:00Z' }] }, { kind: 'test' });
    await runtime.advance(id);
    const r = (await runtime.get(id))!;
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toMatch(/já passou/);
    expect((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n).toBe(before);
  });
});

describe('tasks: update, snooze, archive', () => {
  it('sets and clears priority and category, runs without asking (it is the person\'s own metadata), and verifies by read-back', async () => {
    const id = await createTask({ title: 'Ligar para o contador' });
    const r1 = await update({ taskId: id, priority: 'URGENT', category: 'finanças' });
    expect(r1.status).toBe('completed');
    expect(await getTask(db, pid, id)).toMatchObject({ priority: 'URGENT', category: 'finanças', title: 'Ligar para o contador' });
    await update({ taskId: id, priority: null });
    expect((await getTask(db, pid, id))!.priority).toBeNull();
    expect((await getTask(db, pid, id))!.category).toBe('finanças'); // a field not in the patch is untouched
  });
  it('a snoozed task leaves the actionable list until its date and then comes back by itself', async () => {
    const id = await createTask({ title: 'Escolher o presente' });
    await update({ taskId: id, snoozedUntil: '2099-01-01T00:00:00Z' });
    expect((await listTasks(db, pid)).map((x) => x.id)).not.toContain(id);
    expect((await listTasks(db, pid, 'OPEN', { includeSnoozed: true })).map((x) => x.id)).toContain(id);
    await update({ taskId: id, snoozedUntil: '2020-01-01T00:00:00Z' }); // date already reached
    expect((await listTasks(db, pid)).map((x) => x.id)).toContain(id);
    await update({ taskId: id, snoozedUntil: null });
    expect((await getTask(db, pid, id))!.snoozed_until).toBeNull();
  });
  it('archiving keeps the task (state ARCHIVED, out of the list) and it can be brought back', async () => {
    const id = await createTask({ title: 'Ideia antiga' });
    await update({ taskId: id, archived: true });
    expect(await getTask(db, pid, id)).toMatchObject({ status: 'ARCHIVED' });
    expect((await listTasks(db, pid)).map((x) => x.id)).not.toContain(id);
    expect((await listTasks(db, pid, 'ARCHIVED')).map((x) => x.id)).toContain(id);
    await new TaskService(db).update(pid, id, { archived: false }, 'a', clock.now());
    expect(await getTask(db, pid, id)).toMatchObject({ status: 'OPEN' });
  });
  it('a finished task cannot be edited, and another person\'s task is not found', async () => {
    const id = await createTask({ title: 'Já feita' });
    await db.query(`UPDATE tasks SET status = 'DONE', completed_at = now() WHERE id = $1`, [id]);
    await expect(new TaskService(db).update(pid, id, { priority: 'LOW' }, 'a', clock.now())).rejects.toThrow(/done/);
    const other = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
    await expect(new TaskService(db).update(other, id, { priority: 'LOW' }, 'a', clock.now())).rejects.toThrow(/not found/);
  });
  it('the ledger records WHICH fields changed, never what the person wrote', async () => {
    const id = await createTask({ title: 'Texto muito pessoal que não vai ao ledger' });
    await update({ taskId: id, category: 'categoria-secreta' });
    const rows = (await db.query<{ payload: unknown }>(`SELECT payload FROM audit_blocks WHERE event_type = 'TASK_UPDATED' AND subject_id = $1`, [id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).toContain('category');
    expect(text).not.toContain('categoria-secreta');
    expect(text).not.toContain('Texto muito pessoal');
  });
  it('an update with nothing to change is refused before anything runs', async () => {
    const id = await createTask({ title: 'Sem mudança' });
    const r = await update({ taskId: id });
    expect(r.status).toBe('failed');
  });
});
