/** Google sync (read-only): backfill is context only, new mail from people becomes events, no duplicates. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import type { IcsOccurrence } from '../../src/importers/ics.js';
import { parseMail, type ParsedMail } from '../../src/importers/mbox.js';
import { eventToOccurrence, GoogleRestApi, type GoogleApi } from '../../src/sensors/google/api.js';
import { registerConnection, syncGoogle } from '../../src/sensors/google/sync.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const ME = 'joao@example.test';

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'João', primaryEmail: ME, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  await registerConnection(db, pid, ME, ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'], new Date('2026-10-08T12:00:00Z'));
});
afterAll(() => t.drop());

const raw = (id: string, from: string, to: string, subject: string, date: string, body: string) =>
  `Message-ID: <${id}@mail.test>\r\nFrom: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date(date).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

class FakeGoogle implements GoogleApi {
  mails = new Map<string, { at: Date; m: ParsedMail }>();
  events: IcsOccurrence[] = [];
  fail: Error | null = null;
  add(id: string, from: string, to: string, subject: string, date: string, body = 'Olá') {
    this.mails.set(id, { at: new Date(date), m: { ...parseMail(raw(id, from, to, subject, date, body)), threadId: `t-${id}`, labels: ['inbox'] } });
  }
  async listMessageIds(after: Date) {
    if (this.fail) throw this.fail;
    return [...this.mails].filter(([, v]) => v.at > after).map(([k]) => k);
  }
  async getMessage(id: string) {
    return this.mails.get(id)?.m ?? null;
  }
  async listEvents(from: Date, to: Date) {
    return this.events.filter((e) => e.startsAt >= from && e.startsAt <= to);
  }
}

const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0]!.n;

describe('google sync', () => {
  const api = new FakeGoogle();

  it('backfill: correspondents and their mail become context, newsletters are dropped, no events', async () => {
    api.add('m1', `João <${ME}>`, 'Alice <alice@corp.test>', 'Proposta', '2026-09-20T12:00:00Z');
    api.add('m2', 'Alice <alice@corp.test>', ME, 'Re: Proposta', '2026-09-21T12:00:00Z');
    api.add('m3', 'News <news@promo.test>', ME, 'Ofertas', '2026-09-22T12:00:00Z');
    api.events.push(eventToOccurrence({ id: 'ev1', summary: 'Almoço com Alice', start: { dateTime: '2026-10-09T15:00:00Z' }, end: { dateTime: '2026-10-09T16:00:00Z' }, organizer: { email: ME }, attendees: [{ email: 'alice@corp.test', displayName: 'Alice' }] })!);

    const r = await syncGoogle(db, api, pid, new Date('2026-10-08T12:00:00Z'));
    expect(r.mode).toBe('backfill');
    expect(r.report.mail).toMatchObject({ stored: 2, withoutCorrespondent: 1 });
    expect(r.report.people.created).toBe(1);
    expect(r.report.calendar.stored).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM events WHERE event_type = 'EMAIL_RECEIVED'`)).toBe(0);
  });

  it('incremental: new mail from a known person becomes EMAIL_RECEIVED; re-sync adds nothing', async () => {
    api.add('m4', 'Alice <alice@corp.test>', ME, 'Contrato assinado', '2026-10-08T12:30:00Z');
    api.add('m5', 'Stranger <who@else.test>', ME, 'Oi', '2026-10-08T12:31:00Z');
    const r = await syncGoogle(db, api, pid, new Date('2026-10-08T12:40:00Z'));
    expect(r.mode).toBe('incremental');
    expect(r.report.mail.stored).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM events WHERE event_type = 'EMAIL_RECEIVED'`)).toBe(1);

    await syncGoogle(db, api, pid, new Date('2026-10-08T12:45:00Z'));
    expect(await count(`SELECT count(*)::int n FROM messages WHERE provider = 'GMAIL'`)).toBe(3);
    expect(await count(`SELECT count(*)::int n FROM events WHERE event_type = 'EMAIL_RECEIVED'`)).toBe(1);
  });

  it('an expired authorization marks the source NEEDS_REAUTH', async () => {
    api.fail = new Error('invalid_grant: Token has been expired or revoked.');
    await expect(syncGoogle(db, api, pid, new Date('2026-10-08T13:00:00Z'))).rejects.toThrow('invalid_grant');
    expect((await db.query(`SELECT status FROM connected_sources WHERE principal_id = $1`, [pid])).rows[0].status).toBe('NEEDS_REAUTH');
  });

  it('maps calendar events: all-day, cancelled, attendees', () => {
    expect(eventToOccurrence({ id: 'a', summary: 'Feriado', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } })).toMatchObject({ allDay: true });
    expect(eventToOccurrence({ id: 'b', status: 'cancelled', start: { dateTime: '2026-10-12T10:00:00Z' }, end: { dateTime: '2026-10-12T11:00:00Z' } })).toMatchObject({ status: 'CANCELLED', title: '(sem título)' });
  });

  it('only ever issues GET requests', async () => {
    const methods: string[] = [];
    const client = {
      request: async (o: { method: string; url: string }) => {
        methods.push(o.method);
        if (o.url.includes('/messages/')) return { data: { id: 'x', threadId: 't', labelIds: ['SPAM'], raw: Buffer.from(raw('x', 'A <a@b.test>', ME, 'S', '2026-10-01T00:00:00Z', 'b')).toString('base64url') } };
        return { data: {} };
      },
    };
    const g = new GoogleRestApi(client as never);
    await g.listMessageIds(new Date());
    const m = await g.getMessage('x');
    await g.listEvents(new Date(), new Date());
    expect(new Set(methods)).toEqual(new Set(['GET']));
    expect(m?.labels).toEqual(['spam']); // Gmail system labels map onto the importer's exclusion names
  });

  it('waits out a Gmail rate limit and retries instead of failing', async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = {
      request: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost'"), { response: { status: 403 } });
        return { data: { messages: [{ id: 'a' }] } };
      },
    };
    const g = new GoogleRestApi(client as never, async (ms) => void waits.push(ms));
    expect(await g.listMessageIds(new Date())).toEqual(['a']);
    expect(calls).toBe(2);
    expect(waits.some((w) => w >= 20_000)).toBe(true);
  });
});
