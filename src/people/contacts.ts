/**
 * The principal's contacts: people they asked Wendy to remember (a name, a phone, what the person is to them) and notes added later.
 *
 * Rules that shape everything here:
 *  - Only what the principal said is stored. No surname, e-mail, company or relationship is ever filled in by Wendy.
 *  - One phone number is one person (the primary key of person_identifiers), and the same name is a possible duplicate that needs a human answer, not a silent second row.
 *  - A write is idempotent on the approved action, so a retried execution never repeats a note.
 *  - Nothing here sends a message or places a call; contacts are read and written, never contacted.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { newId } from '../util/hash.js';

export class ContactError extends Error {}

export const CONTACT_SOURCE = 'PRINCIPAL_CONTACT';

/** "+55 21 96737-0405" → "+5521967370405". Needs the country code (a leading +); a number without it is not guessed. null = not a usable phone. */
export function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (!t.startsWith('+')) return null;
  const digits = t.replace(/\D/g, '');
  return /^[1-9]\d{9,14}$/.test(digits) ? `+${digits}` : null;
}

export type LoosePhone = { phone: string } | { phone: null; reason: 'sem_ddd' | 'suspeito' | 'invalido' | 'vazio' };

/**
 * For IMPORTING a whole address book, where numbers come in every shape. Stricter than guessing, looser than normalizePhone:
 *  - "+<country…>" is taken as written when it has a believable length (12–15 digits, or 11 starting with 1);
 *  - without "+", a number that already starts with the country code, or one with area code + number (10–11 digits), gets the country code;
 *  - a number with only 8–9 digits has NO area code and is never completed by guessing (unless the caller passes defaultArea);
 *  - a "+" number with 10–11 digits that is not North American is probably missing its country code: reported as suspect, not fixed.
 */
export function normalizePhoneLoose(raw: string, opts: { country?: string; area?: string } = {}): LoosePhone {
  const country = opts.country ?? '55';
  const t = raw.trim();
  if (!t) return { phone: null, reason: 'vazio' };
  let digits = t.replace(/\D/g, '');
  const plus = t.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return { phone: null, reason: 'invalido' };
  const ok = (d: string) => (/^[1-9]\d{9,14}$/.test(d) ? { phone: `+${d}` } : ({ phone: null, reason: 'invalido' } as const));
  if (plus) {
    if (digits.startsWith(country) && digits.length !== country.length + 10 && digits.length !== country.length + 11) return { phone: null, reason: 'invalido' };
    if (digits.length === 11 && digits.startsWith('1')) return ok(digits); // +1 (area) number: North America
    if (digits.length === 10 || digits.length === 11) return { phone: null, reason: 'suspeito' };
    return ok(digits);
  }
  if (digits.startsWith(country) && (digits.length === country.length + 10 || digits.length === country.length + 11)) return ok(digits);
  // Brazilian trunk prefix: "(021) 99999-9999" is written with a leading 0 before the area code; it is only a dialling prefix, not part of the number.
  if (country === '55' && digits.startsWith('0') && !digits.startsWith('00') && (digits.length === 11 || digits.length === 12) && /^[1-9][1-9]/.test(digits.slice(1))) digits = digits.slice(1);
  const validArea = (d: string) => /^[1-9][1-9]/.test(d);
  if ((digits.length === 10 || digits.length === 11) && validArea(digits)) return ok(`${country}${digits}`);
  if (digits.length === 8 || digits.length === 9) return opts.area && /^[1-9][1-9]$/.test(opts.area) ? ok(`${country}${opts.area}${digits}`) : { phone: null, reason: 'sem_ddd' };
  return { phone: null, reason: 'invalido' };
}

/** Lowercase, no accents, single spaces: how names are compared. */
export const normalizeName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface ContactView {
  id: string;
  fullName: string;
  phones: string[];
  emails: string[];
  /** What the principal said this person is to them ("Contexto: …"), if they said it. */
  context: string | null;
  /** Dated notes, oldest first. */
  notes: string[];
  /** Where the record came from: the principal (told Wendy) or a mailbox (found in e-mail). */
  origin: 'PRINCIPAL' | 'MAILBOX';
}

interface Row {
  id: string;
  full_name: string;
  source: string;
  notes: string | null;
  identifiers: { kind: string; value: string }[] | null;
}

const SQL = `
  SELECT p.id, p.full_name, p.source, r.notes,
         (SELECT json_agg(json_build_object('kind', i.kind, 'value', i.value) ORDER BY i.kind, i.value) FROM person_identifiers i WHERE i.person_id = p.id AND i.principal_id = p.principal_id) AS identifiers
    FROM people p LEFT JOIN relationships r ON r.person_id = p.id AND r.principal_id = p.principal_id
   WHERE p.principal_id = $1`;

