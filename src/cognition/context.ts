/**
 * Context retrieval. Deterministic gathering of the records relevant to an event, each exposed to
 * Claude under a short handle (P1, M3, MT1, ...). The registry maps every handle back to a real
 * record; anything Claude cites that is not in the registry is rejected by the validator.
 */
import type { Queryable } from '../db/db.js';
import type { Commitment, EvidenceKind, EvidenceRef, Meeting, Memory, Message, Person, Principal, Relationship, WendyEvent } from '../domain/types.js';
import type { Repositories } from '../repositories/pg.js';
import { DAY_MS } from '../util/clock.js';
import { relationshipMetrics, renderMetrics } from '../people/relationshipMetrics.js';
import { memoryFreshness } from '../memory/freshness.js';

export interface EvidenceItem {
  handle: string;
  ref: EvidenceRef;
  /** When the underlying fact happened (for ordering and impossible-timestamp checks). */
  at: Date | null;
  /** Deterministic rendering of the record (field values only, no interpretation). */
  text: string;
  meta: Record<string, unknown>;
}

export class EvidenceRegistry {
  private readonly byHandle = new Map<string, EvidenceItem>();
  private readonly byRef = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  private static PREFIX: Record<EvidenceKind, string> = {
    event: 'E',
    message: 'M',
    meeting: 'MT',
    commitment: 'C',
    memory: 'MEM',
    person: 'P',
    relationship: 'R',
    insight: 'I',
    action: 'A',
    search_metric: 'SC',
  };

  add(ref: EvidenceRef, at: Date | null, text: string, meta: Record<string, unknown> = {}): string {
    const key = `${ref.kind}:${ref.id}`;
    const existing = this.byRef.get(key);
    if (existing) return existing;
    const prefix = EvidenceRegistry.PREFIX[ref.kind];
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const handle = `${prefix}${n}`;
    this.byHandle.set(handle, { handle, ref, at, text, meta });
    this.byRef.set(key, handle);
    return handle;
  }

  get(handle: string): EvidenceItem | undefined {
    return this.byHandle.get(handle.trim());
  }

  handleFor(ref: EvidenceRef): string | undefined {
    return this.byRef.get(`${ref.kind}:${ref.id}`);
  }

  items(): EvidenceItem[] {
    return [...this.byHandle.values()];
  }

  refs(): EvidenceRef[] {
    return this.items().map((i) => i.ref);
  }

