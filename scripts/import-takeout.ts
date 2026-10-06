/**
 * Imports a Google Takeout export into Wendy (read-only on the files; nothing is sent to Claude).
 *
 *   npm run import -- --principal-email voce@empresa.com --mbox "Todos os e-mails.mbox" --ics agenda.ics [--ics outra.ics]
 *                     [--since 2026-07-01] [--alias outro@endereco.com] [--exclusions config/import-exclusions.json]
 *                     [--all-senders] [--dry-run]
 *   First run without a principal: add --create-principal "Seu Nome" [--timezone America/Sao_Paulo] [--locale pt-BR]
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { createPrincipal } from '../src/events/world.js';
import { importTakeout, loadExclusions } from '../src/importers/takeout.js';
import { normalizeAddress } from '../src/repositories/pg.js';
import { DAY_MS } from '../src/util/clock.js';

loadEnv();
const { values: a } = parseArgs({
  options: {
    'principal-email': { type: 'string' },
    'create-principal': { type: 'string' },
    timezone: { type: 'string', default: 'America/Sao_Paulo' },
    locale: { type: 'string', default: 'pt-BR' },
    mbox: { type: 'string' },
    ics: { type: 'string', multiple: true, default: [] },
    since: { type: 'string' },
    alias: { type: 'string', multiple: true, default: [] },
    exclusions: { type: 'string' },
    'all-senders': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
if (!a['principal-email']) fail('informe --principal-email');
if (!a.mbox && a.ics!.length === 0) fail('informe --mbox e/ou --ics');
for (const f of [a.mbox, ...a.ics!].filter(Boolean)) if (!fs.existsSync(f!)) fail(`arquivo não encontrado: ${f}`);
const exclusionsFile = a.exclusions ?? (fs.existsSync('config/import-exclusions.json') ? 'config/import-exclusions.json' : null);
const since = a.since ? new Date(`${a.since}T00:00:00Z`) : new Date(Date.now() - 90 * DAY_MS);
if (Number.isNaN(since.getTime())) fail('--since deve ser AAAA-MM-DD');

const db = createPool(databaseUrl());
await migrate(db);
const email = normalizeAddress(a['principal-email']!);
let principalId = (await db.query<{ id: string }>('SELECT id FROM principals WHERE primary_email = $1', [email])).rows[0]?.id;
if (!principalId) {
  if (!a['create-principal']) fail(`nenhum executivo com ${email}. Para criar, adicione --create-principal "Seu Nome"`);
  if (a['dry-run']) fail('--dry-run não cria executivo; rode sem --dry-run ou crie antes');
  principalId = await createPrincipal(db, { displayName: a['create-principal']!, primaryEmail: email, timezone: a.timezone!, locale: a.locale! });
  console.log(`Executivo criado: ${a['create-principal']} <${email}>`);
}

console.log(`Lendo ${[a.mbox, ...a.ics!].filter(Boolean).join(', ')} desde ${since.toISOString().slice(0, 10)}${exclusionsFile ? ` · exclusões: ${exclusionsFile}` : ' · SEM arquivo de exclusões'}${a['dry-run'] ? ' · SIMULAÇÃO (nada é gravado)' : ''}`);
const r = await importTakeout(db, {
  principalId,
  mboxPath: a.mbox ?? null,
  icsPaths: a.ics,
  since,
  until: new Date(),
  aliases: a.alias,
  exclusions: loadExclusions(exclusionsFile),
  onlyCorrespondents: !a['all-senders'],
  dryRun: a['dry-run'],
});
const ex = r.mail.excluded;
console.log(`
E-mails
  lidos ............................ ${r.mail.read}
  ilegíveis ........................ ${r.mail.unparseable}
  fora da janela ................... ${r.mail.outOfWindow}
  excluídos (endereço/domínio/assunto/marcador) ${ex.address}/${ex.domain}/${ex.subject}/${ex.label}
  sem correspondente (newsletters etc.) ${r.mail.withoutCorrespondent}
  ${r.dryRun ? 'seriam gravados' : 'gravados'} ........................ ${r.mail.stored}
  já existiam ...................... ${r.mail.alreadyPresent}
Agenda
  eventos no arquivo ............... ${r.calendar.events}
  ocorrências na janela ............ ${r.calendar.occurrencesInWindow}
  dia inteiro (ignoradas) .......... ${r.calendar.allDaySkipped}
  excluídas ........................ ${r.calendar.excluded}
  ${r.dryRun ? 'seriam gravadas' : 'gravadas'} ........................ ${r.calendar.stored}
  recorrência não suportada (só 1ª) ${r.calendar.unsupportedRecurrence}
  fuso desconhecido (ignoradas) .... ${r.calendar.unknownTimezone}
Pessoas
  ${r.dryRun ? 'seriam criadas' : 'criadas'} ......................... ${r.people.created}
  já conhecidas .................... ${r.people.alreadyKnown}

Enviado ao Claude: nada. A importação só grava contexto; nenhum evento foi criado.
A importância de cada pessoa não é deduzida: defina em Pessoas e memória.`);
await db.end();
