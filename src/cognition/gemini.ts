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

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';

/** Thinking depth mapped from Wendy's effort levels. */
const THINKING_LEVEL: Record<ReasoningRequest<unknown>['effort'], 'LOW' | 'MEDIUM' | 'HIGH'> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' };

export class GeminiReasoningClient implements ReasoningClient {
  private readonly ai: Pick<GoogleGenAI, 'models'>;

  constructor(
    private readonly db: Db,
    private readonly model: string = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    ai?: Pick<GoogleGenAI, 'models'>,
  ) {
    if (ai) this.ai = ai;
    else {
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error('WENDY_REASONER=gemini requires GOOGLE_CLOUD_PROJECT');
      this.ai = new GoogleGenAI({ vertexai: true, project, location: process.env.GEMINI_LOCATION ?? 'global' });
    }
  }

  async generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    const id = newId();
    await recordModelCall(this.db, {
      id,
      principalId: req.principalId,
      purpose: req.purpose,
      model: this.model,
      input: { system: req.system, user: req.user, effort: req.effort, provider: 'vertex-gemini' },
      evidenceRefs: req.evidenceRefs,
      startedAt: new Date(),
    });

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(req.schema),
          maxOutputTokens: 32000,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.effort] as never },
        },
      });
      const finish = response.candidates?.[0]?.finishReason ?? null;
      const meta = { stopReason: finish, usage: response.usageMetadata, servedBy: response.modelVersion ?? this.model, apiMessageId: response.responseId };

      let parsed: z.ZodSafeParseResult<T> | null = null;
      try {
        parsed = req.schema.safeParse(JSON.parse(response.text ?? 'null'));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        await finishModelCall(this.db, id, { ...meta, error: `UNPARSEABLE_OUTPUT${parsed ? `: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` : ''}` });
        throw new ReasoningUnavailableError(`No valid structured output from ${this.model} (${req.purpose}, finish=${finish})`);
      }
      await finishModelCall(this.db, id, { ...meta, output: parsed.data });
      return { output: parsed.data, modelCallId: id, model: this.model };
    } catch (err) {
      if (!(err instanceof ReasoningUnavailableError)) await finishModelCall(this.db, id, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}
