import "server-only";

/**
 * Server-side access to Wendy's read API (the existing inspector server, read-only at the DB level).
 * Nothing here computes or invents data: it fetches what Wendy persisted.
 */
const API = process.env.WENDY_API_URL ?? "http://127.0.0.1:3457";
const SCHEMA = process.env.WENDY_SCHEMA ?? "public";
const PRINCIPAL_EMAIL = process.env.WENDY_PRINCIPAL_EMAIL ?? "";

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams({ schema: SCHEMA, ...params });
  const res = await fetch(`${API}${path}?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Wendy API ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface Principal {
  id: string;
  display_name: string;
  primary_email: string;
  timezone: string;
}

export async function principal(): Promise<Principal | null> {
  const all = await get<Principal[]>("/api/principals");
  return all.find((p) => p.primary_email === PRINCIPAL_EMAIL) ?? all[0] ?? null;
}

export interface Claim {
  kind: string;
  label: string;
  statement: string;
  confidence: number;
}
export interface InsightCard {
  id: string;
  status: "SURFACED" | "SUPPRESSED" | "REJECTED_BY_VALIDATION";
  headline: string | null;
  narrative: string | null;
  created_at: string;
  score: number;
  event_type: string;
  test_double: boolean;
  other_model: string | null;
  claims: Claim[] | null;
  explanation: string[] | null;
}
export interface NeedsYou {
  id: string;
  action_type: string;
  insight_id: string;
  expires_at: string | null;
  subject: string | null;
  recipients: string[] | null;
}
export interface Today {
  principal: Principal | null;
  kpis?: { surfaced_24h: number; awaiting: number; commitments_48h: number; events_24h: number; insights_total: number; auto_actioned: number };
  insights?: InsightCard[];
  prepared?: { id: string; action_type: string; state: string; insight_id: string; title: string | null; subject: string | null }[];
  needsYou?: NeedsYou[];
  pendingMemories?: { id: string; content: string; full_name: string | null; subject_person_id: string | null }[];
  pendingMemoryCount?: number;
  pendingCommitments?: { id: string; description: string; due_at: string; full_name: string }[];
  memoriesToReview?: { id: string; content: string; full_name: string | null }[];
  openConflicts?: number;
}

export async function today(principalId: string) {
  return get<Today>("/api/today", { principal: principalId });
}

export interface SiteWindow {
  start: string;
  end: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
export interface SiteChange {
  event_id: string;
  insight_id: string | null;
  status: string | null;
  headline: string | null;
  score: number | null;
  change: { kind: string; dimension: string; key: string; changePct: number | null; positionDelta: number | null; baselineWeekly: { clicks: number }; current: { clicks: number } };
}
export interface Site {
  id: string;
  label: string;
  site_url: string;
  explicit_importance: number | null;
  last_synced_at: string | null;
  daily: { date: string; clicks: number; impressions: number }[];
  current: SiteWindow | null;
  baseline: SiteWindow | null;
  changes: SiteChange[];
  direction: "DROP" | "RISE" | null;
  movers: { dimension: "page" | "query"; key: string; deltaClicks: number; deltaImpressions: number }[];
  topPages?: { key: string; clicks: number }[];
}

export async function sites(principalId: string) {
  return (await get<{ sites: Site[] }>("/api/sites", { principal: principalId })).sites;
}

/** Which model reasoned (honesty label shown everywhere). */
export function reasonerLabel(insights: InsightCard[]): string | null {
  const other = insights.find((i) => i.other_model)?.other_model;
  return other ?? null;
}

export interface DetailClaim {
  ordinal: number;
  label: string;
  kind: "FACT" | "INFERENCE" | "HYPOTHESIS" | "ANTICIPATION" | "RECOMMENDATION";
  statement: string;
  confidence: number;
  evidence: { kind: string; id: string; handle: string }[];
  derived_from: number[];
  produced_by: "CODE" | "CLAUDE";
  validation_status: string;
}
export interface DetailAction {
  id: string;
  action_type: "SEND_EMAIL" | "PREPARE_BRIEFING";
  state: string;
  expires_at: string | null;
  rejection_reason: string | null;
  policy_decision: { mode: string; rule: string } | null;
  content: { to?: string[]; subject?: string; body?: string; title?: string; sections?: { heading: string; points: { text: string }[] }[] };
  author: string;
  execution: { provider: string; status: string; verification: { contentMatches?: boolean; deliversExternally?: boolean } | null } | null;
}
export interface InsightDetail {
  insight: {
    id: string;
    status: string;
    headline: string | null;
    narrative: string | null;
    created_at: string;
    salience: { score: number; threshold: number; factors: { name: string; value: number | null; weight: number; contribution: number; basis: string }[] };
  };
  event: { event_type: string; occurred_at: string };
  claims: DetailClaim[];
  actions: DetailAction[];
  calls: { model: string; served_by_model: string | null }[];
  labels: Record<string, string>;
}

export async function insight(id: string) {
  return get<InsightDetail>("/api/insight", { id });
}

/** One skill run as Wendy reports it (src/skills/view.ts). */
export interface ExecutionView {
  id: string;
  skillId: string;
  skillName: string;
  version: string;
  status: "queued" | "running" | "waiting_permission" | "waiting_child" | "completed" | "failed" | "cancelled";
  error: { code: string; message: string; step: string | null; retryable: boolean } | null;
  output: unknown;
  createdAt: string;
  completedAt: string | null;
  steps: { id: string; label: string; status: "done" | "running" | "waiting" | "pending" | "failed" }[];
  approvals: { actionId: string; tool: string; label: string; category: string; state: string; content: Record<string, unknown>; items: string[] }[];
  models: string[];
  children: ExecutionView[];
  /** voice-concierge runs only: the call as Wendy derives it from her events (src/skills/voiceView.ts). */
  voice?: VoiceView;
}

export interface Money {
  amount: number;
  currency: string;
}
export interface PhoneSource {
  kind: "principal" | "web_page";
  ref?: string;
  title?: string;
  sourceType?: "official_site" | "business_listing" | "other";
  confidence?: "high" | "medium" | "low";
}
export interface CallStatus {
  state: string;
  terminal: boolean;
  simulated: boolean;
  transcript: { speaker: "agent" | "counterparty"; text: string; at: string }[];
  signals: { kind: string; [k: string]: unknown }[];
  actionsRequired: { action: string; detail: string; decision: string }[];
  ended: { by: string; reason: string } | null;
  failed: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  cost: (Money & { estimated: true; billedMinutes: number }) | null;
}
/** Mirror of src/skills/voiceView.ts (types only — the state lives in Wendy's events). */
export interface VoiceView {
  mandate: { objective: string; targetName: string; phone: string; phoneSource: PhoneSource; parameters: Record<string, string | number>; acceptable: { time?: { from: string; to: string } } | null } | null;
  phone: "not_needed" | "searching" | "resolved" | "failed" | null;
  action: { id: string; state: string } | null;
  call: CallStatus | null;
  estimate: { maxCallSeconds: number; worstCase: Money; simulated: boolean };
  blocked: {
    kind: string;
    usage: { callsInTask: number; callsToday: number; spentToday: number; spentMonth: number } | null;
    worstCase: Money | null;
    limits: { currency: string; maxPerCall: number; maxPerDay: number; maxPerMonth: number; callsPerDay: number };
  } | null;
  confirmationReasons: string[];
  approvedBy: "principal" | "principal_message" | null;
}

export async function execution(id: string, principalId: string): Promise<ExecutionView | null> {
  try {
    return await get<ExecutionView>("/api/execution", { id, principal: principalId });
  } catch {
    return null;
  }
}

/** The principal's latest runs (newest first): the concierge desk's active / recent tasks. */
export async function executions(principalId: string): Promise<ExecutionView[]> {
  try {
    return (await get<{ executions: ExecutionView[] }>("/api/executions", { principal: principalId })).executions;
  } catch {
    return [];
  }
}

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  created_by: "PRINCIPAL" | "WENDY";
  created_at: string;
}

export async function tasks(principalId: string): Promise<Task[]> {
  return (await get<{ tasks: Task[] }>("/api/tasks", { principal: principalId })).tasks;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}

export async function chatHistory(principalId: string): Promise<ChatMessage[]> {
  return (await get<{ messages: ChatMessage[] }>("/api/chat", { principal: principalId })).messages;
}

export interface MemoryItem {
  id: string;
  kind: "PREFERENCE" | "FACT";
  content: string;
  status: "PROPOSED" | "ACTIVE";
  written_by: "PRINCIPAL" | "WENDY" | "SYSTEM";
  created_at: string;
  last_confirmed_at: string | null;
  subject_person_id: string | null;
  full_name: string | null;
  evidence_kinds: string[] | null;
  freshness: { weight: number; needsReview: boolean; ageDays: number };
}

export async function memories(principalId: string): Promise<MemoryItem[]> {
  return (await get<{ memories: MemoryItem[] }>("/api/memories", { principal: principalId })).memories;
}
