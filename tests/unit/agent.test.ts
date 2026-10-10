/** Wendy's AG-UI agent run: protocol shape, validated content only, website card from stored data. */
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWendyAgent } from '../../src/agent/run.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import { Toolbox } from '../../src/tools/index.js';
import { addWebProperty } from '../../src/sensors/searchConsole.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { emptyUnderstanding, handlesIn, ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
let propertyId: string;
let foreignPropertyId: string;
const now = new Date('2026-10-08T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
  const prop = await addWebProperty(db, principalId, { siteUrl: 'https://www.aeriva.test/', label: 'Aeriva', source: 'TEST' });
  propertyId = prop;
  const other = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
  foreignPropertyId = await addWebProperty(db, other, { siteUrl: 'https://www.other.test/', label: 'Outro', source: 'TEST' });
  const put = (start: string, end: string, clicks: number, impressions: number) =>
    db.query(
      `INSERT INTO search_metric_windows(id, principal_id, property_id, window_start, window_end, dimension, key, clicks, impressions, ctr, position, row_limit, fetched_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'total', '', $5, $6, 0.01, 11, 5000, now())`,
      [principalId, prop, start, end, clicks, impressions],
    );
  await put('2026-09-01', '2026-09-28', 811, 154061);
  await put('2026-09-29', '2026-10-05', 142, 17589);
});
afterAll(() => t.drop());

const input = (q: string, state: Record<string, unknown> = {}): RunAgentInput => ({ threadId: 't', runId: 'r', state, messages: [{ id: 'm', role: 'user', content: q }], tools: [], context: [], forwardedProps: {} }) as RunAgentInput;

async function collect(reasoner: ScriptedReasoner, q: string, state: Record<string, unknown> = {}, withSkills = false) {
  const events: (BaseEvent & Record<string, unknown>)[] = [];
  const ctx = createContext({ db, reasoner, clock: fixedClock(now), emailProvider: new DevMailboxProvider(db) });
  const skills = withSkills ? createSkillRuntime(ctx, { toolbox: new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent' }) }) : undefined;
  await runWendyAgent({ ctx, db, principalId, skills }, input(q, state), (e) => events.push(e as BaseEvent & Record<string, unknown>));
  const tools: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'TOOL_CALL_START') names[e.toolCallId as string] = e.toolCallName as string;
    if (e.type === 'TOOL_CALL_ARGS') tools[names[e.toolCallId as string]!] = JSON.parse(e.delta as string);
  }
  const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta as string).join('');
  return { types: events.map((e) => e.type as string), tools, text };
}

