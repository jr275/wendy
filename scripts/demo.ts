/**
 * "First wow" demo: a new email arrives; nobody asks anything; Wendy runs one cycle and surfaces
 * what she found. Uses DEV FIXTURES in an isolated `demo` schema of the dev database and the configured
 * reasoner: real Claude by default; WENDY_REASONER=gemini runs it with Gemini (MVP, labeled as not Claude).
 *   npm run demo            (scenario A)
 *   npm run demo -- b       (scenario B)
 */
import { createReasoner, reasonerKind } from '../src/cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { ingestInboundEmail } from '../src/events/ingest.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { createContext } from '../src/runtime/context.js';
import { runCycle } from '../src/runtime/worker.js';
import { systemClock } from '../src/util/clock.js';
import { buildWorld, SCENARIO_A, SCENARIO_B, urgentEmail } from '../fixtures/world.js';

loadEnv();
const scenario = process.argv[2] === 'b' ? SCENARIO_B : SCENARIO_A;
const admin = createPool(databaseUrl());
await admin.query('DROP SCHEMA IF EXISTS demo CASCADE; CREATE SCHEMA demo');
await admin.end();
const db = createPool(databaseUrl(), 'demo');
await migrate(db);

const now = new Date();
const world = await buildWorld(db, scenario, now);
const mail = urgentEmail(world, now);
if (reasonerKind() === 'gemini') console.log('⚠ Reasoner: GEMINI (MVP) — not Claude. Results do not count for the Claude gate.');
console.log(`\n→ New email (DEV FIXTURE) from ${mail.from}: "${mail.subject}"\n  ${mail.body}\n`);
const { event } = await ingestInboundEmail(db, world.principalId, mail, 'DEV_FIXTURE');

const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });
const t0 = Date.now();
const report = await runCycle(ctx);
if (report.failures.length) console.error('failures:', report.failures);

const insight = (await db.query('SELECT rendered, model_call_ids FROM insights WHERE event_id = $1', [event.id])).rows[0];
if (insight) {
  console.log(insight.rendered);
  const calls = (await db.query('SELECT purpose, served_by_model, api_message_id, usage FROM model_calls WHERE id = ANY($1::uuid[])', [insight.model_call_ids])).rows;
  console.log(`\n(cycle ${Math.round((Date.now() - t0) / 1000)}s; model calls: ${calls.map((c) => `${c.purpose}=${c.served_by_model}/${c.api_message_id}`).join(', ')})`);
}
await db.end();