  toJSON(): Record<string, EvidenceRef> {
    return Object.fromEntries(this.items().map((i) => [i.handle, i.ref]));
  }
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : 'unknown');
const clip = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderPerson(p: Person, rel: Relationship | null, emails: string[]): string {
  return [
    `name: ${p.full_name}`,
    p.title ? `title: ${p.title}` : null,
    emails.length ? `emails: ${emails.join(', ')}` : null,
    p.birthdate ? `birthdate: ${p.birthdate}` : null,
    rel ? `relationship: ${rel.kind}${rel.explicit_importance != null ? `, importance set by principal: ${rel.explicit_importance}` : ''}` : 'relationship: none recorded',
    rel?.notes ? `relationship notes: ${rel.notes}` : null,
    `record source: ${p.source}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderMessage(m: Message, people: Map<string, string>): string {
  const name = (addr: string) => (people.has(addr) ? `${people.get(addr)} <${addr}>` : addr);
  return [`${m.direction} email sent ${iso(m.sent_at)}`, `from: ${name(m.from_address)}`, `to: ${m.to_addresses.map(name).join(', ')}`, `subject: ${m.subject}`, `body: ${clip(m.body)}`].join(
    '\n',
  );
}

export function renderMeeting(m: Meeting): string {
  return [
    `meeting "${m.title}" status ${m.status}`,
    `starts ${iso(m.starts_at)}, ends ${iso(m.ends_at)}`,
    m.description ? `description: ${clip(m.description, 600)}` : null,
    `attendees: ${(m.attendees ?? []).map((a) => a.address).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderCommitment(c: Commitment, counterparty: string): string {
  return [
    `commitment owed by ${c.owner === 'PRINCIPAL' ? 'the principal' : counterparty} to ${c.owner === 'PRINCIPAL' ? counterparty : 'the principal'}`,
    `description: ${c.description}`,
    `due ${iso(c.due_at)}, status ${c.status}, recorded ${iso(c.created_at)}`,
  ].join('\n');
}

export function renderMemory(m: Memory, subject: string | null, now: Date): string {
  const f = memoryFreshness(m, now);
  return [
    `${m.kind} memory${subject ? ` about ${subject}` : ' (principal-level)'}, written by ${m.written_by} ${iso(m.created_at)}, confidence ${m.confidence}`,
    `last confirmed ${m.last_confirmed_at ? iso(m.last_confirmed_at) : 'never (age counted from creation)'}; ${f.ageDays} days old; freshness ${f.weight} (half-life ${f.halfLifeDays} days)${f.needsReview ? '; older than one half-life — may be outdated' : ''}`,
    `content: ${m.content}`,
  ].join('\n');
}

export interface ContextBundle {
  registry: EvidenceRegistry;
  eventHandle: string;
  focusPeople: string[]; // person handles
  sourceText: string | null;
}

export interface RetrievalInput {
  principal: Principal;
  event: WendyEvent;
  now: Date;
  /** Upper bound for records considered "already happened" (event time). */
  asOf: Date;
  focusPersonIds: string[];
  searchTerms: string[];
  eventText: string;
  sourceText: string | null;
  extraRefs?: { ref: EvidenceRef; at: Date | null; text: string; meta?: Record<string, unknown> }[];
}

export const RETRIEVAL_LIMITS = {
  recentMessagesPerPerson: 8,
  searchMessages: 8,
  searchLookbackDays: 180,
  meetingsLookaheadDays: 14,
  meetingsLookbackDays: 30,
  memoriesPerPerson: 12,
  principalPreferences: 10,
  searchMemories: 8,
  searchCommitments: 6,
  priorInsightsDays: 14,
};

async function emailsOf(q: Queryable, principalId: string, personId: string): Promise<string[]> {
  return (await q.query<{ value: string }>(`SELECT value FROM person_identifiers WHERE principal_id = $1 AND person_id = $2 AND kind = 'email'`, [principalId, personId])).rows.map(
    (r) => r.value,
  );
}

export async function retrieveContext(q: Queryable, repos: Repositories, input: RetrievalInput): Promise<ContextBundle> {
  const { principal, event, now, asOf } = input;
  const pid = principal.id;
  const L = RETRIEVAL_LIMITS;
  const registry = new EvidenceRegistry();
  const addressNames = new Map<string, string>([[principal.primary_email, `${principal.display_name} (principal)`]]);

  const eventHandle = registry.add({ kind: 'event', id: event.id }, event.occurred_at, input.eventText, { event_type: event.event_type });
  for (const x of input.extraRefs ?? []) registry.add(x.ref, x.at, x.text, x.meta ?? {});

  const personHandle = async (personId: string): Promise<string | null> => {
    const existing = registry.handleFor({ kind: 'person', id: personId });
    if (existing) return existing;
    const person = await repos.entities.getPerson(q, pid, personId);
    if (!person) return null;
    const rel = await repos.relationships.getRelationship(q, pid, personId);
    const emails = await emailsOf(q, pid, personId);
    for (const e of emails) addressNames.set(e, person.full_name);
    const metrics = await relationshipMetrics(q, pid, personId, now);
    return registry.add({ kind: 'person', id: personId }, null, `${renderPerson(person, rel, emails)}\n${renderMetrics(metrics)}`, { full_name: person.full_name, emails });
  };

  const focusPeople: string[] = [];
  for (const id of input.focusPersonIds) {
    const h = await personHandle(id);
    if (h) focusPeople.push(h);
  }

  const messages: Message[] = [];
  const meetings: Meeting[] = [];
  const commitments: Commitment[] = [];
  const memories: Memory[] = [];

  for (const personId of input.focusPersonIds) {
    messages.push(...(await repos.messages.recentWithPerson(q, pid, personId, asOf, L.recentMessagesPerPerson)));
    meetings.push(
      ...(await repos.meetings.withPersonBetween(q, pid, personId, new Date(now.getTime() - L.meetingsLookbackDays * DAY_MS), new Date(now.getTime() + L.meetingsLookaheadDays * DAY_MS))),
    );
    commitments.push(...(await repos.commitments.openForPerson(q, pid, personId)));
    memories.push(...(await repos.memories.activeForPerson(q, pid, personId, L.memoriesPerPerson)));
  }

  if (input.searchTerms.length) {
    messages.push(...(await repos.messages.search(q, pid, input.searchTerms, new Date(asOf.getTime() - L.searchLookbackDays * DAY_MS), asOf, L.searchMessages)));
    meetings.push(...(await repos.meetings.searchBetween(q, pid, input.searchTerms, now, new Date(now.getTime() + L.meetingsLookaheadDays * DAY_MS), 5)));
    commitments.push(...(await repos.commitments.search(q, pid, input.searchTerms, L.searchCommitments)));
    memories.push(...(await repos.memories.search(q, pid, input.searchTerms, L.searchMemories)));
  }
  memories.push(...(await repos.memories.activePrincipalLevel(q, pid, L.principalPreferences)));

  // People appearing in retrieved records get person entries too (so Claude can refer to them by handle).
  for (const m of meetings) for (const a of m.attendees ?? []) if (a.person_id) await personHandle(a.person_id);
  for (const c of commitments) await personHandle(c.counterparty_person_id);

  const dedupe = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];

  // The event's own message is already represented by the event; skip it in history.
  const ownMessageId = typeof event.payload.message_id === 'string' ? event.payload.message_id : null;
  for (const m of dedupe(messages)
    .filter((m) => m.id !== ownMessageId && m.sent_at.getTime() <= asOf.getTime())
    .sort((a, b) => a.sent_at.getTime() - b.sent_at.getTime())) {
    registry.add({ kind: 'message', id: m.id }, m.sent_at, renderMessage(m, addressNames), { direction: m.direction });
  }
  for (const m of dedupe(meetings).sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime())) {
    registry.add({ kind: 'meeting', id: m.id }, m.starts_at, renderMeeting(m), { status: m.status, starts_at: m.starts_at.toISOString() });
  }
  for (const c of dedupe(commitments)) {
    const cp = registry.get(registry.handleFor({ kind: 'person', id: c.counterparty_person_id }) ?? '')?.meta.full_name as string | undefined;
    registry.add({ kind: 'commitment', id: c.id }, c.due_at, renderCommitment(c, cp ?? 'unknown person'), { status: c.status, due_at: c.due_at.toISOString() });
  }
  for (const m of dedupe(memories)) {
    const subject = m.subject_person_id ? ((registry.get((await personHandle(m.subject_person_id)) ?? '')?.meta.full_name as string) ?? null) : null;
    registry.add({ kind: 'memory', id: m.id }, m.created_at, renderMemory(m, subject, now), { memory_kind: m.kind });
  }

  // Recent insights about the same people (for novelty and continuity).
  if (input.focusPersonIds.length) {
    const prior = await q.query<{ id: string; headline: string | null; created_at: Date; status: string }>(
      `SELECT DISTINCT i.id, i.headline, i.created_at, i.status FROM insights i
       JOIN claims c ON c.insight_id = i.id
       WHERE i.principal_id = $1 AND i.event_id <> $2 AND i.created_at >= $3
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.evidence) e WHERE e->>'kind' = 'person' AND e->>'id' = ANY($4::text[]))
       ORDER BY i.created_at DESC LIMIT 5`,
      [pid, event.id, new Date(now.getTime() - L.priorInsightsDays * DAY_MS), input.focusPersonIds],
    );
    for (const i of prior.rows) {
      registry.add({ kind: 'insight', id: i.id }, i.created_at, `earlier Wendy insight (${i.status}) ${iso(i.created_at)}: ${i.headline ?? '(no headline)'}`);
    }
  }

  return { registry, eventHandle, focusPeople, sourceText: input.sourceText };
}

export function renderEvidence(registry: EvidenceRegistry): string {
  return registry
    .items()
    .map((i) => `[${i.handle}] (${i.ref.kind})\n${i.text}`)
    .join('\n\n');
}
