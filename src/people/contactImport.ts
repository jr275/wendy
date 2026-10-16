/**
 * Importing an address book (a CSV export, e.g. from Google Contacts) into the principal's contacts.
 *
 * What it promises:
 *  - only a NAME and PHONE NUMBERS are read and stored; every other column is ignored;
 *  - one approval for the whole batch, and what runs is exactly the file that was approved (its SHA-256 is checked again at execution);
 *  - a phone already on file is never duplicated, and a number is never completed by guessing (see normalizePhoneLoose);
 *  - the rows that are left out are listed with the reason in a private report next to the file, so nothing disappears silently;
 *  - nothing is sent to anyone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { newId } from '../util/hash.js';
import { CONTACT_SOURCE, normalizeName, normalizePhoneLoose } from './contacts.js';

export class ImportError extends Error {}

export const IMPORT_LIMITS = { maxBytes: 5_000_000, maxRows: 20_000 };
export const importDir = () => process.env.WENDY_IMPORT_DIR ?? path.join(os.homedir(), 'Wendy', 'Importar');

/** The file inside the import folder (and only there): no path separators, no symlink leading elsewhere. */
export function resolveImportFile(name: string, dir = importDir()): string {
  if (!name || name !== path.basename(name) || name.startsWith('.')) throw new ImportError('use só o nome do arquivo, que deve estar na pasta de importação');
  const full = path.join(dir, name);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new ImportError(`arquivo não encontrado na pasta de importação: ${name}`);
  }
  if (path.dirname(real) !== fs.realpathSync(dir)) throw new ImportError('o arquivo precisa estar dentro da pasta de importação');
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > IMPORT_LIMITS.maxBytes) throw new ImportError('arquivo inválido ou grande demais');
  return real;
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. Dependency-free on purpose. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export interface RawContact {
  line: number;
  name: string;
  phones: string[];
}

/** Reads Google-Contacts-style columns: "Name" (or First/Middle/Last Name) and every "Phone N - Value" (several numbers in one cell are split on " ::: "). */
export function readContacts(csv: string): RawContact[] {
  const all = parseCsv(csv);
  if (all.length < 2) throw new ImportError('o arquivo não tem linhas de contatos');
  if (all.length - 1 > IMPORT_LIMITS.maxRows) throw new ImportError(`o arquivo tem mais de ${IMPORT_LIMITS.maxRows} linhas`);
  const hdr = all[0]!.map((h) => h.trim());
  const col = (re: RegExp) => hdr.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
  const nameCols = col(/^name$/i);
  const partCols = col(/^(first|middle|last) name$/i);
  const phoneCols = col(/^phone \d+ - value$/i);
  if (!phoneCols.length || (!nameCols.length && !partCols.length)) throw new ImportError('não reconheci as colunas: preciso de "Name" (ou First/Last Name) e "Phone 1 - Value"');
  return all.slice(1).map((r, i) => {
    const direct = nameCols.map((c) => r[c] ?? '').find((v) => v.trim());
    const name = (direct ?? partCols.map((c) => r[c] ?? '').join(' ')).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const phones = phoneCols.flatMap((c) => (r[c] ?? '').split(':::')).map((p) => p.trim()).filter(Boolean);
    return { line: i + 2, name, phones };
  });
}

export interface ImportOptions {
  country?: string;
  area?: string;
}
export interface ImportSummary {
  total: number;
  toCreate: number;
  alreadyKnown: number;
  duplicatesInFile: number;
  noName: number;
  noPhone: number;
  invalidPhone: number;
  /** Informational: new contacts that share a name with another (different phone): kept separate, the phone tells them apart. */
  sharedNames: number;
  /** Why numbers were left out. */
  invalidReasons: Record<string, number>;
}
export interface Skipped {
  line: number;
  name: string;
  phone: string;
  reason: string;
}
export interface ImportPlan {
  summary: ImportSummary;
  create: { name: string; phones: string[] }[];
  skipped: Skipped[];
}

