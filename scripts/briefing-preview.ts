/**
 * Builds the AI Intelligence Briefing PREVIEW from the public feeds and saves it as a page you can open: ~/Wendy/Briefing/briefing-<date>.html (mode 600).
 * Nothing is sent to anyone. Usage: npx tsx scripts/briefing-preview.ts [--days 7]
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildBriefing, renderBriefingHtml } from '../src/briefing/briefing.js';

const i = process.argv.indexOf('--days');
const days = i > 0 ? Number(process.argv[i + 1]) : 7;
if (!Number.isFinite(days)) throw new Error('--days precisa ser um número');
const b = await buildBriefing({ now: new Date(), days });
const dir = join(homedir(), 'Wendy', 'Briefing');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `briefing-${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(file, renderBriefingHtml(b), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Prévia salva em ${file} (período: ${b.period.days} dias). Nada foi enviado.`);
for (const s of b.sections) console.log(`- ${s.title}: ${s.unavailable ? 'fonte indisponível' : s.items.length ? `${s.items.length} item(ns)` : 'nenhuma novidade relevante'}`);
for (const n of b.notes) console.log(`  · ${n}`);
