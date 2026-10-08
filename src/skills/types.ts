/**
 * A Skill is a reusable, structured capability: a typed manifest plus explicit steps. It is not a
 * prompt. Steps reach the world only through the StepContext the runtime hands them:
 *   - READ tools listed in requiredTools,
 *   - effects through actions (permission engine + approval), never directly,
 *   - child skills listed in dependencies (composition is controlled by the runtime),
 *   - the reasoner (every call recorded in model_calls).
 * Skills never touch the database themselves.
 */
import type { z } from 'zod';
import type { ReasoningRequest, ReasoningResult } from '../cognition/llm.js';
import type { ActionState } from '../domain/types.js';
import type { ActionCategory, RiskLevel } from '../permissions/policy.js';
import type { CapturedSource } from '../tools/sources.js';
import type { ToolName } from '../tools/specs.js';

export type TriggerDefinition =
  /** Example requests in the principal's words. Shown to the intent step; never matched literally. */
  | { kind: 'intent'; examples: string[] }
  /** Scheduled runs (S5; declared now so manifests do not change later). */
  | { kind: 'schedule'; cron: string };

export interface PermissionDefinition {
  tool: ToolName;
  category: ActionCategory;
}

export interface SkillManifest {
  id: string;
  /** pt-BR, shown to the principal. */
  name: string;
  /** English, for the intent step. */
  description: string;
  version: string;
  category?: string;
  triggers: TriggerDefinition[];
  requiredTools: ToolName[];
  /** Child skills this skill may start. */
  dependencies?: string[];
  /** May be started by another skill. */
  composable: boolean;
  /** May run without an explicit request (proactive / scheduled). Effects still follow the permission engine. */
  autonomous: boolean;
  riskLevel: RiskLevel;
  /** Short operating notes for the model steps of this skill (not a giant prompt). */
  instructions: string;
  metadata?: Record<string, unknown>;
}

export interface SkillDefinition<I = unknown, O = unknown> extends SkillManifest {
  inputs: z.ZodType<I>;
  outputs: z.ZodType<O>;
  steps: StepDefinition[];
}

export type StepResult = { kind: 'next' } | { kind: 'done'; output: unknown } | { kind: 'wait_action'; actionId: string } | { kind: 'wait_child'; childId: string };

export interface StepDefinition {
  id: string;
  /** pt-BR progress label. */
  label: string;
  /** Retries for retryable failures (network, timeouts, model unavailable). Default: 1 attempt. */
  retry?: { attempts: number; backoffMs: number };
  timeoutMs?: number;
  run(ctx: StepContext): Promise<StepResult>;
}

export type EffectOutcome =
  | { status: 'pending'; actionId: string }
  | { status: 'done'; actionId: string }
  | { status: 'refused'; actionId: string; state: Extract<ActionState, 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED'>; reason: string | null };

export interface ChildOutcome {
  status: 'queued' | 'running' | 'waiting_permission' | 'waiting_child' | 'completed' | 'failed' | 'cancelled';
  output: unknown;
  error: ExecutionError | null;
}

export interface StepContext {
  executionId: string;
  principalId: string;
  skillId: string;
  now: Date;
  input: unknown;
  /** Step-owned state, persisted after every step (survives restarts). */
  state: Record<string, unknown>;
  read(tool: ToolName, input: unknown): Promise<unknown>;
  /** Requests an effect. Idempotent per key: a re-run step gets the same action back. */
  effect(key: string, tool: ToolName, content: Record<string, unknown>): Promise<EffectOutcome>;
  /** Starts (or finds, by key) a child run of a declared dependency. */
  startChild(key: string, skillId: string, input: unknown): Promise<string>;
  child(childId: string): Promise<ChildOutcome>;
  /** Web pages / documents captured by tools, scoped to the principal (read-only). */
  sources(ids: string[]): Promise<CapturedSource[]>;
  /** The principal's language (for model output). */
  language(): Promise<string>;
  reason<T>(req: Omit<ReasoningRequest<T>, 'principalId'>): Promise<ReasoningResult<T>>;
}

export type ExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'NOT_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'REJECTED'
  | 'CHILD_FAILED'
  | 'TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'TOOL_FAILED'
  | 'NOTHING_FOUND'
  | 'INTERNAL';

export interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  step: string | null;
  retryable: boolean;
}

/** Thrown by steps (or the runtime) to fail with a structured reason. */
export class SkillError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}