export async function planImport(db: Queryable, principalId: string, rows: RawContact[], opts: ImportOptions = {}): Promise<ImportPlan> {
  const known = new Set((await db.query<{ value: string }>(`SELECT value FROM person_identifiers WHERE principal_id = $1 AND kind = 'phone'`, [principalId])).rows.map((r) => r.value));
  const existingNames = new Set((await db.query<{ full_name: string }>(`SELECT full_name FROM people WHERE principal_id = $1`, [principalId])).rows.map((r) => normalizeName(r.full_name)));
  const seen = new Set<string>();
  const create: ImportPlan['create'] = [];
  const skipped: Skipped[] = [];
  const reasons: Record<string, number> = {};
  const s: ImportSummary = { total: rows.length, toCreate: 0, alreadyKnown: 0, duplicatesInFile: 0, noName: 0, noPhone: 0, invalidPhone: 0, sharedNames: 0, invalidReasons: reasons };
  const names = new Map<string, number>();
  for (const r of rows) {
    if (!r.name) { s.noName++; skipped.push({ line: r.line, name: '', phone: r.phones.join(' ; '), reason: 'sem nome' }); continue; }
    if (!r.phones.length) { s.noPhone++; skipped.push({ line: r.line, name: r.name, phone: '', reason: 'sem telefone' }); continue; }
    const good: string[] = [];
    let lastBad: string | null = null;
    for (const raw of r.phones) {
      const n = normalizePhoneLoose(raw, opts);
      if ('reason' in n) lastBad = n.reason;
      else good.push(n.phone);
    }
    if (!good.length) {
      s.invalidPhone++;
      reasons[lastBad ?? 'invalido'] = (reasons[lastBad ?? 'invalido'] ?? 0) + 1;
      skipped.push({ line: r.line, name: r.name, phone: r.phones.join(' ; '), reason: { sem_ddd: 'telefone sem DDD', suspeito: 'telefone suspeito (parece faltar o código do país)', invalido: 'telefone inválido', vazio: 'telefone vazio' }[lastBad ?? 'invalido'] ?? 'telefone inválido' });
      continue;
    }
    const fresh = [...new Set(good)].filter((p) => !known.has(p) && !seen.has(p));
    if (!fresh.length) {
      if (good.some((p) => known.has(p))) s.alreadyKnown++;
      else s.duplicatesInFile++;
      continue;
    }
    fresh.forEach((p) => seen.add(p));
    create.push({ name: r.name, phones: fresh });
    const key = normalizeName(r.name);
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  s.toCreate = create.length;
  s.sharedNames = create.filter((c) => (names.get(normalizeName(c.name)) ?? 0) > 1 || existingNames.has(normalizeName(c.name))).length;
  return { summary: s, create, skipped };
}

export const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Writes the list of left-out rows next to the file, private to the owner. Returns its name. Contains the personal data of those rows: it stays on this computer. */
export function writeReport(file: string, skipped: Skipped[]): string {
  const out = `${file}.relatorio.csv`;
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  fs.writeFileSync(out, ['linha,nome,telefone,motivo', ...skipped.map((k) => [k.line, k.name, k.phone, k.reason].map(esc).join(','))].join('\n'), { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  return path.basename(out);
}

/** Applies a plan, once: inserts the contacts and their phones, with a provenance note; repeating the same file creates nothing new. */
export async function applyImport(db: Db, principalId: string, plan: ImportPlan, sha: string, now: Date): Promise<{ created: number }> {
  const mk = `(#imp-${sha.slice(0, 8)})`;
  const day = now.toISOString().slice(0, 10);
  return withTx(db, async (tx) => {
    let created = 0;
    for (const c of plan.create) {
      const taken = (await tx.query(`SELECT 1 FROM person_identifiers WHERE principal_id = $1 AND kind = 'phone' AND value = ANY($2)`, [principalId, c.phones])).rowCount;
      if (taken) continue; // a number appeared since the plan was made: never create a second person for it
      const id = newId();
      await tx.query('INSERT INTO people(id, principal_id, full_name, source) VALUES ($1,$2,$3,$4)', [id, principalId, c.name, CONTACT_SOURCE]);
      for (const p of c.phones) await tx.query(`INSERT INTO person_identifiers(principal_id, kind, value, person_id) VALUES ($1,'phone',$2,$3) ON CONFLICT (principal_id, kind, value) DO NOTHING`, [principalId, p, id]);
      await tx.query(`INSERT INTO relationships(id, principal_id, person_id, kind, notes, source) VALUES ($1,$2,$3,'CONTACT',$4,$5)`, [newId(), principalId, id, `[${day}] importado de arquivo de contatos ${mk}`, CONTACT_SOURCE]);
      created++;
    }
    await appendAudit(tx, { principalId, eventType: 'CONTACTS_IMPORTED', actor: 'WENDY', subjectType: 'import', subjectId: principalId, payload: { sha: sha.slice(0, 12), created, left_out: plan.skipped.length, total: plan.summary.total } });
    return { created };
  });
}
