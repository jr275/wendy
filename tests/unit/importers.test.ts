import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { parseIcs, zonedToUtc } from '../../src/importers/ics.js';
import { decodeWords, parseAddressList, parseMail, readMbox } from '../../src/importers/mbox.js';
import { importTakeout, loadExclusions, MAIL_PROVIDER } from '../../src/importers/takeout.js';
import { relationshipMetrics } from '../../src/people/relationshipMetrics.js';
import { createTestDb } from '../helpers/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-import-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Builds an mbox file; bodies are given as latin1 strings (raw bytes). */
function writeMbox(name: string, messages: string[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.from(messages.map((m) => `From 1234567890@xxx Mon Sep 28 10:00:00 +0000 2026\n${m}\n`).join('\n'), 'latin1'));
  return file;
}
const utf8AsLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

describe('mbox / MIME parsing', () => {
  it('decodes encoded words (B and Q, several charsets) and raw UTF-8 headers', () => {
    expect(decodeWords('=?UTF-8?B?UHJvcG9zdGEgZGUgcHJlw6dv?=')).toBe('Proposta de preço');
    expect(decodeWords('=?iso-8859-1?Q?Jo=E3o_Mendes?=')).toBe('João Mendes');
    expect(decodeWords('=?UTF-8?Q?Reuni=C3=A3o?= =?UTF-8?Q?_amanh=C3=A3?=')).toBe('Reunião amanhã');
    expect(decodeWords(utf8AsLatin1('Revisão do contrato'))).toBe('Revisão do contrato');
  });

  it('parses address lists with quoted commas, comments and encoded names', () => {
    expect(parseAddressList('"Drummond, Carlos" <Carlos@HorizonCap.com>, ana@x.com (Ana Lima), =?UTF-8?Q?In=C3=AAs?= <ines@y.com>, nonsense')).toEqual([
      { address: 'carlos@horizoncap.com', name: 'Drummond, Carlos' },
      { address: 'ana@x.com', name: 'Ana Lima' },
      { address: 'ines@y.com', name: 'Inês' },
    ]);
  });

  it('prefers text/plain in multipart/alternative, decodes quoted-printable in the declared charset, ignores attachments', () => {
    const raw = [
      'Message-ID: <a1@x>',
      'From: Carlos <carlos@horizoncap.com>',
      'To: joao@mendes.com',
      'Subject: =?UTF-8?Q?Pre=C3=A7o?=',
      'Date: Tue, 29 Sep 2026 14:05:00 -0300',
      'X-GM-THRID: 1777',
      'X-Gmail-Labels: Inbox,Importante',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Pre=E7o revisado at=E9 sexta, com uma linha muito longa que foi quebrada pelo =',
      'cliente de e-mail.',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version</p>',
      '--inner--',
      '--outer',
      'Content-Type: text/plain; name="anexo.txt"',
      'Content-Disposition: attachment; filename="anexo.txt"',
      '',
      'SECRET ATTACHMENT CONTENT',
      '--outer--',
    ].join('\n');
    const m = parseMail(raw);
    expect(m.subject).toBe('Preço');
    expect(m.body).toBe('Preço revisado até sexta, com uma linha muito longa que foi quebrada pelo cliente de e-mail.');
    expect(m.body).not.toContain('SECRET');
    expect(m.threadId).toBe('1777');
    expect(m.labels).toEqual(['Inbox', 'Importante']);
    expect(m.date!.toISOString()).toBe('2026-09-29T17:05:00.000Z');
  });

  it('decodes base64 HTML-only bodies into plain text', () => {
    const html = Buffer.from('<html><head><style>p{}</style></head><body><p>Olá&nbsp;Carlos</p><p>Segue &amp; anexo</p></body></html>', 'utf8').toString('base64');
    const m = parseMail(`From: a@b.com\nSubject: x\nDate: Tue, 29 Sep 2026 10:00:00 +0000\nContent-Type: text/html; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n${html}`);
    expect(m.body).toBe('Olá Carlos\nSegue & anexo');
  });

  it('splits an mbox stream and un-escapes >From lines', async () => {
    const file = writeMbox('split.mbox', ['From: a@b.com\nSubject: one\n\nline\n>From the start', 'From: c@d.com\nSubject: two\n\nbody']);
    const raws: string[] = [];
    for await (const r of readMbox(file)) raws.push(r);
    expect(raws).toHaveLength(2);
    expect(parseMail(raws[0]!).body).toBe('line\nFrom the start');
    expect(parseMail(raws[1]!).subject).toBe('two');
  });
});

