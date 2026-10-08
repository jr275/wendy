import { createReasoner, reasonerKind } from '../cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../config.js';
import { createPool, migrate } from '../db/db.js';
import { DevMailboxProvider } from '../providers/devMailbox.js';
import { systemClock } from '../util/clock.js';
import { createContext } from './context.js';
import { startWorker } from './worker.js';

loadEnv();
const db = createPool(databaseUrl());
await migrate(db);
const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });

if (reasonerKind() === 'gemini') console.log('⚠ Reasoner: GEMINI (MVP) — not Claude.');
const worker = startWorker(
  ctx,
  Number(process.env.WENDY_WORKER_INTERVAL_MS ?? 30_000),
  (r) => {
    if (r.detected.length || r.outcomes.length || r.failures.length || r.executed.length)
      console.log(JSON.stringify({ at: new Date().toISOString(), detected: r.detected.length, processed: r.outcomes, failures: r.failures, executed: r.executed }));
  },
  (e) => console.error('[worker cycle error]', e),
);

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await worker.stop();
    await db.end();
    process.exit(0);
  });
