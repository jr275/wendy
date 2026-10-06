/**
 * Relationship metrics derived from persisted interactions (never typed by hand).
 *
 * - volume: messages exchanged in the last 30 / 90 days
 * - direction: inbound (from them) vs outbound (from the principal) in 90 days → reciprocity
 * - reply latency: for each message, the time until the other side's next message (≤ 7 days)
 * - trend: rate in the last 30 days vs the rate in the 60 days before
 * - last inbound / last outbound / days since last contact
 * - meetings: held in the last 90 days (not cancelled) and the next scheduled one
 */
import type { Queryable } from '../db/db.js';
import { DAY_MS, HOUR_MS } from '../util/clock.js';

export interface RelationshipMetrics {
  messages30d: number;
  messages90d: number;
  inbound90d: number;
  outbound90d: number;
  reciprocity: number | null; // outbound / inbound in 90d; null when no inbound
  principalReplyHoursMedian: number | null;
  theirReplyHoursMedian: number | null;
  trend: 'UP' | 'DOWN' | 'STABLE' | 'NEW' | 'NONE';
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  daysSinceContact: number | null;
  meetings90d: number;
  nextMeetingAt: Date | null;
}

const REPLY_WINDOW_MS = 7 * DAY_MS;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function relationshipMetrics(q: Queryable, principalId: string, personId: string, now: Date): Promise<RelationshipMetrics> {
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const rows = (
    await q.query<{ sent_at: Date; direction: 'INBOUND' | 'OUTBOUND' }>(
      `SELECT DISTINCT m.id, m.sent_at, m.direction FROM messages m JOIN message_participants mp ON mp.message_id = m.id
       WHERE m.principal_id = $1 AND mp.person_id = $2 AND m.sent_at >= $3 AND m.sent_at <= $4
         AND ((m.direction = 'INBOUND' AND mp.role = 'FROM') OR (m.direction = 'OUTBOUND' AND mp.role = 'TO'))
       ORDER BY m.sent_at`,
      [principalId, personId, since, now],
    )
  ).rows;
  const last = (
    await q.query<{ last_in: Date | null; last_out: Date | null }>(
      `SELECT max(m.sent_at) FILTER (WHERE m.direction = 'INBOUND' AND mp.role = 'FROM') AS last_in,
              max(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND mp.role = 'TO') AS last_out
       FROM messages m JOIN message_participants mp ON mp.message_id = m.id
       WHERE m.principal_id = $1 AND mp.person_id = $2 AND m.sent_at <= $3`,
      [principalId, personId, now],
    )
  ).rows[0]!;

  const mt = (
    await q.query<{ held: number; next: Date | null }>(
      `SELECT count(DISTINCT mt.id) FILTER (WHERE mt.starts_at >= $3 AND mt.starts_at <= $4)::int AS held,
              min(mt.starts_at) FILTER (WHERE mt.starts_at > $4) AS next
       FROM meetings mt JOIN meeting_attendees a ON a.meeting_id = mt.id
       WHERE mt.principal_id = $1 AND a.person_id = $2 AND mt.status <> 'CANCELLED'`,
      [principalId, personId, since, now],
    )
  ).rows[0]!;

  const t30 = now.getTime() - 30 * DAY_MS;
  const messages30d = rows.filter((r) => r.sent_at.getTime() >= t30).length;
  const inbound90d = rows.filter((r) => r.direction === 'INBOUND').length;
  const outbound90d = rows.length - inbound90d;

  const principalReplies: number[] = [];
  const theirReplies: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i]!;
    const next = rows.slice(i + 1).find((r) => r.direction !== cur.direction);
    if (!next) continue;
    const dt = next.sent_at.getTime() - cur.sent_at.getTime();
    if (dt > REPLY_WINDOW_MS) continue;
    (cur.direction === 'INBOUND' ? principalReplies : theirReplies).push(dt / HOUR_MS);
  }

  const prior60 = rows.length - messages30d; // messages in the 60 days before the last 30
  const rate30 = messages30d / 30;
  const rate60 = prior60 / 60;
  const trend: RelationshipMetrics['trend'] =
    rows.length === 0 ? 'NONE' : prior60 === 0 ? 'NEW' : rate30 > rate60 * 1.5 ? 'UP' : rate30 < rate60 * 0.5 ? 'DOWN' : 'STABLE';

  const lastContact = [last.last_in, last.last_out].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    messages30d,
    messages90d: rows.length,
    inbound90d,
    outbound90d,
    reciprocity: inbound90d ? round1(outbound90d / inbound90d) : null,
    principalReplyHoursMedian: round1(median(principalReplies)),
    theirReplyHoursMedian: round1(median(theirReplies)),
    trend,
    lastInboundAt: last.last_in,
    lastOutboundAt: last.last_out,
    daysSinceContact: lastContact ? Math.floor((now.getTime() - lastContact.getTime()) / DAY_MS) : null,
    meetings90d: mt.held,
    nextMeetingAt: mt.next,
  };
}

/** Deterministic text rendering for evidence (facts only, no interpretation). */
export function renderMetrics(m: RelationshipMetrics): string {
  const h = (x: number | null) => (x === null ? 'n/a' : `${x}h`);
  return [
    `interactions: ${m.messages30d} messages in 30 days, ${m.messages90d} in 90 days (${m.inbound90d} from them, ${m.outbound90d} from the principal)`,
    `median reply time: principal ${h(m.principalReplyHoursMedian)}, them ${h(m.theirReplyHoursMedian)}`,
    `contact trend (30d vs prior 60d): ${m.trend}`,
    `days since last contact: ${m.daysSinceContact ?? 'never'}`,
    `meetings: ${m.meetings90d} in the last 90 days; next scheduled: ${m.nextMeetingAt ? m.nextMeetingAt.toISOString() : 'none'}`,
  ].join('\n');
}
