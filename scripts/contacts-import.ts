/**
 * npx tsx scripts/contacts-import.ts --file "/path/contacts.csv" [--default-country 55] [--default-area 21] [--propose]
 * Copies the CSV into the import folder (~/Wendy/Importar, owner-only), plans the import and prints COUNTS ONLY (no names or numbers).
 * The rows that would be left out go to a private report file next to the copy. Without --propose nothing is saved and nothing is queued;
 * with --propose the batch is queued for the principal's approval in the app (nothing is imported until they approve).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createReasoner } from '../src/cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { importDir } from '../src/people/contactImport.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { createContext } from '../src/runtime/context.js';
import { createSkillRuntime } from '../src/skills/index.js';
import { Toolbox } from '../src/tools/index.js';
import { systemClock } from '../src/util/clock.js';

loadEnv();
const { values } = parseArgs({ options: { file: { type: 'string' }, 'default-country': { type: 'string' }, 'default-area': { type: 'string' }, propose: { type: 'boolean' } } });
if (!values.file) throw new Error('--file is required');
const dir = importDir();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const name = path.basename(values.file).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '') || 'contatos.csv';
const dest = path.join(dir, name);
fs.copyFileSync(values.file, dest);
fs.chmodSync(dest, 0o600);

const db = createPool(databaseUrl());
const principalId = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]!.id;
const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });
const { runtime, toolbox } = createSkillRuntime(ctx, { owner: `cli:${process.pid}`, toolbox: new Toolbox({ search: () => { throw new Error('no search'); } }) });
const input = { file: name, ...(values['default-country'] ? { defaultCountry: values['default-country'] } : {}), ...(values['default-area'] ? { defaultArea: values['default-area'] } : {}) };
const plan = (await toolbox.read("contacts.import_plan")!.run({ db, principalId, now: new Date() }, input)) as Record<string, unknown>;
console.log(JSON.stringify({ copiedTo: dest, ...plan }, null, 1));
if (values.propose) {
  const id = await runtime.start(principalId, 'contact-import', input, { kind: 'cli' });
  await runtime.advance(id);
  const r = (await runtime.get(id))!;
  console.log(JSON.stringify({ executionId: id, status: r.status, waitingFor: r.wait ? 'your approval in the app' : null, error: r.error?.message ?? null }));
} else {
  console.log('Simulação: nada foi salvo nem colocado na fila. Para pedir a aprovação, rode de novo com --propose.');
}
await db.end();
