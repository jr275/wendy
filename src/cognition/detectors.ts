/**
 * State-derived event detectors. They read persisted state + the clock and emit events whose
 * payload holds only references and values computed by code (dates, hours). No conclusions.
 *
 *   Person + Birthdate + Now            => PERSON_DATE_APPROACHING
 *   Commitment + Due + Status + Now     => COMMITMENT_DUE
 *   Search Console windows (stored)     => SEARCH_PERFORMANCE_CHANGE (src/sensors/searchDetector.ts)
 *
 * Event keys make detection idempotent: re-running a detector never duplicates an event.
 */
import type { Db } from '../db/db.js';
import type { Person, Principal } from '../domain/types.js';
import { ingestEvent } from '../events/ingest.js';
import { PgCommitmentRepository, PgEntityRepository } from '../repositories/pg.js';
import { DAY_MS, HOUR_MS } from '../util/clock.js';
import { listWebProperties } from '../sensors/searchConsole.js';
import { runSearchDetector } from '../sensors/searchDetector.js';

export const DETECTOR_CONFIG = {
  personDateHorizonDays: 2,
  commitmentHorizonHours: 24,
  commitmentOverdueLookbackDays: 7,
};

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Next occurrence (on or after `today`) of an annual date; Feb 29 falls on Feb 28 in non-leap years. */
export function nextAnnualOccurrence(birthdate: string, today: string): { occursOn: string; daysUntil: number } {
  const [, bm, bd] = birthdate.split('-').map(Number) as [number, number, number];
  const [ty] = today.split('-').map(Number) as [number];
  const candidate = (year: number) => {
    const day = bm === 2 && bd === 29 && !isLeap(year) ? 28 : bd;
    return `${year}-${String(bm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  let occursOn = candidate(ty);
  if (occursOn < today) occursOn = candidate(ty + 1);
  const daysUntil = Math.round((Date.parse(`${occursOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  return { occursOn, daysUntil };
}

export function personDateFacts(person: Person, principal: Principal, now: Date) {
  if (!person.birthdate) return null;
  const today = localDate(now, principal.timezone);
  return { kind: 'BIRTHDAY' as const, today, ...nextAnnualOccurrence(person.birthdate, today) };
}

export async function runDetectors(db: Db, principal: Principal, now: Date): Promise<{ emitted: string[] }> {
  const entities = new PgEntityRepository();
  const commitments = new PgCommitmentRepository();
  const emitted: string[] = [];

  for (const person of await entities.listPeopleWithBirthdates(db, principal.id)) {
    const facts = personDateFacts(person, principal, now);
    if (!facts || facts.daysUntil > DETECTOR_CONFIG.personDateHorizonDays) continue;
    const { event, duplicate } = await ingestEvent(db, {
      principalId: principal.id,
      eventType: 'PERSON_DATE_APPROACHING',
      source: 'DETECTOR',
      sourceEventKey: `birthday:${person.id}:${facts.occursOn}`,
      occurredAt: now,
      actor: { kind: 'DETECTOR' },
      entityRefs: [{ kind: 'person', id: person.id }],
      payload: { person_id: person.id, date_kind: facts.kind, occurs_on: facts.occursOn, days_until: facts.daysUntil },
      confidence: 1,
      provenance: { origin: 'DETECTOR', detector: 'person-dates-v1' },
    });
    if (!duplicate) emitted.push(event.id);
  }

  const horizon = new Date(now.getTime() + DETECTOR_CONFIG.commitmentHorizonHours * HOUR_MS);
  const lookback = now.getTime() - DETECTOR_CONFIG.commitmentOverdueLookbackDays * DAY_MS;
  for (const c of await commitments.openDueBefore(db, principal.id, horizon)) {
    if (c.due_at.getTime() < lookback) continue;
    const { event, duplicate } = await ingestEvent(db, {
      principalId: principal.id,
      eventType: 'COMMITMENT_DUE',
      source: 'DETECTOR',
      sourceEventKey: `commitment:${c.id}:${c.due_at.toISOString()}`,
      occurredAt: now,
      actor: { kind: 'DETECTOR' },
      entityRefs: [{ kind: 'commitment', id: c.id }, { kind: 'person', id: c.counterparty_person_id }],
      payload: {
        commitment_id: c.id,
        due_at: c.due_at.toISOString(),
        hours_until_due: Math.round(((c.due_at.getTime() - now.getTime()) / HOUR_MS) * 10) / 10,
      },
      confidence: 1,
      provenance: { origin: 'DETECTOR', detector: 'commitments-v1' },
    });
    if (!duplicate) emitted.push(event.id);
  }

  // Website search performance (from stored Search Console windows; sync is a separate step).
  emitted.push(...(await runSearchDetector(db, principal.id, await listWebProperties(db, principal.id), now)));

  return { emitted };
}
