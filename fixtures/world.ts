/**
 * DEV FIXTURES (outside src/ on purpose). Builds a small executive world from parameters so the
 * same structure can be instantiated with completely different people, topics and meetings.
 * Every record is labeled source = 'DEV_FIXTURE'.
 */
import { withTx, type Db } from '../src/db/db.js';
import { createCommitment, createOrganization, createPerson, createPrincipal, storeMessage, upsertMeeting } from '../src/events/world.js';
import { DAY_MS, HOUR_MS } from '../src/util/clock.js';

export interface ScenarioParams {
  key: string;
  principal: { name: string; email: string; timezone: string; locale: string };
  counterpart: { name: string; email: string; title: string; org: string; domain: string; importance: number; relationshipKind: string };
  bystander: { name: string; email: string };
  topic: {
    subject: string; // e.g. "Pricing"
    history: [string, string, string]; // three prior messages: inbound, outbound (promise), inbound
    commitment: string; // what the principal promised
    unrelated: string; // a noise thread with the bystander
  };
  meeting: { title: string; hoursFromNow: number; durationHours: number };
  commitmentDueHoursFromNow: number;
  urgentEmail: { subject: string; body: (meetingWeekday: string) => string };
  language: 'en' | 'pt';
}

export const SCENARIO_A: ScenarioParams = {
  key: 'a',
  principal: { name: 'João Mendes', email: 'joao@mendes-partners.com', timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
  counterpart: { name: 'Carlos Drummond', email: 'carlos@horizoncap.com', title: 'General Partner', org: 'Horizon Capital', domain: 'horizoncap.com', importance: 0.9, relationshipKind: 'INVESTOR' },
  bystander: { name: 'Beatriz Lemos', email: 'beatriz@mendes-partners.com' },
  topic: {
    subject: 'Pricing',
    history: [
      'Sharing our view on pricing for the 2027 renewal: we would like a tiered structure with a volume discount above 500 seats. Can you look at it before we meet again?',
      'Thanks Carlos. I will send you a revised pricing schedule before our next meeting.',
      'Quick update: our board reviewed the pricing proposal and wants a cap on the volume discount. This will need a decision soon.',
    ],
    commitment: 'Send Carlos the revised pricing schedule',
    unrelated: 'The office move is confirmed for November; movers arrive on the 14th.',
  },
  meeting: { title: 'Horizon partnership review', hoursFromNow: 26, durationHours: 1 },
  commitmentDueHoursFromNow: 22,
  urgentEmail: {
    subject: 'Pricing before tomorrow',
    body: () => 'João, we need to resolve pricing before tomorrow\'s meeting. The board will not move forward without an answer on the discount cap.',
  },
  language: 'en',
};

/** Same structure, nothing shared with A: different person, company, topic, meeting, timing and language. */
export const SCENARIO_B: ScenarioParams = {
  key: 'b',
  principal: { name: 'Helena Costa', email: 'helena@costa-ventures.com', timezone: 'Europe/Lisbon', locale: 'pt-BR' },
  counterpart: { name: 'Ingrid Solberg', email: 'ingrid.solberg@nordvik.no', title: 'Chief Operating Officer', org: 'Nordvik Logistics', domain: 'nordvik.no', importance: 0.85, relationshipKind: 'CLIENT' },
  bystander: { name: 'Tomás Ribeiro', email: 'tomas@costa-ventures.com' },
  topic: {
    subject: 'Residência de dados',
    history: [
      'Helena, nossa equipe jurídica levantou a questão da residência de dados para a expansão nórdica: os dados de clientes precisam ficar em servidores na Noruega?',
      'Ingrid, vou te enviar até a revisão trimestral um parecer sobre residência de dados com as opções de hospedagem.',
      'Recebemos uma nota do regulador sobre residência de dados. Vamos precisar de uma posição clara para seguir com a expansão.',
    ],
    commitment: 'Enviar à Ingrid o parecer sobre residência de dados com as opções de hospedagem',
    unrelated: 'O almoço de equipe foi remarcado para sexta-feira.',
  },
  meeting: { title: 'Revisão trimestral de operações', hoursFromNow: 50, durationHours: 2 },
  commitmentDueHoursFromNow: 40,
  urgentEmail: {
    subject: 'Residência de dados — antes da revisão',
    body: (weekday) => `Helena, precisamos fechar a questão da residência de dados antes da revisão de ${weekday}. Sem isso o comitê não aprova a expansão.`,
  },
  language: 'pt',
};

export interface BuiltWorld {
  principalId: string;
  counterpartId: string;
  bystanderId: string;
  meetingId: string;
  otherMeetingId: string;
  commitmentId: string;
  historyMessageIds: string[];
  unrelatedMessageId: string;
  meetingStartsAt: Date;
  params: ScenarioParams;
}

const PROVIDER = 'DEV_FIXTURE_MAIL';

export function weekdayName(at: Date, timeZone: string, language: 'en' | 'pt'): string {
  return new Intl.DateTimeFormat(language === 'pt' ? 'pt-BR' : 'en-US', { weekday: 'long', timeZone }).format(at);
}

export async function buildWorld(db: Db, s: ScenarioParams, now: Date, opts: { counterpartBirthdate?: string | null } = {}): Promise<BuiltWorld> {
  return withTx(db, async (tx) => {
    const principalId = await createPrincipal(tx, { displayName: s.principal.name, primaryEmail: s.principal.email, timezone: s.principal.timezone, locale: s.principal.locale });
    const orgId = await createOrganization(tx, principalId, { name: s.counterpart.org, domain: s.counterpart.domain, source: 'DEV_FIXTURE' });
    const counterpartId = await createPerson(tx, principalId, {
      fullName: s.counterpart.name,
      emails: [s.counterpart.email],
      title: s.counterpart.title,
      organizationId: orgId,
      birthdate: opts.counterpartBirthdate ?? null,
      source: 'DEV_FIXTURE',
      relationship: { kind: s.counterpart.relationshipKind, explicitImportance: s.counterpart.importance },
    });
    const bystanderId = await createPerson(tx, principalId, { fullName: s.bystander.name, emails: [s.bystander.email], source: 'DEV_FIXTURE', relationship: { kind: 'COLLEAGUE' } });

    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS);
    const msg = async (key: string, from: string, to: string, subject: string, body: string, sentAt: Date) =>
      (await storeMessage(tx, principalId, { provider: PROVIDER, externalId: `${s.key}-${key}`, from, to: [to], subject, body, sentAt })).messageId;

    const h1 = await msg('h1', s.counterpart.email, s.principal.email, s.topic.subject, s.topic.history[0], at(20));
    const h2 = await msg('h2', s.principal.email, s.counterpart.email, `Re: ${s.topic.subject}`, s.topic.history[1], at(12));
    const h3 = await msg('h3', s.counterpart.email, s.principal.email, `${s.topic.subject} — update`, s.topic.history[2], at(5));
    const unrelated = await msg('u1', s.bystander.email, s.principal.email, 'Office logistics', s.topic.unrelated, at(3));

    const meetingStartsAt = new Date(now.getTime() + s.meeting.hoursFromNow * HOUR_MS);
    const meetingId = await upsertMeeting(tx, principalId, {
      provider: 'DEV_FIXTURE_CALENDAR',
      externalId: `${s.key}-meeting`,
      title: s.meeting.title,
      startsAt: meetingStartsAt,
      endsAt: new Date(meetingStartsAt.getTime() + s.meeting.durationHours * HOUR_MS),
      status: 'CONFIRMED',
      attendees: [s.principal.email, s.counterpart.email],
    });
    const otherMeetingId = await upsertMeeting(tx, principalId, {
      provider: 'DEV_FIXTURE_CALENDAR',
      externalId: `${s.key}-meeting-other`,
      title: 'Team sync',
      startsAt: new Date(now.getTime() + 4 * DAY_MS),
      endsAt: new Date(now.getTime() + 4 * DAY_MS + HOUR_MS),
      status: 'CONFIRMED',
      attendees: [s.principal.email, s.bystander.email],
    });
    const commitmentId = await createCommitment(tx, principalId, {
      owner: 'PRINCIPAL',
      counterpartyPersonId: counterpartId,
      description: s.topic.commitment,
      dueAt: new Date(now.getTime() + s.commitmentDueHoursFromNow * HOUR_MS),
      createdAt: at(12),
      sourceMessageId: h2,
      source: 'DEV_FIXTURE',
    });
    return { principalId, counterpartId, bystanderId, meetingId, otherMeetingId, commitmentId, historyMessageIds: [h1, h2, h3], unrelatedMessageId: unrelated, meetingStartsAt, params: s };
  });
}

export function urgentEmail(world: BuiltWorld, now: Date) {
  const s = world.params;
  return {
    provider: PROVIDER,
    externalId: `${s.key}-urgent`,
    from: s.counterpart.email,
    to: [s.principal.email],
    subject: s.urgentEmail.subject,
    body: s.urgentEmail.body(weekdayName(world.meetingStartsAt, s.principal.timezone, s.language)),
    sentAt: new Date(now.getTime() - 10 * 60_000),
  };
}

/** Strings that must never appear in src/ (anti-hardcoding scan). */
export function scenarioTokens(): string[] {
  const out: string[] = [];
  for (const s of [SCENARIO_A, SCENARIO_B]) {
    out.push(...s.counterpart.name.split(' '), s.counterpart.email, s.counterpart.org, s.counterpart.domain, s.bystander.name.split(' ')[0]!, s.meeting.title);
    out.push(...s.topic.subject.split(/\s+/).filter((w) => w.length > 3));
  }
  out.push('Mariana', 'Vance', 'Clause', 'rebate');
  return [...new Set(out)];
}
