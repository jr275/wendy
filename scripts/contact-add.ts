/**
 * npx tsx scripts/contact-add.ts --name "Fulano" [--phone "+55 11 90000-0000"] [--context "…"] [--note "…"]
 * Puts a contact in the principal's approval queue through the same skill the chat uses. Nothing is saved until the principal approves it in the app.
 * Prints the execution state only (no contact data).
 */
import { parseArgs } from 'node:util';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { createReasoner } from '../src/cognition/reasoner.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { createContext } from '../src/runtime/context.js';
import { createSkillRuntime } from '../src/skills/index.js';
import { systemClock } from '../src/util/clock.js';

loadEnv();
const { values } = parseArgs({ options: { name: { type: 'string' }, phone: { type: 'string' }, context: { type: 'string' }, note: { type: 'string' } } });
if (!values.name) throw new Error('--name is required');
const db = createPool(databaseUrl());
const principalId = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]!.id;
const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });
const { runtime } = createSkillRuntime(ctx, { owner: `cli:${process.pid}` });
const input = { operation: 'save', fullName: values.name, ...(values.phone ? { phone: values.phone } : {}), ...(values.context ? { context: values.context } : {}), ...(values.note ? { note: values.note } : {}) };
const id = await runtime.start(principalId, 'contact-management', input, { kind: 'cli' });
await runtime.advance(id);
const r = (await runtime.get(id))!;
console.log(JSON.stringify({ executionId: id, status: r.status, waitingFor: r.wait ? 'your approval in the app' : null, output: r.status === 'completed' ? (r.output as { status?: string })?.status : undefined, error: r.error?.message ?? null }));
await db.end();
