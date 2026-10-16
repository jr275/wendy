/**
 * Gemini as the reasoner — MVP-only, by the principal's explicit decision (2026-10-07), while Claude is
 * unavailable (no Anthropic credit; Vertex Opus quota denied). It is NOT Claude:
 *   - every model call is recorded with the Gemini model name, so the UI labels it "não é o Claude";
 *   - the Phase 1 gate refuses to run with it (the gate requires real Claude);
 *   - prompts and schemas are the same; the output must pass the same zod schema and the same
 *     validator, so a Gemini mistake becomes a rejected claim, never an invented fact.
 *
 * Reached through Vertex AI with Application Default Credentials (gcloud login), billed to
 * GOOGLE_CLOUD_PROJECT. Model from GEMINI_MODEL (default gemini-3.1-pro-preview).
 */
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import { finishModelCall, recordModelCall, ReasoningUnavailableError, type ReasoningClient, type ReasoningRequest, type ReasoningResult } from './llm.js';
import { DEFAULT_RETRY_POLICY, recordedError, withRetry, withTimeout, type RetryDeps, type RetryPolicy } from './resilience.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';

/**
 * Small, structured calls that sit in front of every chat answer (which skill? who and what is the question about?). Each one waits for the previous one,
 * so their fixed latency adds up. When GEMINI_FAST_MODEL is set, only these use it; the answer and every reasoning call keep the main model.
 * Unset (the default) = nothing changes.
 */
export const FAST_PURPOSES: ReadonlySet<string> = new Set(['intent', 'understand-question']);

/** Thinking depth mapped from Wendy's effort levels. */
const THINKING_LEVEL: Record<ReasoningRequest<unknown>['effort'], 'LOW' | 'MEDIUM' | 'HIGH'> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' };

export class GeminiReasoningClient implements ReasoningClient {
  private readonly ai: Pick<GoogleGenAI, 'models'>;
  private readonly policy: RetryPolicy;
  private readonly deps: RetryDeps;

  constructor(
    private readonly db: Db,
    private readonly model: string = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    ai?: Pick<GoogleGenAI, 'models'>,
    retry: { policy?: Partial<RetryPolicy>; deps?: RetryDeps } = {},
    private readonly fastModel: string | undefined = process.env.GEMINI_FAST_MODEL?.trim() || undefined,
  ) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...retry.policy };
    this.deps = retry.deps ?? {};
    if (ai) this.ai = ai;
    else {
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error('WENDY_REASONER=gemini requires GOOGLE_CLOUD_PROJECT');
      this.ai = new GoogleGenAI({ vertexai: true, project, location: process.env.GEMINI_LOCATION ?? 'global' });
    }
  }

  /** One logical call: transient failures are retried (see resilience.ts); each attempt is its own model_calls row. */
  generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    return withRetry((attempt) => this.once(req, attempt), this.policy, this.deps);
  }

  /** The model for one call: the fast one for the small front-of-chat calls when configured, otherwise the main one. */
  modelFor(purpose: string): string {
    return this.fastModel && FAST_PURPOSES.has(purpose) ? this.fastModel : this.model;
  }

  private async once<T>(req: ReasoningRequest<T>, attempt: number): Promise<ReasoningResult<T>> {
    const id = newId();
    const model = this.modelFor(req.purpose);
    await recordModelCall(this.db, {
      id,
      principalId: req.principalId,
      purpose: req.purpose,
      model: model,
      input: { system: req.system, user: req.user, effort: req.effort, provider: 'vertex-gemini', attempt },
      evidenceRefs: req.evidenceRefs,
      startedAt: new Date(),
    });

    try {
      const response = await withTimeout(this.ai.models.generateContent({
        model: model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(req.schema),
          maxOutputTokens: 32000,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.effort] as never },
        },
      }), this.policy.timeoutMs);
      const finish = response.candidates?.[0]?.finishReason ?? null;
      const meta = { stopReason: finish, usage: response.usageMetadata, servedBy: response.modelVersion ?? model, apiMessageId: response.responseId };

      let parsed: z.ZodSafeParseResult<T> | null = null;
      try {
        parsed = req.schema.safeParse(JSON.parse(response.text ?? 'null'));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        await finishModelCall(this.db, id, { ...meta, error: `UNPARSEABLE_OUTPUT${parsed ? `: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` : ''}` });
        throw new ReasoningUnavailableError(`No valid structured output from ${model} (${req.purpose}, finish=${finish})`, 'invalid_output');
      }
      await finishModelCall(this.db, id, { ...meta, output: parsed.data });
      return { output: parsed.data, modelCallId: id, model: model };
    } catch (err) {
      if (!(err instanceof ReasoningUnavailableError)) await finishModelCall(this.db, id, { error: recordedError(err) });
      throw err;
    }
  }
}
