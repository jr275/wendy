/**
 * Agent Evaluation Layer — the model. Concepts adapted from τ-bench (sierra-research/tau2-bench,
 * MIT; studied as a reference, nothing copied or depended on):
 *
 *   TASK + ENVIRONMENT + AGENT + TRAJECTORY + EVALUATOR
 *
 * - the AGENT is the real Wendy (agent turn → intent → SkillRuntime → tools → policy → actions);
 * - the ENVIRONMENT is the outside world only (businesses, phones, web pages), seen by Wendy only
 *   through her tools; it holds state the evaluators check at the end;
 * - the USER SIMULATOR plays the principal (requests, answers, approves or refuses on the cards);
 * - the TRAJECTORY is derived from what Wendy already records (events, actions, ledger, model calls);
 * - EVALUATORS score independent dimensions and attribute failures to explicit categories.
 *
 * Task fixtures are untrusted data: they configure the simulated world, never Wendy's rules.
 */
import { z } from 'zod';

// ── domains ──────────────────────────────────────────────────────────────────────────────
/** First domains. Extensible: any string names a domain; an environment kind must exist for it. */
export const EVAL_DOMAINS = ['voice', 'tools', 'policy'] as const;
export type EvalDomain = (typeof EVAL_DOMAINS)[number] | (string & {});

// ── failure taxonomy ────────────────────────────────────────────────────────────────────
export const FAILURE_CATEGORIES = [
  'TASK_NOT_COMPLETED',
  'WRONG_TOOL',
  'WRONG_TOOL_ARGUMENT',
  'UNAUTHORIZED_ACTION',
  'POLICY_VIOLATION',
  'SAFETY_VIOLATION',
  'MISSED_CONFIRMATION',
  'UNNECESSARY_CONFIRMATION',
  'WRONG_STATE_TRANSITION',
  'WRONG_FINAL_OUTCOME',
  'MISSED_INFORMATION',
  'HALLUCINATED_INFORMATION',
  'INFINITE_RETRY',
  'DUPLICATE_ACTION',
  'OTHER',
] as const;
/** Built-in categories, or a namespaced extension ("x-<name>"). */
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number] | `x-${string}`;

export interface Failure {
  category: FailureCategory;
  evaluator: EvaluatorId;
  message: string;
  /** Where in the trajectory (event seq, action id…), so a failure can be traced. */
  evidence?: Record<string, unknown>;
}

// ── user simulator script ───────────────────────────────────────────────────────────────
export const UserScriptSchema = z.object({
  /** What the simulated principal does on an approval card. change_mind = refuses, saying why. */
  onApproval: z.enum(['approve', 'reject', 'change_mind']).default('approve'),
  /** Said when rejecting / changing their mind (also stored as the rejection reason). */
  rejectionText: z.string().optional(),
  /** Answers to Wendy's questions: the first rule whose pattern matches Wendy's text is said. */
  answers: z.array(z.object({ whenAsked: z.string(), say: z.string() })).default([]),
  /** Stops after this many messages from the principal. */
  maxTurns: z.number().int().min(1).max(10).default(3),
});
export type UserScript = z.infer<typeof UserScriptSchema>;

// ── voice world (environment state) ─────────────────────────────────────────────────────
const Money = z.object({ amount: z.number(), currency: z.string() });
export const BusinessSchema = z.object({
  name: z.string(),
  /** E.164 — what the world answers on; Wendy has to find it (or be told). */
  phone: z.string(),
  pages: z.array(z.object({ url: z.string().url(), title: z.string(), text: z.string() })).default([]),
  line: z.enum(['answers', 'no_answer', 'busy', 'voicemail']).default('answers'),
  acceptsReservations: z.boolean().default(true),
  /** "HH:MM" → free. Times not listed are not offered. */
  availability: z.record(z.string(), z.boolean()).default({}),
  /** Asked for after availability, before confirming. */
  extraFee: Money.nullable().default(null),
  deposit: Money.nullable().default(null),
  /**
   * How the person on the line behaves: normal, or asking for a piece of information (a category of
   * the disclosure registry) with their own words — at the start of the call or when confirming.
   */
  staff: z.union([z.literal('normal'), z.object({ when: z.enum(['start', 'confirming']), says: z.string(), asksFor: z.string() })]).default('normal'),
});
export type Business = z.infer<typeof BusinessSchema>;

export const VoiceWorldSchema = z.object({
  kind: z.literal('voice'),
  businesses: z.array(BusinessSchema).min(1),
  /** Extra pages on the web (blogs, listings…) — untrusted, may carry other numbers or injections. */
  extraPages: z.array(z.object({ url: z.string().url(), title: z.string(), text: z.string() })).default([]),
});
export type VoiceWorld = z.infer<typeof VoiceWorldSchema>;

/** Environment specs by kind (discriminated). New domains add a kind here and a factory in environment.ts. */
export const EnvironmentSpecSchema = z.discriminatedUnion('kind', [VoiceWorldSchema]);
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;

// ── evaluation task ─────────────────────────────────────────────────────────────────────
export const EVALUATOR_IDS = ['task_success', 'policy_compliance', 'authorization', 'tool_correctness', 'safety', 'outcome_correctness'] as const;
export type EvaluatorId = (typeof EVALUATOR_IDS)[number];

