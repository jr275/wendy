import { createReasoner, reasonerKind } from '../cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../config.js';
import { createPool, migrate } from '../db/db.js';
import { DevMailboxProvider } from '../providers/devMailbox.js';
import { systemClock } from '../util/clock.js';
import { createContext } from './context.js';
import { startWorker } from './worker.js';
import { createSkillRuntime } from '../skills/index.js';
import { GoogleSearchConsoleApi, syncDueProperties } from '../sensors/searchConsole.js';

loadEnv();
const db = createPool(databaseUrl());
await migrate(db);
const ctx = createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) });
ctx.skills = createSkillRuntime(ctx, { owner: `worker:${process.pid}` }).runtime;

if (reasonerKind() === 'gemini') console.log('⚠ Reasoner: GEMINI (MVP) — not Claude.');

// Sensors that call external services run on their own slower clock, not every cycle.
// Search Console: check hourly; sync properties older than 20h (the detector then runs inside the cycle).
const searchApi = new GoogleSearchConsoleApi();
const syncSearch = async () => {
  for (const r of await syncDueProperties(db, searchApi, new Date()))
    console.log(JSON.stringify({ at: new Date().toISOString(), sensor: 'search-console', site: r.label, ok: r.ok, detail: r.detail }));
};
void syncSearch().catch((e) => console.error('[search-console sync error]', e));
const searchTimer = setInterval(() => void syncSearch().catch((e) => console.error('[search-console sync error]', e)), Number(process.env.WENDY_SEARCH_SYNC_CHECK_MS ?? 3_600_000));
const worker = startWorker(
  ctx,
  Number(process.env.WENDY_WORKER_INTERVAL_MS ?? 30_000),
  (r) => {
    if (r.detected.length || r.outcomes.length || r.failures.length || r.executed.length || r.skills.length)
      console.log(JSON.stringify({ at: new Date().toISOString(), detected: r.detected.length, processed: r.outcomes, failures: r.failures, executed: r.executed, skills: r.skills }));
  },
  (e) => console.error('[worker cycle error]', e),
);

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    clearInterval(searchTimer);
    await worker.stop();
    await db.end();
    process.exit(0);
  });
