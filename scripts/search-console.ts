/**
 * Search Console sensor CLI (read-only on Google's side).
 *
 *   npm run search -- add  --principal-email voce@empresa.com --site "sc-domain:remax.com.br" --label "Remax" [--importance 0.9]
 *   npm run search -- list --principal-email voce@empresa.com
 *   npm run search -- sync --principal-email voce@empresa.com [--process]
 *
 * sync: stores the latest windows (last 7 final days vs the 28 before) and 90 daily totals per site,
 * then runs the deterministic detector. --process also runs one Wendy cycle on the new events with the
 * configured reasoner (WENDY_REASONER). First run without a principal: add --create-principal "Nome".
 */
import { parseArgs } from 'node:util';
import { createReasoner, reasonerKind } from '../src/cognition/reasoner.js';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { createPrincipal } from '../src/events/world.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { normalizeAddress } from '../src/repositories/pg.js';
import { createContext } from '../src/runtime/context.js';
import { runCycle } from '../src/runtime/worker.js';
import { addWebProperty, GoogleSearchConsoleApi, listWebProperties, syncProperty } from '../src/sensors/searchConsole.js';
import { runSearchDetector } from '../src/sensors/searchDetector.js';
import { systemClock } from '../src/util/clock.js';

loadEnv();
const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'principal-email': { type: 'string' },
    'create-principal': { type: 'string' },
    site: { type: 'string' },
    label: { type: 'string' },
    importance: { type: 'string' },
    process: { type: 'boolean', default: false },
  },
});
const cmd = positionals[0];
const fail = (m: string): never => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
if (!['add', 'list', 'sync'].includes(cmd ?? '')) fail('use: add | list | sync');
if (!a['principal-email']) fail('informe --principal-email');

const db = createPool(databaseUrl());
await migrate(db);
const email = normalizeAddress(a['principal-email']!);
let principalId = (await db.query<{ id: string }>('SELECT id FROM principals WHERE primary_email = $1', [email])).rows[0]?.id;
if (!principalId) {
  if (!a['create-principal']) fail(`nenhum executivo com ${email}. Para criar, adicione --create-principal "Seu Nome"`);
  principalId = await createPrincipal(db, { displayName: a['create-principal']!, primaryEmail: email, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  console.log(`Executivo criado: ${a['create-principal']} <${email}>`);
}

if (cmd === 'add') {
  if (!a.site || !a.label) fail('informe --site e --label');
  const importance = a.importance === undefined ? null : Number(a.importance);
  if (importance !== null && !(importance >= 0 && importance <= 1)) fail('--importance deve estar entre 0 e 1');
  const id = await addWebProperty(db, principalId!, { siteUrl: a.site!, label: a.label!, importance, source: 'SEARCH_CONSOLE' });
  console.log(`Site cadastrado: ${a.label} (${a.site}) — ${id}${importance === null ? ' · importância não definida' : ` · importância ${importance}`}`);
}

if (cmd === 'list' || cmd === 'add') {
  for (const p of await listWebProperties(db, principalId!)) console.log(`- ${p.label}: ${p.site_url} · importância ${p.explicit_importance ?? 'não definida'}`);
}

if (cmd === 'sync') {
  const api = new GoogleSearchConsoleApi();
  const props = await listWebProperties(db, principalId!);
  if (!props.length) fail('nenhum site cadastrado (use add)');
  const now = new Date();
  for (const p of props) {
    try {
      const r = await syncProperty(db, api, p, now);
      console.log(`✓ ${p.label}: atual ${r.windows.current.start}..${r.windows.current.end}, base ${r.windows.baseline.start}..${r.windows.baseline.end} · ${JSON.stringify(r.counts)}`);
    } catch (e) {
      console.log(`✗ ${p.label}: ${(e as Error).message}`);
    }
  }
  const emitted = await runSearchDetector(db, principalId!, props, now);
  console.log(`Detector: ${emitted.length} mudança(s) relevante(s) nova(s).`);
  if (a.process && emitted.length) {
    if (reasonerKind() === 'gemini') console.log('⚠ Raciocínio: GEMINI (MVP) — não é o Claude.');
    const report = await runCycle(createContext({ db, reasoner: createReasoner(db), clock: systemClock, emailProvider: new DevMailboxProvider(db) }));
    for (const o of report.outcomes) console.log(`  evento ${o.eventId}: ${o.status}${'insightStatus' in o ? ` → ${o.insightStatus}` : 'reason' in o ? ` (${o.reason})` : ''}`);
    if (report.failures.length) console.log('  falhas:', JSON.stringify(report.failures));
  }
}
await db.end();
