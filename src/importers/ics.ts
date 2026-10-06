/**
 * Minimal, dependency-free iCalendar (.ics) reader for Google Calendar exports (read-only).
 *
 * Supported (REAL): VEVENT with UTC / TZID (IANA) / floating times, all-day detection, STATUS,
 * ORGANIZER / ATTENDEE mailto addresses, DESCRIPTION, EXDATE, RECURRENCE-ID overrides, and RRULE
 * with FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL and BYDAY (weekly only).
 * Not supported (PARTIAL, counted and reported): any other RRULE part (BYMONTHDAY, BYSETPOS,
 * monthly BYDAY like 2TU, …) — only the first occurrence is kept; non-IANA TZIDs.
 */
import { DAY_MS } from '../util/clock.js';

export interface IcsOccurrence {
  uid: string;
  externalId: string; // uid + occurrence start
  title: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  organizer: string | null;
  attendees: { address: string; name: string | null; partstat: string | null }[];
}

export interface IcsResult {
  occurrences: IcsOccurrence[];
  stats: { events: number; unsupportedRecurrence: number; unknownTimezone: number; invalid: number };
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseProp(line: string): Prop | null {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescapeText = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// ---------- time zones (via Intl, no tz database of our own) ----------

const tzValid = new Map<string, boolean>();
export function isIanaZone(tz: string): boolean {
  if (!tzValid.has(tz)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      tzValid.set(tz, true);
    } catch {
      tzValid.set(tz, false);
    }
  }
  return tzValid.get(tz)!;
}

function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `tz` (given as a naive UTC timestamp of its fields) → real UTC instant. */
export function zonedToUtc(naiveMs: number, tz: string): Date {
  let t = naiveMs - offsetMs(naiveMs, tz);
  t = naiveMs - offsetMs(t, tz); // second pass settles DST transitions
  return new Date(t);
}

interface Stamp {
  naive: number; // wall-clock fields as a UTC timestamp
  tz: string | null; // null = already UTC
  allDay: boolean;
}

function parseStamp(p: Prop, defaultTz: string): Stamp | 'UNKNOWN_TZ' | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const naive = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const allDay = !m[4];
  if (m[7]) return { naive, tz: null, allDay };
  const tz = p.params.TZID ?? defaultTz;
  if (!isIanaZone(tz)) return 'UNKNOWN_TZ';
  return { naive, tz, allDay };
}

const toUtc = (s: Stamp) => (s.tz ? zonedToUtc(s.naive, s.tz) : new Date(s.naive));

// ---------- recurrence ----------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null; // naive ms in the event's zone (approximation for UNTIL in UTC is fine at day granularity)
  byDay: number[] | null;
}

function parseRule(value: string): Rule | null {
  const kv = Object.fromEntries(value.split(';').map((x) => x.split('=') as [string, string]));
  const freq = kv.FREQ as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const supported = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);
  if (Object.keys(kv).some((k) => !supported.has(k))) return null;
  let byDay: number[] | null = null;
  if (kv.BYDAY) {
    if (freq !== 'WEEKLY') return null;
    byDay = kv.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d));
    if (byDay.some((d) => d < 0)) return null; // ordinal forms like 2TU
  }
  let until: number | null = null;
  if (kv.UNTIL) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(kv.UNTIL);
    if (!u) return null;
    until = Date.UTC(+u[1]!, +u[2]! - 1, +u[3]!, +(u[4] ?? 23), +(u[5] ?? 59), +(u[6] ?? 59));
  }
  return { freq, interval: Math.max(1, Number(kv.INTERVAL ?? 1)), count: kv.COUNT ? Number(kv.COUNT) : null, until, byDay };
}

/** Naive start times of each occurrence, ascending, up to `endNaive`. */
function expand(startNaive: number, rule: Rule, endNaive: number, max = 5000): number[] {
  const out: number[] = [];
  const start = new Date(startNaive);
  const timeOfDay = startNaive % DAY_MS;
  const startDay = startNaive - timeOfDay;
  const weekStart = startDay - ((start.getUTCDay() + 6) % 7) * DAY_MS; // Monday of DTSTART's week
  const limit = Math.min(endNaive, rule.until ?? Infinity);
  for (let day = startDay; day + timeOfDay <= limit && out.length < max; day += DAY_MS) {
    const d = new Date(day);
    let hit = false;
    if (rule.freq === 'DAILY') hit = Math.round((day - startDay) / DAY_MS) % rule.interval === 0;
    else if (rule.freq === 'WEEKLY') {
      const days = rule.byDay ?? [start.getUTCDay()];
      hit = days.includes(d.getUTCDay()) && Math.floor(Math.round((day - weekStart) / DAY_MS) / 7) % rule.interval === 0;
    } else if (rule.freq === 'MONTHLY') {
      const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
      hit = d.getUTCDate() === start.getUTCDate() && months % rule.interval === 0;
    } else {
      hit = d.getUTCMonth() === start.getUTCMonth() && d.getUTCDate() === start.getUTCDate() && (d.getUTCFullYear() - start.getUTCFullYear()) % rule.interval === 0;
    }
    if (!hit || day < startDay) continue;
    out.push(day + timeOfDay);
    if (rule.count !== null && out.length >= rule.count) break;
  }
  return out;
}