describe('Wendy AG-UI agent run', () => {
  it('a question about a website resolves the site by its stored name, cites its records, and emits the site card', async () => {
    const reasoner = new ScriptedReasoner(db, {
      'understand-question': () => emptyUnderstanding({ topics: [{ label: 'Aeriva', search_terms: ['Aeriva', 'cliques'] }] }),
      answer: (req) => {
        const sc = handlesIn(req.user, 'SC');
        return {
          answer: 'Os cliques caíram [C1]. Talvez sazonalidade [C2].',
          claims: [
            { id: 'C1', kind: 'INFERENCE', statement: 'Clicks fell week over week.', confidence: 0.9, evidence: sc, derived_from: [], about_people: [] },
            { id: 'C2', kind: 'HYPOTHESIS', statement: 'Seasonality.', confidence: 0.3, evidence: [], derived_from: ['C1'], about_people: [] },
            { id: 'C3', kind: 'INFERENCE', statement: 'invented', confidence: 0.9, evidence: ['SC99'], derived_from: [], about_people: [] },
          ],
          used_evidence: sc,
          conflicts: [],
          information_gaps: ['Why impressions fell.'],
        };
      },
    });
    const { types, tools, text } = await collect(reasoner, 'Por que os cliques da Aeriva caíram?');
    // the answer is read first, without the validator's markers; proof and data cards follow
    expect(types.indexOf('TEXT_MESSAGE_START')).toBeLessThan(types.indexOf('TOOL_CALL_START'));
    expect(text).toBe('Os cliques caíram. Talvez sazonalidade.');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(types).toContain('STEP_STARTED');
    const answer = tools.show_answer as { claims: { statement: string }[]; rejectedClaims: number; evidence: { kind: string; text: string }[]; notClaude: boolean; gaps: string[] };
    expect(answer.claims.map((c) => c.statement)).not.toContain('invented'); // only validated claims reach the UI
    expect(answer.rejectedClaims).toBeGreaterThanOrEqual(1);
    expect(answer.evidence.every((e) => e.kind === 'search_metric')).toBe(true);
    expect(answer.evidence.some((e) => /clicks 811, impressions 154061/.test(e.text))).toBe(true);
    expect(answer.notClaude).toBe(true); // the test double is not Claude, and the UI is told so
    const site = tools.show_site as { label: string; baselineWeekly: { clicks: number }; current: { clicks: number }; direction: string };
    expect(site).toMatchObject({ label: 'Aeriva', baselineWeekly: { clicks: 202.8 }, current: { clicks: 142 }, direction: 'DROP' });
  });

  it('shared state: "isso" on a site screen retrieves that site; the screen line is context, not evidence', async () => {
    let answerUser = '';
    const reasoner = new ScriptedReasoner(db, {
      'understand-question': () => emptyUnderstanding(), // the question names nothing
      answer: (req) => {
        answerUser = req.user;
        const sc = handlesIn(req.user, 'SC');
        return {
          answer: 'Caiu [C1].',
          claims: [{ id: 'C1', kind: 'INFERENCE', statement: 'Os cliques caíram.', confidence: 0.9, evidence: sc, derived_from: [], about_people: [] }],
          used_evidence: sc,
          conflicts: [],
          information_gaps: [],
        };
      },
    });
    const { tools } = await collect(reasoner, 'Por que isso caiu?', { viewing: { kind: 'site', id: propertyId } });
    expect(answerUser).toMatch(/On screen: the website "Aeriva"/);
    expect(handlesIn(answerUser, 'SC').length).toBeGreaterThan(0);
    expect((tools.show_site as { label: string }).label).toBe('Aeriva');
    const q = (await db.query(`SELECT payload FROM events WHERE event_type = 'PRINCIPAL_QUESTION' AND payload->>'text' = 'Por que isso caiu?'`)).rows[0];
    expect(q.payload.on_screen).toMatch(/Aeriva/);
  });

  it("shared state: another principal's site id, or junk, is ignored", async () => {
    for (const state of [{ viewing: { kind: 'site', id: foreignPropertyId } }, { viewing: { kind: 'site', id: 'not-a-uuid' } }, { viewing: 'x' }]) {
      let answerUser = '';
      const reasoner = new ScriptedReasoner(db, {
        'understand-question': () => emptyUnderstanding(),
        answer: (req) => {
          answerUser = req.user;
          return { answer: 'Não sei.', claims: [], used_evidence: [], conflicts: [], information_gaps: ['Sem dados.'] };
        },
      });
      await collect(reasoner, 'Por que isso caiu?', state);
      expect(answerUser).not.toMatch(/On screen/);
      expect(answerUser).not.toMatch(/Outro/);
      expect(handlesIn(answerUser, 'SC')).toEqual([]);
    }
  });

  it('a request to DO something runs a skill: the card shows the pending approval and nothing changes before it', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'task-management', input_json: JSON.stringify({ operation: 'create', tasks: [{ title: 'Revisar a proposta' }] }), reason: 'asks to create a task' }),
    });
    const { types, tools, text } = await collect(reasoner, 'Crie uma tarefa para revisar a proposta', {}, true);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    const card = tools.show_execution as { skillId: string; status: string; approvals: { label: string; state: string; content: { tasks: { title: string }[] } }[] };
    expect(card).toMatchObject({ skillId: 'task-management', status: 'waiting_permission' });
    expect(card.approvals[0]).toMatchObject({ label: 'Criar tarefas', state: 'AWAITING_APPROVAL', content: { tasks: [{ title: 'Revisar a proposta' }] } });
    expect(text).toMatch(/aprovação/);
    expect((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n).toBe(0);
    expect(reasoner.calls.map((c) => c.purpose)).toEqual(['intent']); // no answer flow, no extra model calls
  });

  it('a question about the principal\'s world falls through to the evidence-backed answer', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'none', input_json: '{}', reason: 'question about own records' }),
      'understand-question': () => emptyUnderstanding(),
      answer: () => ({ answer: 'Não sei.', claims: [], used_evidence: [], conflicts: [], information_gaps: ['Sem dados.'] }),
    });
    const { tools } = await collect(reasoner, 'Quem me escreveu ontem?', {}, true);
    expect(tools.show_answer).toBeDefined();
    expect(tools.show_execution).toBeUndefined();
  });

  const feeling = { category: 'concerned', confidence: 0.9, evidence_source: 'explicit_user_statement', evidence_quote: 'estou ansioso', response_tone: 'calm' };

  it('a message that only states a feeling gets a short supportive reply, with no answer flow and no card', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'none', input_json: '{}', reason: 'only a feeling', mood: feeling, emotional_only: true }),
      support: () => ({ reply: 'Sinto muito que isso esteja pesando. Quer conversar sobre o que mais te preocupa?' }),
    });
    const { types, tools, text } = await collect(reasoner, 'estou ansioso com essa viagem', {}, true);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(text).toMatch(/pesando/);
    expect(tools.show_answer).toBeUndefined();
    expect(reasoner.calls.map((c) => c.purpose)).toEqual(['intent', 'support']);
  });

  it('a supportive reply that states facts or numbers is rejected and the evidence-backed path answers instead', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'none', input_json: '{}', reason: 'only a feeling', mood: feeling, emotional_only: true }),
      support: () => ({ reply: 'Sua viagem é dia 12, já confirmei o voo.' }),
      'understand-question': () => emptyUnderstanding(),
      answer: () => ({ answer: 'Não sei.', claims: [], used_evidence: [], conflicts: [], information_gaps: ['Sem dados.'] }),
    });
    const { tools } = await collect(reasoner, 'estou ansioso com essa viagem', {}, true);
    expect(tools.show_answer).toBeDefined();
  });

  it('emotional_only without a validated mood, or alongside a question, never takes the support path', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'none', input_json: '{}', reason: 'x', mood: null, emotional_only: true }),
      'understand-question': () => emptyUnderstanding(),
      answer: () => ({ answer: 'Não sei.', claims: [], used_evidence: [], conflicts: [], information_gaps: ['Sem dados.'] }),
    });
    await collect(reasoner, 'estou ansioso com essa viagem', {}, true);
    expect(reasoner.calls.map((c) => c.purpose)).not.toContain('support');
  });

  it('a bare emotion word gets a clarifying question instead of an answer from records', async () => {
    const reasoner = new ScriptedReasoner(db, {
      intent: () => ({ skill: 'none', input_json: '{}', reason: 'bare word', mood: null, feeling_unclear: true }),
      clarify: () => ({ reply: 'Você está sentindo isso agora ou quer conversar sobre o tema?' }),
    });
    const { text, tools } = await collect(reasoner, 'ansiedade', {}, true);
    expect(text).toMatch(/\?/);
    expect(tools.show_answer).toBeUndefined();
    expect(reasoner.calls.map((c) => c.purpose)).toEqual(['intent', 'clarify']);
  });

  it('an empty question ends with RUN_ERROR and calls no model', async () => {
    const reasoner = new ScriptedReasoner(db, {});
    const { types } = await collect(reasoner, '   ');
    expect(types).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(reasoner.calls).toHaveLength(0);
  });
});