const ics = (events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const window = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z'), defaultTz: 'America/Sao_Paulo' };

describe('ics parsing', () => {
  it('converts wall-clock times in a zone to UTC, across a DST change', () => {
    expect(zonedToUtc(Date.UTC(2026, 9, 6, 14, 0), 'America/Sao_Paulo').toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(zonedToUtc(Date.UTC(2026, 9, 26, 10, 0), 'America/New_York').toISOString()).toBe('2026-10-26T14:00:00.000Z'); // EDT
    expect(zonedToUtc(Date.UTC(2026, 10, 9, 10, 0), 'America/New_York').toISOString()).toBe('2026-11-09T15:00:00.000Z'); // EST
  });

  it('reads a single event with folded lines, escaped text, organizer and attendees', () => {
    const r = parseIcs(
      ics([
        'BEGIN:VEVENT',
        'UID:one@google.com',
        'DTSTART;TZID=America/Sao_Paulo:20261006T140000',
        'DTEND;TZID=America/Sao_Paulo:20261006T150000',
        'SUMMARY:Revis\\, pricing',
        'DESCRIPTION:Linha 1\\nLinha 2 com texto que continua',
        '  na linha dobrada',
        'ORGANIZER;CN=João:mailto:joao@mendes.com',
        'ATTENDEE;CN="Drummond, Carlos";PARTSTAT=ACCEPTED:mailto:Carlos@HorizonCap.com',
        'BEGIN:VALARM',
        'SUMMARY:alarm should be ignored',
        'END:VALARM',
        'END:VEVENT',
      ]),
      window,
    );
    expect(r.occurrences).toHaveLength(1);
    const o = r.occurrences[0]!;
    expect(o.title).toBe('Revis, pricing');
    expect(o.description).toBe('Linha 1\nLinha 2 com texto que continua na linha dobrada');
    expect(o.startsAt.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(o.organizer).toBe('joao@mendes.com');
    expect(o.attendees).toEqual([{ address: 'carlos@horizoncap.com', name: 'Drummond, Carlos', partstat: 'ACCEPTED' }]);
  });

  it('expands weekly recurrences in local time, honoring COUNT, EXDATE and RECURRENCE-ID overrides', () => {
    const r = parseIcs(
      ics([
        'BEGIN:VEVENT',
        'UID:weekly@google.com',
        'DTSTART;TZID=America/New_York:20261019T100000',
        'DTEND;TZID=America/New_York:20261019T103000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5',
        'EXDATE;TZID=America/New_York:20261026T100000',
        'SUMMARY:1:1',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:weekly@google.com',
        'RECURRENCE-ID;TZID=America/New_York:20261102T100000',
        'DTSTART;TZID=America/New_York:20261103T110000',
        'DTEND;TZID=America/New_York:20261103T113000',
        'SUMMARY:1:1 (moved)',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:weekly@google.com',
        'RECURRENCE-ID;TZID=America/New_York:20261109T100000',
        'DTSTART;TZID=America/New_York:20261109T100000',
        'STATUS:CANCELLED',
        'SUMMARY:1:1',
        'END:VEVENT',
      ]),
      window,
    );
    expect(r.occurrences.map((o) => [o.title, o.startsAt.toISOString()])).toEqual([
      ['1:1', '2026-10-19T14:00:00.000Z'],
      ['1:1 (moved)', '2026-11-03T16:00:00.000Z'],
      ['1:1', '2026-11-16T15:00:00.000Z'], // after DST ended: still 10:00 local
    ]);
  });

  it('counts what it cannot handle instead of guessing', () => {
    const r = parseIcs(
      ics([
        'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261001T120000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU\r\nSUMMARY:x\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:b\r\nDTSTART;TZID=Pacific Standard Time:20261001T120000\r\nSUMMARY:y\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:c\r\nDTSTART;VALUE=DATE:20261010\r\nSUMMARY:Feriado\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nSUMMARY:no uid\r\nEND:VEVENT',
      ]),
      window,
    );
    expect(r.stats).toMatchObject({ unsupportedRecurrence: 1, unknownTimezone: 1, invalid: 1 });
    expect(r.occurrences.map((o) => o.uid)).toEqual(['a', 'c']);
    expect(r.occurrences.find((o) => o.uid === 'c')!.allDay).toBe(true);
  });
});

describe('takeout import', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let principalId: string;
  const since = new Date('2026-07-01T00:00:00Z');
  const until = new Date('2026-10-06T12:00:00Z');
  let mbox: string;
  let calendar: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    principalId = await createPrincipal(db, { displayName: 'J', primaryEmail: 'joao@mendes.com', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
    const mail = (id: string, from: string, to: string, date: string, subject: string, body: string, extra = '') =>
      `Message-ID: <${id}@x>\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n${extra}Content-Type: text/plain; charset=utf-8\n\n${utf8AsLatin1(body)}`;
    mbox = writeMbox('takeout.mbox', [
      mail('m1', 'Carlos Drummond <carlos@horizoncap.com>', 'joao@mendes.com', 'Mon, 28 Sep 2026 09:00:00 -0300', 'Pricing', 'Can you review the pricing?'),
      mail('m2', 'João <joao.alt@gmail.com>', 'Carlos Drummond <carlos@horizoncap.com>', 'Mon, 28 Sep 2026 11:00:00 -0300', 'Re: Pricing', 'Vou revisar até sexta.'),
      mail('m3', 'News <news@letter.com>', 'joao@mendes.com', 'Tue, 29 Sep 2026 08:00:00 -0300', 'Weekly digest', 'Unsubscribe'),
      mail('m4', 'Banco <alerta@banco-exemplo.com.br>', 'joao@mendes.com', 'Tue, 29 Sep 2026 08:00:00 -0300', 'Seu extrato', 'saldo'),
      mail('m5', 'Carlos Drummond <carlos@horizoncap.com>', 'joao@mendes.com', 'Wed, 30 Sep 2026 08:00:00 -0300', 'Ganhe dinheiro', 'spam', 'X-Gmail-Labels: Spam\n'),
      mail('m6', 'Carlos Drummond <carlos@horizoncap.com>', 'joao@mendes.com', 'Mon, 01 Jun 2026 08:00:00 -0300', 'Old', 'out of window'),
      mail('m7', 'Carlos Drummond <carlos@horizoncap.com>', 'joao@mendes.com', 'Thu, 01 Oct 2026 08:00:00 -0300', 'Meu exame', 'resultado do exame'),
    ]);
    calendar = path.join(tmp, 'agenda.ics');
    fs.writeFileSync(
      calendar,
      ics([
        'BEGIN:VEVENT\r\nUID:m@g\r\nDTSTART;TZID=America/Sao_Paulo:20261008T150000\r\nDTEND;TZID=America/Sao_Paulo:20261008T160000\r\nSUMMARY:Board prep\r\nORGANIZER:mailto:joao@mendes.com\r\nATTENDEE;CN=Ana Lima:mailto:ana@board.com\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:t@g\r\nDTSTART;TZID=America/Sao_Paulo:20261009T150000\r\nDTEND;TZID=America/Sao_Paulo:20261009T160000\r\nSUMMARY:Terapia\r\nEND:VEVENT',
      ]),
    );
  });
  afterAll(() => t.drop());

  const exclusions = () => {
    const f = path.join(tmp, 'ex.json');
    fs.writeFileSync(f, JSON.stringify({ domains: ['banco-exemplo.com.br'], subjectContains: ['exame'], calendarTitleContains: ['terapia'] }));
    return loadExclusions(f);
  };
  const run = (dryRun = false) => importTakeout(db, { principalId, mboxPath: mbox, icsPaths: [calendar], since, until, aliases: ['joao.alt@gmail.com'], exclusions: exclusions(), dryRun });

  it('a dry run writes nothing', async () => {
    const r = await run(true);
    expect(r.mail.stored).toBe(2);
    expect(Number((await db.query('SELECT count(*) n FROM messages')).rows[0].n)).toBe(0);
    expect(Number((await db.query('SELECT count(*) n FROM people')).rows[0].n)).toBe(0);
  });

  it('applies exclusions before storage, keeps only real correspondents, creates people by rule, sends nothing', async () => {
    const r = await run();
    expect(r.mail).toMatchObject({ read: 7, outOfWindow: 1, excluded: { address: 0, domain: 1, subject: 1, label: 1 }, withoutCorrespondent: 1, stored: 2 });
    expect(r.calendar).toMatchObject({ stored: 1, excluded: 1 });
    expect(r.sentToClaude).toBe(0);
    const bodies = (await db.query('SELECT body FROM messages')).rows.map((x) => x.body).join(' ');
    for (const secret of ['saldo', 'exame', 'Unsubscribe', 'spam']) expect(bodies).not.toContain(secret);
    const people = (await db.query('SELECT full_name, source FROM people ORDER BY full_name')).rows;
    expect(people).toEqual([
      { full_name: 'Ana Lima', source: MAIL_PROVIDER },
      { full_name: 'Carlos Drummond', source: MAIL_PROVIDER },
    ]);
    expect(Number((await db.query('SELECT count(*) n FROM relationships')).rows[0].n)).toBe(0); // importance is never inferred
    expect(Number((await db.query('SELECT count(*) n FROM events')).rows[0].n)).toBe(0); // nothing for the worker to reason about
  });

  it('aliases count as the principal: the reply is outbound and feeds the derived metrics', async () => {
    const out = (await db.query(`SELECT direction, from_address FROM messages WHERE subject = 'Re: Pricing'`)).rows[0];
    expect(out).toEqual({ direction: 'OUTBOUND', from_address: 'joao@mendes.com' });
    const carlos = (await db.query(`SELECT person_id FROM person_identifiers WHERE value = 'carlos@horizoncap.com'`)).rows[0].person_id;
    const m = await relationshipMetrics(db, principalId, carlos, until);
    expect(m).toMatchObject({ messages90d: 2, inbound90d: 1, outbound90d: 1, principalReplyHoursMedian: 2 });
  });

  it('re-importing is idempotent and the import is audited without content', async () => {
    const r = await run();
    expect(r.mail).toMatchObject({ stored: 0, alreadyPresent: 2 });
    expect(r.people.created).toBe(0);
    expect(Number((await db.query('SELECT count(*) n FROM messages')).rows[0].n)).toBe(2);
    const audits = (await db.query(`SELECT payload FROM audit_blocks WHERE event_type = 'IMPORT_COMPLETED'`)).rows;
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits[0].payload)).not.toContain('pricing');
  });
});