// ---------- events ----------

function mailto(v: string): string | null {
  const a = v.replace(/^mailto:/i, '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(a) ? a : null;
}

/**
 * Parses an .ics text and returns concrete occurrences overlapping [from, to].
 * `defaultTz` is used for floating times (no TZID, no Z).
 */
export function parseIcs(text: string, opts: { from: Date; to: Date; defaultTz: string }): IcsResult {
  const stats = { events: 0, unsupportedRecurrence: 0, unknownTimezone: 0, invalid: 0 };
  const events: Prop[][] = [];
  let cur: Prop[] | null = null;
  let depth = 0; // nested components inside VEVENT (VALARM) are skipped
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      cur = [];
      depth = 0;
    } else if (/^END:VEVENT$/i.test(line)) {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      if (/^BEGIN:/i.test(line)) depth++;
      else if (/^END:/i.test(line)) depth--;
      else if (depth === 0) {
        const p = parseProp(line);
        if (p) cur.push(p);
      }
    }
  }

  const overrides = new Map<string, Map<number, IcsOccurrence | 'CANCELLED'>>();
  const base: IcsOccurrence[] = [];
  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();

  for (const props of events) {
    stats.events++;
    const get = (n: string) => props.find((p) => p.name === n);
    const uid = get('UID')?.value;
    const dtstart = get('DTSTART');
    if (!uid || !dtstart) {
      stats.invalid++;
      continue;
    }
    const s = parseStamp(dtstart, opts.defaultTz);
    if (s === 'UNKNOWN_TZ') {
      stats.unknownTimezone++;
      continue;
    }
    if (!s) {
      stats.invalid++;
      continue;
    }
    const dtend = get('DTEND');
    const e = dtend ? parseStamp(dtend, opts.defaultTz) : null;
    const durationMs = e && e !== 'UNKNOWN_TZ' ? e.naive - s.naive : s.allDay ? DAY_MS : 0;
    const statusRaw = (get('STATUS')?.value ?? 'CONFIRMED').toUpperCase();
    const status = (['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(statusRaw) ? statusRaw : 'CONFIRMED') as IcsOccurrence['status'];
    const make = (naive: number): IcsOccurrence => {
      const st: Stamp = { ...s, naive };
      const startsAt = toUtc(st);
      const endsAt = toUtc({ ...st, naive: naive + durationMs });
      return {
        uid,
        externalId: `${uid}@${startsAt.toISOString()}`,
        title: unescapeText(get('SUMMARY')?.value ?? '(sem título)'),
        description: unescapeText(get('DESCRIPTION')?.value ?? ''),
        startsAt,
        endsAt,
        allDay: s.allDay,
        status,
        organizer: get('ORGANIZER') ? mailto(get('ORGANIZER')!.value) : null,
        attendees: props
          .filter((p) => p.name === 'ATTENDEE')
          .map((p) => ({ address: mailto(p.value), name: p.params.CN ?? null, partstat: p.params.PARTSTAT ?? null }))
          .filter((a): a is { address: string; name: string | null; partstat: string | null } => !!a.address),
      };
    };

    const recurrenceId = get('RECURRENCE-ID');
    if (recurrenceId) {
      const r = parseStamp(recurrenceId, opts.defaultTz);
      if (r && r !== 'UNKNOWN_TZ') {
        const key = toUtc(r).getTime();
        const map = overrides.get(uid) ?? new Map();
        map.set(key, status === 'CANCELLED' ? 'CANCELLED' : make(s.naive));
        overrides.set(uid, map);
      }
      continue;
    }

    const exdates = new Set(
      props
        .filter((p) => p.name === 'EXDATE')
        .flatMap((p) => p.value.split(',').map((v) => parseStamp({ ...p, value: v }, opts.defaultTz)))
        .filter((x): x is Stamp => !!x && x !== 'UNKNOWN_TZ')
        .map((x) => toUtc(x).getTime()),
    );
    const rrule = get('RRULE');
    let starts: number[];
    if (rrule) {
      const rule = parseRule(rrule.value);
      if (rule) starts = expand(s.naive, rule, toMs + 14 * 3600_000 + 2 * DAY_MS);
      else {
        stats.unsupportedRecurrence++;
        starts = [s.naive];
      }
    } else starts = [s.naive];
    for (const n of starts) {
      const occ = make(n);
      if (exdates.has(occ.startsAt.getTime())) continue;
      base.push(occ);
    }
  }

  const out: IcsOccurrence[] = [];
  for (const occ of base) {
    const o = overrides.get(occ.uid)?.get(occ.startsAt.getTime());
    if (o === 'CANCELLED') continue;
    const final = o ?? occ;
    if (final.endsAt.getTime() >= fromMs && final.startsAt.getTime() <= toMs) out.push(o ? { ...o, externalId: occ.externalId } : final);
  }
  return { occurrences: out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()), stats };
}