describe('run errors: what the principal sees and what the log keeps', () => {
  it('explains an expired Google login in pt-BR and never repeats provider details', async () => {
    const { friendlyRunError, loggableError } = await import('../../src/agent/errors.js');
    const gaxios = Object.assign(new Error('{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}'), { name: 'GaxiosError' });
    expect(friendlyRunError(gaxios)).toBe('A autenticação do Google (usada pelo Gemini) expirou. No terminal, rode `gcloud auth application-default login` e tente de novo.');
    expect(friendlyRunError(new Error('429 RESOURCE_EXHAUSTED'))).toMatch(/limite de uso/);
    expect(friendlyRunError(new Error('fetch failed'))).toMatch(/rede/);
    expect(friendlyRunError(new Error('boom {"secret":"x"}'))).toBe('A Wendy não conseguiu responder por um erro interno. O detalhe está no log do agente.');
  });
  it('the log line carries name and message only, with credentials masked', async () => {
    const { loggableError } = await import('../../src/agent/errors.js');
    const e = Object.assign(new Error('refresh_token=1//0hbaVjks8wj2-CgYIARAAGBESNgF-L9Ir8Ik4VbfNAjEScUyW3ODgZQ41n9eZmS6r1WJPBvB5MXBKHLvZ40 client_secret: abc123 failed'), { name: 'GaxiosError' });
    const line = loggableError(e);
    expect(line).toMatch(/^GaxiosError: refresh_token=<redacted>/);
    expect(line).not.toMatch(/0hbaVjks8wj2|abc123/);
  });
});
