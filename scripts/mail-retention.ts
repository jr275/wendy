/**
 * Retention of e-mail bodies. Safe by default: with no flag it only COUNTS what would be emptied.
 *   npx tsx scripts/mail-retention.ts --days 180                 # counts (changes nothing)
 *   npx tsx scripts/mail-retention.ts --days 180 --apply --yes   # empties the bodies older than 180 days. IRREVERSIBLE. Run by you, not by Wendy.
 * Sender, recipients, subject and date stay; only the body text is emptied. Take a backup first if you want to be able to go back.
 */
import { parseArgs } from 'node:util';
import { databaseUrl, loadEnv } from '../src/config.js';
import { assertMigrated, createPool } from '../src/db/db.js';
import { applyMailRetention, planMailRetention } from '../src/retention/mailRetention.js';

loadEnv();
const { values } = parseArgs({ options: { days: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean' } } });
const days = Number(values.days);
const db = createPool(databaseUrl());
await assertMigrated(db, process.env);
const principalId = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]!.id;
const now = new Date();
const plan = await planMailRetention(db, principalId, days, now);
console.log(`Mensagens com corpo guardado: ${plan.withBody}. Mais antiga: ${plan.oldest ?? '—'}.`);
console.log(`Com ${plan.keepDays} dias de guarda (corte em ${plan.cutoff}): ${plan.wouldEmpty} corpo(s) seriam esvaziados (${plan.wouldFreeChars} caracteres).`);
if (values.apply) {
  if (!values.yes) throw new Error('Para esvaziar de verdade, repita com --apply --yes. É irreversível.');
  const r = await applyMailRetention(db, principalId, days, now);
  console.log(`Feito: ${r.emptied} corpo(s) esvaziado(s). Remetente, destinatários, assunto e data foram mantidos.`);
} else {
  console.log('Nada foi alterado (modo de contagem).');
}
await db.end();
