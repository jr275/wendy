/**
 * Imports a Google Takeout export (Gmail .mbox + Calendar .ics) into Wendy's world model.
 *
 * Privacy and honesty rules:
 *   - read-only on the source files; nothing is sent anywhere (no events are created, so the
 *     worker does not call Claude because of an import — the data becomes context only)
 *   - the exclusion list is applied BEFORE storage: excluded messages/meetings are never written
 *   - by default only messages with real correspondents are kept (someone the principal wrote to,
 *     or met with in a small meeting); newsletters and notifications are dropped
 *   - people are created only by that deterministic rule; importance is never inferred
 *   - idempotent: re-importing the same export inserts nothing new
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';
import { createPerson, storeMessage, upsertMeeting } from '../events/world.js';
import { normalizeAddress } from '../repositories/pg.js';
import { sha256 } from '../util/hash.js';
import { parseIcs, type IcsOccurrence } from './ics.js';
import { parseMail, readMbox, type ParsedMail } from './mbox.js';

export const MAIL_PROVIDER = 'GMAIL_TAKEOUT';
export const CALENDAR_PROVIDER = 'GCAL_ICS';
/** Labels that are never imported, whatever the exclusion file says. */
const ALWAYS_EXCLUDED_LABELS = ['spam', 'trash', 'lixeira', 'lixo', 'chat', 'bate-papo'];
/** Meetings larger than this do not create people (all-hands, webinars). */
const MAX_ATTENDEES_FOR_PEOPLE = 15;

export const ExclusionsSchema = z.object({
  addresses: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  subjectContains: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  calendarTitleContains: z.array(z.string()).default([]),
});
export type Exclusions = z.infer<typeof ExclusionsSchema>;

