import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { MODELS, PROMPT_VERSION } from '../config.js';
import type { Db } from '../db/db.js';
import type { EvidenceRef } from '../domain/types.js';
import { newId } from '../util/hash.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReasoningRequest<T> {
  purpose: string;
  principalId: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  /** The evidence records whose content is included in `user` — persisted for auditability. */
  evidenceRefs: EvidenceRef[];
}

export interface ReasoningResult<T> {
  output: T;
  modelCallId: string;
  model: string;
}

/** The only path by which the Cognitive Core reaches a language model. */
export interface ReasoningClient {
  generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>>;
}

export class ReasoningUnavailableError extends Error {}

/** Records a model call; used by every ReasoningClient implementation. */
export async function recordModelCall(
  db: Db,
  row: {
    id: string;
    principalId: string;
    purpose: string;
    model: string;
    input: unknown;
    evidenceRefs: EvidenceRef[];
    startedAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO model_calls(id, principal_id, purpose, model, prompt_version, input, input_evidence_refs, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.id, row.principalId, row.purpose, row.model, PROMPT_VERSION, JSON.stringify(row.input), JSON.stringify(row.evidenceRefs), row.startedAt],
  );
}

export async function finishModelCall(
  db: Db,
  id: string,
  fields: { output?: unknown; stopReason?: string | null; usage?: unknown; error?: string; servedBy?: string; apiMessageId?: string },
): Promise<void> {
  await db.query(
    `UPDATE model_calls SET output = $2, stop_reason = $3, usage = $4, error = $5, served_by_model = $6, api_message_id = $7, finished_at = now()
     WHERE id = $1`,
    [
      id,
      fields.output === undefined ? null : JSON.stringify(fields.output),
      fields.stopReason ?? null,
      fields.usage === undefined ? null : JSON.stringify(fields.usage),
      fields.error ?? null,
      fields.servedBy ?? null,
      fields.apiMessageId ?? null,
    ],
  );
}

/**
 * Claude via the Anthropic SDK with structured outputs (schema-validated JSON).
 * Server-side refusal fallback is enabled ("default" routing); if the whole chain refuses,
 * or the output does not parse, the call fails — nothing is invented to fill the gap.
 */
export class ClaudeReasoningClient implements ReasoningClient {
  private readonly client: Anthropic;

  constructor(
    private readonly db: Db,
    opts: { client?: Anthropic; model?: string } = {},
    private readonly model: string = opts.model ?? MODELS.reasoning,
  ) {
    // Keys not scoped to a workspace must name one via this header (same env var name the SDK uses for profiles).
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    this.client = opts.client ?? new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
  }

  async generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    const id = newId();
    await recordModelCall(this.db, {
      id,
      principalId: req.principalId,
      purpose: req.purpose,
      model: this.model,
      input: { system: req.system, user: req.user, effort: req.effort },
      evidenceRefs: req.evidenceRefs,
      startedAt: new Date(),
    });

    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      });

      const meta = {
        stopReason: response.stop_reason,
        usage: response.usage,
        servedBy: response.model,
        apiMessageId: response.id,
      };

      if (response.stop_reason === 'refusal') {
        await finishModelCall(this.db, id, { ...meta, error: 'REFUSAL' });
        throw new ReasoningUnavailableError(`Model refused (${req.purpose})`);
      }
      if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
        await finishModelCall(this.db, id, { ...meta, error: 'UNPARSEABLE_OUTPUT' });
        throw new ReasoningUnavailableError(`No valid structured output (${req.purpose}, stop_reason=${response.stop_reason})`);
      }

      await finishModelCall(this.db, id, { ...meta, output: response.parsed_output });
      return { output: response.parsed_output as T, modelCallId: id, model: response.model };
    } catch (err) {
      if (!(err instanceof ReasoningUnavailableError)) {
        await finishModelCall(this.db, id, { error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  }
}
