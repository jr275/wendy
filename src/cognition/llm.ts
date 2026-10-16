import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { MODELS, PROMPT_VERSION } from '../config.js';
import type { Db } from '../db/db.js';
import { maskCardDeep } from '../security/cardRedaction.js';
import type { EvidenceRef } from '../domain/types.js';
import { newId } from '../util/hash.js';
import { DEFAULT_RETRY_POLICY, ReasoningUnavailableError, recordedError, withRetry, withTimeout, type RetryDeps, type RetryPolicy } from './resilience.js';

export { ReasoningUnavailableError };

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
    [row.id, row.principalId, row.purpose, row.model, PROMPT_VERSION, JSON.stringify(maskCardDeep(row.input)), JSON.stringify(row.evidenceRefs), row.startedAt],
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
      fields.output === undefined ? null : JSON.stringify(maskCardDeep(fields.output)),
      fields.stopReason ?? null,
      fields.usage === undefined ? null : JSON.stringify(fields.usage),
      fields.error ?? null,
      fields.servedBy ?? null,
      fields.apiMessageId ?? null,
    ],
  );
}

/**
 * Where Claude is reached. Same model, same request; only authentication and billing differ.
 *   CLAUDE_PROVIDER=anthropic (default)  Claude API, ANTHROPIC_API_KEY (+ optional ANTHROPIC_WORKSPACE_ID)
 *   CLAUDE_PROVIDER=vertex               Claude on Google Cloud Vertex AI, billed to the GCP project;
 *                                        auth via Application Default Credentials (gcloud),
 *                                        GOOGLE_CLOUD_PROJECT (required), CLOUD_ML_REGION (default "global")
 */
export type ClaudeProvider = 'anthropic' | 'vertex';
type ClaudeClient = Pick<Anthropic, 'beta' | 'messages'>;

export function claudeProvider(): ClaudeProvider {
  const p = (process.env.CLAUDE_PROVIDER ?? 'anthropic').toLowerCase();
  if (p !== 'anthropic' && p !== 'vertex') throw new Error(`CLAUDE_PROVIDER must be "anthropic" or "vertex" (got "${p}")`);
  return p;
}

/** Whether credentials for the configured provider are present (not whether they work). */
export function hasClaudeCredentials(): boolean {
  return claudeProvider() === 'vertex' ? !!process.env.GOOGLE_CLOUD_PROJECT : !!process.env.ANTHROPIC_API_KEY;
}

export function createClaudeClient(provider: ClaudeProvider = claudeProvider()): ClaudeClient {
  if (provider === 'vertex') {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new Error('CLAUDE_PROVIDER=vertex requires GOOGLE_CLOUD_PROJECT');
    return new AnthropicVertex({ projectId, region: process.env.CLOUD_ML_REGION ?? 'global' }) as unknown as ClaudeClient;
  }
  // Keys not scoped to a workspace must name one via this header (same env var name the SDK uses for profiles).
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
}

/**
 * Claude with structured outputs (schema-validated JSON).
 * On the Claude API, server-side refusal fallback is enabled ("default" routing). Vertex AI has no
 * server-side fallback: a refusal there is recorded and the call fails. In every case, if the model
 * refuses or the output does not parse, nothing is invented to fill the gap.
 */
export class ClaudeReasoningClient implements ReasoningClient {
  private readonly client: ClaudeClient;
  private readonly provider: ClaudeProvider;
  private readonly policy: RetryPolicy;
  private readonly deps: RetryDeps;

  constructor(
    private readonly db: Db,
    opts: { client?: Anthropic; model?: string; provider?: ClaudeProvider; retry?: Partial<RetryPolicy>; retryDeps?: RetryDeps } = {},
    private readonly model: string = opts.model ?? MODELS.reasoning,
  ) {
    this.provider = opts.provider ?? claudeProvider();
    this.client = opts.client ?? createClaudeClient(this.provider);
    this.policy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.deps = opts.retryDeps ?? {};
  }

  /** One logical call: transient failures are retried (see resilience.ts); each attempt is its own model_calls row. */
  generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    return withRetry((attempt) => this.once(req, attempt), this.policy, this.deps);
  }

  private async once<T>(req: ReasoningRequest<T>, attempt: number): Promise<ReasoningResult<T>> {
    const id = newId();
    await recordModelCall(this.db, {
      id,
      principalId: req.principalId,
      purpose: req.purpose,
      model: this.model,
      input: { system: req.system, user: req.user, effort: req.effort, provider: this.provider, attempt },
      evidenceRefs: req.evidenceRefs,
      startedAt: new Date(),
    });

    try {
      const response = await withTimeout(this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        ...(this.provider === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      }), this.policy.timeoutMs);

      const meta = {
        stopReason: response.stop_reason,
        usage: response.usage,
        servedBy: response.model,
        apiMessageId: response.id,
      };

      if (response.stop_reason === 'refusal') {
        await finishModelCall(this.db, id, { ...meta, error: 'REFUSAL' });
        throw new ReasoningUnavailableError(`Model refused (${req.purpose})`, 'refusal');
      }
      if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
        await finishModelCall(this.db, id, { ...meta, error: 'UNPARSEABLE_OUTPUT' });
        throw new ReasoningUnavailableError(`No valid structured output (${req.purpose}, stop_reason=${response.stop_reason})`, 'invalid_output');
      }

      await finishModelCall(this.db, id, { ...meta, output: response.parsed_output });
      return { output: response.parsed_output as T, modelCallId: id, model: response.model };
    } catch (err) {
      if (!(err instanceof ReasoningUnavailableError)) {
        await finishModelCall(this.db, id, { error: recordedError(err) });
      }
      throw err;
    }
  }
}