const Reservation = z.object({ business: z.string(), time: z.string(), party_size: z.number().optional() });

export const ExpectedSchema = z.object({
  /** What Wendy's run should end as. */
  runStatus: z.enum(['called', 'needs_information', 'phone_unresolved', 'not_called']),
  /** Classified call outcome (VoiceTaskResult.outcome), when a call is expected. */
  outcome: z.string().optional(),
  /** required = Wendy must ask before acting; pre_authorized = the principal already said so (asking again is unnecessary); none = no effect to approve. */
  approval: z.enum(['required', 'pre_authorized', 'none']),
  /** Calls that should reach the provider (0 = never dial). */
  providerCalls: z.number().int().min(0),
  /** The world afterwards. */
  finalState: z.object({ reservations: z.array(Reservation) }),
  requiredTools: z.array(z.string()).default([]),
  forbiddenTools: z.array(z.string()).default([]),
  /** [a, b]: a must happen before b. */
  toolOrder: z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Arguments the call must carry. */
  callArguments: z.object({ phone: z.string().optional(), parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).default({}),
  /** Things that must reach the principal (e.g. an offered time). */
  mustSurface: z.array(z.string()).default([]),
  /** Never said by Wendy (on the call or in chat). */
  mustNotSay: z.array(z.string()).default([]),
  /** Runs Wendy should start in the task (default 1); every one is checked to have finished. */
  runs: z.number().int().min(1).optional(),
});
export type Expected = z.infer<typeof ExpectedSchema>;

export const EvaluationTaskSchema = z.object({
  id: z.string().regex(/^[A-Z]+\d{3,}$/),
  domain: z.string(),
  description: z.string(),
  initialUserMessage: z.string().min(1),
  /** The world's clock at the start of the task. */
  now: z.string().datetime({ offset: true }),
  principal: z.object({ name: z.string(), locale: z.string().default('pt-BR') }),
  environment: EnvironmentSpecSchema,
  user: UserScriptSchema.default({ onApproval: 'approve', answers: [], maxTurns: 3 }),
  /** Tools the agent may use for this task; anything else is WRONG_TOOL. */
  availableTools: z.array(z.string()),
  /** Wendy's policy knobs for this task (code rules stay code; only configured limits change). */
  policy: z
    .object({
      voiceLimits: z.object({ maxCallDurationSeconds: z.number(), maxCallsPerTask: z.number(), maxCallsPerUserPerDay: z.number() }).partial().optional(),
      voiceCosts: z.object({ currency: z.string(), perMinute: z.number(), maxPerCall: z.number(), maxPerDay: z.number(), maxPerMonth: z.number() }).partial().optional(),
    })
    .default({}),
  /** The principal's standing settings before the task starts (set through the real PolicyService). */
  setup: z.object({ approvalPolicies: z.array(z.object({ actionType: z.string(), mode: z.enum(['REQUIRE_APPROVAL', 'DENY']) })).default([]) }).default({ approvalPolicies: [] }),
  /**
   * Deterministic mode only: what the model double answers, by purpose ("intent",
   * "skill:voice-concierge:mandate"). Ignored with a real model. Labeled TEST_DOUBLE in model_calls.
   */
  modelDouble: z.record(z.string(), z.unknown()).default({}),
  expected: ExpectedSchema,
  evaluationCriteria: z.array(z.enum(EVALUATOR_IDS)).default([...EVALUATOR_IDS]),
  constraints: z.object({ maxToolCalls: z.number().int().optional(), maxModelCalls: z.number().int().optional() }).default({}),
  metadata: z
    .object({ tags: z.array(z.string()).default([]), origin: z.enum(['authored', 'regression']).default('authored'), source: z.string().optional() })
    .default({ tags: [], origin: 'authored' }),
});
export type EvaluationTask = z.infer<typeof EvaluationTaskSchema>;
export type EvaluationTaskInput = z.input<typeof EvaluationTaskSchema>;

// ── results ─────────────────────────────────────────────────────────────────────────────
export type Verdict = 'PASS' | 'PARTIAL' | 'FAIL';

export interface DimensionResult {
  evaluator: EvaluatorId;
  verdict: Verdict;
  /** 0..1 — kept per dimension; never collapsed without keeping these. */
  score: number;
  checks: { name: string; ok: boolean; detail?: string }[];
  failures: Failure[];
}

export interface ModelConfig {
  mode: 'deterministic' | 'model';
  /** Model label as recorded in model_calls (TEST_DOUBLE for the double). */
  model: string;
  provider: string;
  config?: Record<string, unknown>;
}

export interface TrialResult {
  taskId: string;
  trialId: string;
  trial: number;
  /** The run(s) of Wendy this trial produced (skill executions). */
  runIds: string[];
  trajectoryId: string;
  seed: number;
  model: ModelConfig;
  status: 'passed' | 'failed' | 'error';
  scores: Partial<Record<EvaluatorId, number>>;
  dimensions: DimensionResult[];
  failures: Failure[];
  /** External effects outside the simulated environment (must be 0). */
  sideEffects: { blockedNetworkAttempts: number };
  error?: string;
  durationMs: number;
}
