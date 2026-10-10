/**
 * One AG-UI run of Wendy's agent (transport-free, so it can be tested without HTTP).
 *
 * Takes the last user message. If it asks Wendy to DO something a skill covers (intent step: the
 * model picks from the registry, code validates), the skill runs and the turn emits `show_execution`
 * (its progress, approvals and result). Otherwise it answers through Wendy's own question flow
 * (evidence registry → reasoning → validator), and emits:
 *   - STEP_STARTED/FINISHED: 'raciocinando' (understanding, evidence, reasoning, validation) and 'montando' (cards)
 *   - tool call `show_answer`: validated answer, valid claims with their sources, conflicts, gaps, and
 *     which model reasoned (flagged when it is not Claude)
 *   - tool call `show_site` for each website whose Search Console records were cited (built by code)
 * Reads `state.viewing` (what the principal has on screen) as context for "isso"/"este site".
 * The answer text comes first (claim markers removed), so a chat reads answer → proof → data.
 */
import crypto from 'node:crypto';
import { contentToText, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { answerQuestion } from '../cognition/ask.js';
import type { Db } from '../db/db.js';
import type { WendyContext } from '../runtime/context.js';
import { discoverIntent } from '../skills/discovery.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillRuntime } from '../skills/runtime.js';
import { executionView } from '../skills/view.js';
import type { Toolbox } from '../tools/index.js';
import { supportReply } from './support.js';
import { siteCard } from './siteCard.js';
import { loggableError } from './errors.js';
import { summarizeRun } from './skillSummary.js';
import { resolveViewing } from './viewing.js';

/** How long a chat turn waits for a skill run before leaving it to continue in the background. */
export const SKILL_TURN_BUDGET_MS = 90_000;

export interface AgentSkills {
  runtime: SkillRuntime;
  registry: SkillRegistry;
  toolbox: Toolbox;
}

export type Send = (e: BaseEvent) => void;

function lastUserMessage(input: RunAgentInput): { id: string | null; text: string } {
  const m = [...input.messages].reverse().find((x) => x.role === 'user');
  if (!m) return { id: null, text: '' };
  return { id: m.id ?? null, text: typeof m.content === 'string' ? m.content : contentToText(m.content as never) };
}

/** Claim/evidence markers like [C1] or [SC2] are for the validator; the chat shows them as cards instead. */
const withoutMarkers = (s: string) => s.replace(/\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\]/g, '').trim();

