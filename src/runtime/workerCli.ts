import { createReasoner, reasonerKind } from '../cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../config.js';
import { createPool, migrate } from '../db/db.js';
import { DevMailboxProvider } from '../providers/devMailbox.js';
import { systemClock } from '../util/clock.js';
import { createContext } from './context.js';
import { startWorker } from './worker.js';
import { createSkillRuntime } from '../skills/index.js';
import { GoogleSearchConsoleApi, syncDueProperties } from '../sensors/searchConsole.js';
import { GoogleRestApi } from '../sensors/google/api.js';
import { authorizedClient, connectedAccount } from '../sensors/google/auth.js';
import { syncGoogle } from '../sensors/google/sync.js';

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
// Gmail + Calendar (read-only), when the principal connected Google: every few minutes.
let googleBusy = false;
const syncMail = async () => {
  if (googleBusy || !connectedAccount()) return;
  googleBusy = true;
  try {
    for (const p of (await db.query<{ principal_id: string }>(`SELECT principal_id FROM connected_sources WHERE provider = 'google' AND status = 'CONNECTED'`)).rows) {
      const r = await syncGoogle(db, new GoogleRestApi(authorizedClient()), p.principal_id, new Date());
      if (r.report.mail.stored || r.report.calendar.stored) console.log(JSON.stringify({ at: new Date().toISOString(), sensor: 'google', mode: r.mode, mailStored: r.report.mail.stored, meetings: r.report.calendar.stored }));
    }
  } catch (e) {
    console.error('[google sync error]', e instanceof Error ? e.message : e);
  } finally {
    googleBusy = false;
  }
};
void syncMail();
const googleTimer = setInterval(() => void syncMail(), Number(process.env.WENDY_GOOGLE_SYNC_MS ?? 5 * 60_000));
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
    clearInterval(googleTimer);
    await worker.stop();
    await db.end();
    process.exit(0);
  });
