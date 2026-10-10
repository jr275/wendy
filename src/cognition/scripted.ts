/**
 * TEST DOUBLE — NOT A MODEL. Returns outputs scripted per purpose, for deterministic runs of the
 * code around reasoning (tests, engineering evaluations). Its calls are recorded in model_calls under
 * the model label 'TEST_DOUBLE', so they can never be mistaken for real reasoning.
 */
import type { Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import { finishModelCall, recordModelCall, type ReasoningClient, type ReasoningRequest, type ReasoningResult } from './llm.js';

export type Script = (req: ReasoningRequest<unknown>) => unknown;

export const TEST_DOUBLE_MODEL = 'TEST_DOUBLE';

export class ScriptedReasoner implements ReasoningClient {
  calls: { purpose: string; user: string }[] = [];
  constructor(
    private readonly db: Db,
    private readonly scripts: Record<string, Script>,
  ) {}

  async generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    this.calls.push({ purpose: req.purpose, user: req.user });
    const id = newId();
    await recordModelCall(this.db, { id, principalId: req.principalId, purpose: req.purpose, model: TEST_DOUBLE_MODEL, input: { user: req.user }, evidenceRefs: req.evidenceRefs, startedAt: new Date() });
    const script = this.scripts[req.purpose];
    if (!script) throw new Error(`no script for purpose ${req.purpose}`);
    const output = req.schema.parse(script(req as ReasoningRequest<unknown>));
    await finishModelCall(this.db, id, { output, servedBy: TEST_DOUBLE_MODEL });
    return { output, modelCallId: id, model: TEST_DOUBLE_MODEL };
  }
}