function emitText(send: Send, text: string) {
  const messageId = crypto.randomUUID();
  send({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as BaseEvent);
  send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent);
  send({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
}

function emitTool(send: Send, name: string, args: unknown) {
  const toolCallId = crypto.randomUUID();
  send({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name } as BaseEvent);
  send({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) } as BaseEvent);
  send({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
  send({ type: EventType.TOOL_CALL_RESULT, messageId: crypto.randomUUID(), toolCallId, content: 'rendered' } as BaseEvent);
}

export async function runWendyAgent(deps: { ctx: WendyContext; db: Db; principalId: string; skills?: AgentSkills }, input: RunAgentInput, send: Send): Promise<void> {
  const { ctx, db, principalId } = deps;
  const { threadId, runId } = input;
  send({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
  const last = lastUserMessage(input);
  const question = last.text.trim();
  if (!question) {
    send({ type: EventType.RUN_ERROR, message: 'Pergunta vazia.' } as BaseEvent);
    return;
  }

  // Shared state: the UI says what is on screen; code resolves it (scoped to the principal) or ignores it.
  const viewing = await resolveViewing(db, principalId, (input.state as { viewing?: unknown } | undefined)?.viewing);

  // Something to DO (a skill) or something to ANSWER from records? The model picks from the registry;
  // code validates. Questions about the principal's world keep the evidence-backed answer path below.
  if (deps.skills) {
    send({ type: EventType.STEP_STARTED, stepName: 'entendendo' } as BaseEvent);
    const intent = await discoverIntent({ db, registry: deps.skills.registry, toolbox: deps.skills.toolbox, reasoner: ctx.reasoner }, { principalId, request: question, screen: viewing?.description ?? null, now: ctx.clock.now() });
    send({ type: EventType.STEP_FINISHED, stepName: 'entendendo' } as BaseEvent);
    // The apparent mood of this request (validated by code) goes to the interface as transient agent
    // state: it is not written to any table and nothing here depends on it.
    if (intent.mood) send({ type: EventType.STATE_SNAPSHOT, snapshot: { ...((input.state as Record<string, unknown> | undefined) ?? {}), mood: intent.mood } } as BaseEvent);
    if (intent.kind === 'skill') {
      await runSkillTurn(deps.skills, db, principalId, question, last.id, intent.skillId, intent.input, send);
      send({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
      return;
    }
    // Only a feeling, nothing to look up or do: a short, fact-free reply (falls back to the answer path if it does not pass).
    if (intent.emotionalOnly || intent.feelingUnclear) {
      const support = await supportReply(ctx.reasoner, principalId, question, intent.emotionalOnly ? 'support' : 'clarify');
      if (support) {
        emitText(send, support.text);
        send({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
        return;
      }
    }
  }

  send({ type: EventType.STEP_STARTED, stepName: 'raciocinando' } as BaseEvent);
  const ans = await answerQuestion(ctx, principalId, question, viewing);
  send({ type: EventType.STEP_FINISHED, stepName: 'raciocinando' } as BaseEvent);

  send({ type: EventType.STEP_STARTED, stepName: 'montando' } as BaseEvent);
  const text = withoutMarkers(ans.answer);
  emitText(
    send,
    !text
      ? 'Não encontrei evidência suficiente para responder com segurança.'
      : ans.answerValid
        ? text
        : `${text}\n\n_Este texto não passou inteiro na validação — confie só nas afirmações comprovadas abaixo._`,
  );
  const models = (await db.query<{ model: string }>('SELECT DISTINCT model FROM model_calls WHERE id = ANY($1::uuid[])', [ans.modelCallIds])).rows.map((r) => r.model);
  const valid = ans.claims.filter((c) => c.valid && c.producedBy !== 'CODE');
  emitTool(send, 'show_answer', {
    question,
    answer: ans.answer,
    answerValid: ans.answerValid,
    models,
    notClaude: models.some((m) => !m.startsWith('claude-')),
    claims: valid.map((c) => ({ label: c.label, kind: c.kind, statement: c.statement, confidence: c.confidence, evidence: c.evidence.map((e) => e.handle) })),
    rejectedClaims: ans.claims.filter((c) => !c.valid && c.producedBy !== 'CODE').length,
    evidence: ans.citedEvidence,
    conflicts: ans.conflicts,
    gaps: ans.gaps,
    eventId: ans.eventId,
  });

  const metricIds = ans.citedEvidence.filter((e) => e.kind === 'search_metric').map((e) => e.id);
  const propertyIds = metricIds.length
    ? (await db.query<{ property_id: string }>(`SELECT DISTINCT property_id FROM search_metric_windows WHERE principal_id = $1 AND id = ANY($2::uuid[])`, [principalId, metricIds])).rows.map((r) => r.property_id)
    : [];
  for (const id of propertyIds) {
    const s = await siteCard(db, principalId, id);
    if (s) emitTool(send, 'show_site', s);
  }
  send({ type: EventType.STEP_FINISHED, stepName: 'montando' } as BaseEvent);
  send({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
}

/** Starts a skill run, drives it for up to SKILL_TURN_BUDGET_MS, then reports its state as a card. */
async function runSkillTurn(skills: AgentSkills, db: Db, principalId: string, question: string, messageId: string | null, skillId: string, input: unknown, send: Send): Promise<void> {
  send({ type: EventType.STEP_STARTED, stepName: 'executando' } as BaseEvent);
  // The message id lets a skill cite the principal's own words (e.g. "pode ligar") as authorization; the runtime checks it.
  const id = await skills.runtime.start(principalId, skillId, input, { kind: 'chat', question, ...(messageId ? { messageId } : {}) });
  const driving = skills.runtime.advance(id).catch((e) => console.error('[skill run error]', id, loggableError(e)));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([driving, new Promise((r) => (timer = setTimeout(r, SKILL_TURN_BUDGET_MS)))]);
  clearTimeout(timer);
  send({ type: EventType.STEP_FINISHED, stepName: 'executando' } as BaseEvent);
  const view = await executionView(db, skills.registry, principalId, id);
  if (!view) throw new Error(`skill run ${id} not found`);
  emitText(send, summarizeRun(view));
  emitTool(send, 'show_execution', view);
}