function view(r: Row): ContactView {
  const lines = (r.notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const context = lines.find((l) => l.startsWith('Contexto:'))?.slice('Contexto:'.length).trim() || null;
  return {
    id: r.id,
    fullName: r.full_name,
    phones: (r.identifiers ?? []).filter((i) => i.kind === 'phone').map((i) => i.value),
    emails: (r.identifiers ?? []).filter((i) => i.kind === 'email').map((i) => i.value),
    context,
    notes: lines.filter((l) => !l.startsWith('Contexto:')),
    origin: r.source === CONTACT_SOURCE ? 'PRINCIPAL' : 'MAILBOX',
  };
}

export async function getContact(q: Queryable, principalId: string, personId: string): Promise<ContactView | null> {
  const r = (await q.query<Row>(`${SQL} AND p.id = $2`, [principalId, personId])).rows[0];
  return r ? view(r) : null;
}

/**
 * Finds contacts by any of: a phone number, a name, or words from the context/notes. All the given criteria must match.
 * Small on purpose (a person's address book): candidates are read and compared here, so accents and case never get in the way.
 */
export async function findContacts(q: Queryable, principalId: string, query: { text?: string; phone?: string }, limit = 10): Promise<ContactView[]> {
  const rows = (await q.query<Row>(`${SQL} ORDER BY p.full_name LIMIT 5000`, [principalId])).rows.map(view);
  const text = query.text ? normalizeName(query.text) : '';
  // Searching is lenient (the last digits are enough); saving a number is strict (see normalizePhone).
  const digits = query.phone ? query.phone.replace(/\D/g, '') : '';
  if (query.phone && digits.length < 4) throw new ContactError('informe pelo menos 4 dígitos do telefone para buscar');
  const words = text.split(' ').filter((w) => w.length >= 2);
  const out = rows.filter((c) => {
    if (digits && !c.phones.some((p) => p.replace(/\D/g, '').endsWith(digits))) return false;
    if (!words.length) return true;
    const hay = normalizeName([c.fullName, c.context ?? '', ...c.notes, ...c.emails].join(' '));
    return words.every((w) => hay.includes(w));
  });
  return (text || digits ? out : out.filter((c) => c.origin === 'PRINCIPAL')).slice(0, limit);
}

export interface SaveContact {
  /** Required to create. When updating an existing person (personId, or a phone already on file) the name is kept as it is. */
  fullName?: string;
  personId?: string;
  phone?: string;
  context?: string;
  note?: string;
  /** The principal confirmed that a different person with the same name is intended. */
  allowDuplicateName?: boolean;
}

const stamp = (d: Date) => d.toISOString().slice(0, 10);
const marker = (actionId: string) => `(#${actionId.slice(0, 8)})`;

/** Creates or updates one contact for one approved action, once. Returns the stored contact. */
export async function saveContact(db: Db, principalId: string, actionId: string, i: SaveContact, now: Date): Promise<{ contact: ContactView; created: boolean }> {
  const phone = i.phone ? normalizePhone(i.phone) : null;
  if (i.phone && !phone) throw new ContactError('telefone inválido: informe com o código do país, por exemplo +55 21 90000-0000');
  const name = i.fullName?.trim();
  const context = i.context?.trim() || null;
  const note = i.note?.trim() || null;
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contact:${principalId}:${phone ?? normalizeName(name ?? i.personId ?? '')}`]);

    let personId = i.personId ?? null;
    if (!personId && phone) personId = (await tx.query<{ person_id: string }>(`SELECT person_id FROM person_identifiers WHERE principal_id = $1 AND kind = 'phone' AND value = $2`, [principalId, phone])).rows[0]?.person_id ?? null;
    if (personId && !(await getContact(tx, principalId, personId))) throw new ContactError('contato não encontrado');

    let created = false;
    if (!personId) {
      if (!name) throw new ContactError('o nome é obrigatório para cadastrar um contato novo');
      const same = (await findContacts(tx, principalId, { text: name })).filter((c) => normalizeName(c.fullName) === normalizeName(name));
      if (same.length && !i.allowDuplicateName) throw new ContactError(`já existe um contato com o nome "${same[0]!.fullName}"; confirme se é outra pessoa ou atualize o existente`);
      personId = newId();
      await tx.query('INSERT INTO people(id, principal_id, full_name, source) VALUES ($1,$2,$3,$4)', [personId, principalId, name, CONTACT_SOURCE]);
      created = true;
    }
    if (phone) await tx.query(`INSERT INTO person_identifiers(principal_id, kind, value, person_id) VALUES ($1,'phone',$2,$3) ON CONFLICT (principal_id, kind, value) DO NOTHING`, [principalId, phone, personId]);

    // Context and notes live in relationships.notes, one line each; a line carrying this action's marker is never added twice.
    const rel = (await tx.query<{ notes: string | null }>(`SELECT notes FROM relationships WHERE principal_id = $1 AND person_id = $2 FOR UPDATE`, [principalId, personId])).rows[0];
    const lines = (rel?.notes ?? '').split('\n').filter(Boolean);
    const mk = marker(actionId);
    if (context && !lines.some((l) => l.startsWith('Contexto:'))) lines.unshift(`Contexto: ${context}`);
    if (note && !lines.some((l) => l.endsWith(mk))) lines.push(`[${stamp(now)}] ${note} ${mk}`);
    const notes = lines.join('\n') || null;
    if (rel) await tx.query(`UPDATE relationships SET notes = $3 WHERE principal_id = $1 AND person_id = $2`, [principalId, personId, notes]);
    else await tx.query(`INSERT INTO relationships(id, principal_id, person_id, kind, notes, source) VALUES ($1,$2,$3,'CONTACT',$4,$5)`, [newId(), principalId, personId, notes, CONTACT_SOURCE]);
    await tx.query('UPDATE people SET updated_at = $2 WHERE id = $1', [personId, now]);

    // The ledger says that a contact was saved and which kinds of fact were involved, never the name, number or note themselves.
    await appendAudit(tx, { principalId, eventType: 'CONTACT_SAVED', actor: 'WENDY', subjectType: 'person', subjectId: personId, payload: { created, actionId, fields: [phone ? 'phone' : null, context ? 'context' : null, note ? 'note' : null].filter(Boolean) } });
    return { contact: (await getContact(tx, principalId, personId))!, created };
  });
}