export function loadExclusions(file: string | null): Exclusions {
  if (!file) return ExclusionsSchema.parse({});
  return ExclusionsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export interface ImportOptions {
  principalId: string;
  mboxPath?: string | null;
  icsPaths?: string[];
  since: Date;
  until: Date; // emails up to this instant; meetings up to until + lookahead
  meetingLookaheadDays?: number;
  aliases?: string[]; // other addresses of the principal
  exclusions: Exclusions;
  onlyCorrespondents?: boolean; // default true
  dryRun?: boolean;
}

export interface ImportReport {
  dryRun: boolean;
  mail: {
    read: number;
    unparseable: number;
    outOfWindow: number;
    excluded: Record<'address' | 'domain' | 'subject' | 'label', number>;
    withoutCorrespondent: number;
    stored: number;
    alreadyPresent: number;
  };
  calendar: { events: number; occurrencesInWindow: number; allDaySkipped: number; excluded: number; stored: number; unsupportedRecurrence: number; unknownTimezone: number; invalid: number };
  people: { created: number; alreadyKnown: number };
  sentToClaude: 0;
}

const lower = (xs: string[]) => xs.map((x) => x.trim().toLowerCase()).filter(Boolean);

function exclusionMatcher(ex: Exclusions) {
  const addresses = new Set(lower(ex.addresses).map(normalizeAddress));
  const domains = lower(ex.domains).map((d) => d.replace(/^@/, ''));
  const subjects = lower(ex.subjectContains);
  const labels = new Set([...ALWAYS_EXCLUDED_LABELS, ...lower(ex.labels)]);
  const titles = lower(ex.calendarTitleContains);
  const domainHit = (a: string) => domains.some((d) => a.endsWith(`@${d}`) || a.endsWith(`.${d}`));
  return {
    mail(m: ParsedMail, all: string[]): keyof ImportReport['mail']['excluded'] | null {
      if (m.labels.some((l) => labels.has(l.toLowerCase()))) return 'label';
      if (all.some((a) => addresses.has(a))) return 'address';
      if (all.some(domainHit)) return 'domain';
      const subj = m.subject.toLowerCase();
      if (subjects.some((s) => subj.includes(s))) return 'subject';
      return null;
    },
    meeting(o: IcsOccurrence): boolean {
      const all = [o.organizer, ...o.attendees.map((a) => a.address)].filter((x): x is string => !!x);
      const t = o.title.toLowerCase();
      return all.some((a) => addresses.has(a) || domainHit(a)) || titles.some((s) => t.includes(s));
    },
  };
}

export async function importTakeout(db: Db, opts: ImportOptions): Promise<ImportReport> {
  const principal = (await db.query<{ primary_email: string; timezone: string }>('SELECT primary_email, timezone FROM principals WHERE id = $1', [opts.principalId])).rows[0];
  if (!principal) throw new Error('unknown principal');
  const me = new Set([principal.primary_email, ...lower(opts.aliases ?? []).map(normalizeAddress)]);
  const asPrincipal = (a: string) => (me.has(a) ? principal.primary_email : a);
  const exclude = exclusionMatcher(opts.exclusions);
  const onlyCorrespondents = opts.onlyCorrespondents ?? true;
  const report: ImportReport = {
    dryRun: !!opts.dryRun,
    mail: { read: 0, unparseable: 0, outOfWindow: 0, excluded: { address: 0, domain: 0, subject: 0, label: 0 }, withoutCorrespondent: 0, stored: 0, alreadyPresent: 0 },
    calendar: { events: 0, occurrencesInWindow: 0, allDaySkipped: 0, excluded: 0, stored: 0, unsupportedRecurrence: 0, unknownTimezone: 0, invalid: 0 },
    people: { created: 0, alreadyKnown: 0 },
    sentToClaude: 0,
  };

  // ---- 1. read mail (kept in memory only within the window)
  const mails: { m: ParsedMail; from: string; to: string[] }[] = [];
  if (opts.mboxPath) {
    for await (const raw of readMbox(opts.mboxPath)) {
      report.mail.read++;
      let m: ParsedMail;
      try {
        m = parseMail(raw);
      } catch {
        report.mail.unparseable++;
        continue;
      }
      if (!m.from || !m.date) {
        report.mail.unparseable++;
        continue;
      }
      if (m.date < opts.since || m.date > opts.until) {
        report.mail.outOfWindow++;
        continue;
      }
      const from = asPrincipal(normalizeAddress(m.from.address));
      const to = [...new Set([...m.to, ...m.cc].map((a) => asPrincipal(normalizeAddress(a.address))))];
      const why = exclude.mail(m, [from, ...to]);
      if (why) {
        report.mail.excluded[why]++;
        continue;
      }
      mails.push({ m, from, to });
    }
  }

  // ---- 2. read calendar
  const meetings: IcsOccurrence[] = [];
  const lookahead = (opts.meetingLookaheadDays ?? 60) * 86_400_000;
  for (const file of opts.icsPaths ?? []) {
    const r = parseIcs(fs.readFileSync(file, 'utf8'), { from: opts.since, to: new Date(opts.until.getTime() + lookahead), defaultTz: principal.timezone });
    for (const k of ['events', 'unsupportedRecurrence', 'unknownTimezone', 'invalid'] as const) report.calendar[k] += r.stats[k];
    for (const o of r.occurrences) {
      report.calendar.occurrencesInWindow++;
      if (o.allDay) report.calendar.allDaySkipped++;
      else if (exclude.meeting(o)) report.calendar.excluded++;
      else meetings.push(o);
    }
  }

  // ---- 3. correspondents (deterministic): people the principal wrote to, or met in a small meeting
  const names = new Map<string, Map<string, number>>();
  const seeName = (a: string, n: string | null) => {
    if (!n || me.has(a)) return;
    const c = names.get(a) ?? new Map<string, number>();
    c.set(n, (c.get(n) ?? 0) + 1);
    names.set(a, c);
  };
  const correspondents = new Set<string>();
  for (const { m, from, to } of mails) {
    seeName(from, m.from!.name);
    for (const a of [...m.to, ...m.cc]) seeName(normalizeAddress(a.address), a.name);
    if (from === principal.primary_email) for (const a of to) if (!me.has(a)) correspondents.add(a);
  }
  for (const o of meetings) {
    const all = [o.organizer, ...o.attendees.map((a) => a.address)].filter((x): x is string => !!x);
    for (const a of o.attendees) seeName(a.address, a.name);
    if (all.some((a) => me.has(a)) && all.length <= MAX_ATTENDEES_FOR_PEOPLE) for (const a of all) if (!me.has(a)) correspondents.add(a);
  }

  const known = new Set(
    (await db.query<{ value: string }>(`SELECT value FROM person_identifiers WHERE principal_id = $1 AND kind = 'email'`, [opts.principalId])).rows.map((r) => r.value),
  );
  const toCreate = [...correspondents].filter((a) => !known.has(a)).sort();
  report.people.alreadyKnown = [...correspondents].filter((a) => known.has(a)).length;
  report.people.created = toCreate.length;
  const isPerson = (a: string) => correspondents.has(a) || known.has(a);

  const keptMails = mails.filter(({ from, to }) => {
    const ok = !onlyCorrespondents || [from, ...to].some((a) => !me.has(a) && isPerson(a));
    if (!ok) report.mail.withoutCorrespondent++;
    return ok;
  });

  if (opts.dryRun) {
    report.mail.stored = keptMails.length;
    report.calendar.stored = meetings.length;
    return report;
  }

  // ---- 4. write (batched transactions; storeMessage / upsertMeeting are idempotent)
  const bestName = (a: string) => [...(names.get(a)?.entries() ?? [])].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.split('@')[0]!;
  await withTx(db, async (tx) => {
    for (const a of toCreate) await createPerson(tx, opts.principalId, { fullName: bestName(a), emails: [a], source: MAIL_PROVIDER });
  });
  for (let i = 0; i < keptMails.length; i += 200) {
    await withTx(db, async (tx) => {
      for (const { m, from, to } of keptMails.slice(i, i + 200)) {
        const externalId = m.messageId ?? `sha256:${sha256(`${from}|${m.date!.toISOString()}|${m.subject}`)}`;
        const r = await storeMessage(tx, opts.principalId, { provider: MAIL_PROVIDER, externalId, threadExternalId: m.threadId, from, to, subject: m.subject, body: m.body, sentAt: m.date! });
        if (r.inserted) report.mail.stored++;
        else report.mail.alreadyPresent++;
      }
    });
  }
  await withTx(db, async (tx) => {
    for (const o of meetings) {
      await upsertMeeting(tx, opts.principalId, {
        provider: CALENDAR_PROVIDER,
        externalId: o.externalId,
        title: o.title,
        description: o.description,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        status: o.status,
        attendees: [...new Set([o.organizer, ...o.attendees.map((a) => a.address)].filter((x): x is string => !!x).map(asPrincipal))],
      });
      report.calendar.stored++;
    }
    await appendAudit(tx, {
      principalId: opts.principalId,
      eventType: 'IMPORT_COMPLETED',
      actor: 'PRINCIPAL',
      subjectType: 'import',
      subjectId: MAIL_PROVIDER,
      payload: {
        files: [opts.mboxPath, ...(opts.icsPaths ?? [])].filter(Boolean).map((f) => path.basename(f!)),
        window: { since: opts.since.toISOString(), until: opts.until.toISOString() },
        mail: report.mail,
        calendar: report.calendar,
        people: report.people,
      },
    });
  });
  return report;
}
