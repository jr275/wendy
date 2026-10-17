import "server-only";
import { apiHeaders, resolvePrincipalState, type PrincipalState } from "./apiState";
import { connection } from "next/server";
import { actionUnavailableReason, parseAgentSetting, unavailableReason } from "./agentConfig";

/**
 * Server-side access to Wendy's read API (the existing inspector server, read-only at the DB level).
 * Nothing here computes or invents data: it fetches what Wendy persisted.
 */
const API = process.env.WENDY_API_URL ?? "http://127.0.0.1:3457";
const SCHEMA = process.env.WENDY_SCHEMA ?? "public";
const PRINCIPAL_EMAIL = process.env.WENDY_PRINCIPAL_EMAIL ?? "";

/**
 * Demonstration mode (WENDY_DEMO=1), for showing the interface where Wendy's API does not exist
 * (a preview host such as v0). Nothing is fetched and nothing is invented: it answers with an
 * obviously fictional principal and EMPTY lists, and the top bar says so. Off unless the variable is "1".
 */
export const DEMO = process.env.WENDY_DEMO === "1";
const AGENT_SETTING = parseAgentSetting(process.env.WENDY_AGENT);
if (AGENT_SETTING === "invalid") console.warn('WENDY_AGENT has a value that is not "off" or "on"; it is ignored (agent availability stays unknown).');
/** The only places the web KNOWS the agent will not process a message: demo mode, or WENDY_AGENT=off. Anything else is "not known" (undefined), never "available". Server-only (this module); the sentence travels to the client as a prop. */
export const UNAVAILABLE_REASON: string | undefined = unavailableReason({ demo: DEMO, setting: AGENT_SETTING });
/** Same idea for actions that write through the agent (lib/actions.ts enforces it on the server; the UI shows it). */
export const ACTION_UNAVAILABLE_REASON: string | undefined = actionUnavailableReason({ setting: AGENT_SETTING });
const DEMO_PRINCIPAL = { id: "demo", display_name: "Visitante", primary_email: "demo@example.invalid", timezone: "America/Sao_Paulo" };
function demo(path: string): unknown {
  switch (path) {
    case "/api/principals":
      return [DEMO_PRINCIPAL];
    case "/api/today":
      return { principal: DEMO_PRINCIPAL, insights: [], needsYou: [], pendingMemoryCount: 0, pendingCommitments: [], memoriesToReview: [], openConflicts: 0 };
    case "/api/sites":
      return { sites: [] };
    case "/api/executions":
      return { executions: [] };
    case "/api/tasks":
      return { tasks: [] };
    case "/api/chat":
      return { messages: [] };
    case "/api/history":
      return { questions: [] };
    case "/api/memories":
      return { memories: [] };
    case "/api/market":
      return { market: null };
    case "/api/market/overview":
      return { market: null };
    case "/api/market/asset":
      return { asset: null };
    case "/api/digest":
      return { digest: null };
    case "/api/briefing/preview":
      return { briefing: null };
    case "/api/agenda":
      return { agenda: null };
    case "/api/agenda/plan":
      return { plan: null };
    case "/api/review":
      return { review: { generatedAt: new Date().toISOString(), windowDays: 7, overdue: [], upcoming: [], undated: [], waitingOnYou: [], load: [], closedLastWeek: { tasks: 0, commitments: 0 }, next: null, empty: true } };
    default:
      throw new Error(`Modo demonstração: ${path} não tem dados.`);
  }
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  // Every read is per request (the pages show the current time and live data). This MUST come before the fetch and outside any try/catch of the
  // callers: the framework signals "this page is dynamic" with an exception, and a caller that swallows it would render the page as if it were static.
  await connection();
  if (DEMO) return demo(path) as T;
  const q = new URLSearchParams({ schema: SCHEMA, ...params });
  const res = await fetch(`${API}${path}?${q}`, { cache: "no-store", headers: apiHeaders(process.env.WENDY_API_TOKEN) });
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

/** Like principal(), but "the API did not answer" is its own state, so a page can say so instead of crashing or claiming nobody is registered. */
export function principalState(): Promise<PrincipalState<Principal>> {
  return resolvePrincipalState(principal);
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
  /** Evidence the validated claims cite, and the actions Wendy attached (both straight from her records). */
  cited?: { handle: string; kind: string; id: string }[] | null;
  actions?: { id: string; type: string; state: string }[] | null;
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

/** One of the principal's recent questions (a message of the restored conversation), newest first. */
export interface PastQuestion {
  id: string;
  text: string;
  at: string;
  /** The task this message started, when it started one (the server links them; null for older runs and plain questions). */
  runId?: string | null;
}
export async function recentQuestions(principalId: string): Promise<PastQuestion[]> {
  try {
    return (await get<{ questions: PastQuestion[] }>("/api/history", { principal: principalId })).questions;
  } catch {
    return []; // resuming is a convenience: never take the home down with it
  }
}

/** The weekly review as the inspector serves it (src/review/weekly.ts): dates travel as ISO strings. */
export interface ReviewItemView {
  kind: "task" | "commitment" | "meeting" | "approval";
  id: string;
  title: string;
  at: string | null;
}
export interface ReviewView {
  generatedAt: string;
  windowDays: number;
  overdue: ReviewItemView[];
  upcoming: ReviewItemView[];
  undated: ReviewItemView[];
  waitingOnYou: ReviewItemView[];
  load: { day: string; count: number; busy: boolean }[];
  closedLastWeek: { tasks: number; commitments: number };
  next: { item: ReviewItemView; rule: string } | null;
  empty: boolean;
}
/** null when the review cannot be read (never invented): the page says so. */
export async function weeklyReviewFor(principalId: string): Promise<ReviewView | null> {
  try {
    return (await get<{ review: ReviewView | null }>("/api/review", { principal: principalId })).review;
  } catch {
    return null;
  }
}

export interface DigestItemView {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summary: string | null;
  why: string | null;
  read: boolean;
  addedAt: string;
}
export interface DigestView {
  routine: { enabled: boolean; localTime: string; timezone: string; pausedUntil: string | null } | null;
  lastRun: { date: string; status: string; error: string | null } | null;
  items: DigestItemView[];
}
/** null when the digest cannot be read (never invented): the card says so. */
export async function digestFor(principalId: string): Promise<DigestView | null> {
  try {
    return (await get<{ digest: DigestView | null }>("/api/digest", { principal: principalId })).digest;
  } catch {
    return null;
  }
}

export interface MarketAlertView {
  id: string;
  symbol: string;
  kind: "MOVE_OUTLIER" | "VOLUME_SPIKE" | "RANGE_EXPANSION";
  observedAt: string;
  explanation: string;
  seen: boolean;
}
export interface MarketView {
  routine: DigestView["routine"];
  lastRun: DigestView["lastRun"];
  alerts: MarketAlertView[];
  symbolsWithAlerts: number;
}
/** null when the market monitor cannot be read (never invented): the card says so. */
export async function marketFor(principalId: string): Promise<MarketView | null> {
  try {
    return (await get<{ market: MarketView | null }>("/api/market", { principal: principalId })).market;
  } catch {
    return null;
  }
}

export interface MarketQuote {
  symbol: string;
  market: "B3" | "US";
  lastClose: number;
  prevClose: number | null;
  changePct: number | null;
  asOf: string;
  spark?: number[];
}
export interface MarketWatchRow {
  symbol: string;
  market: "B3" | "US";
  source: "liquidity" | "config" | "user";
  role: "asset" | "reference";
  active: boolean;
  excluded: boolean;
  lastClose: number | null;
  changePct: number | null;
  asOf: string | null;
}
export interface MarketAlertRow {
  id: string;
  symbol: string;
  kind: "MOVE_OUTLIER" | "VOLUME_SPIKE" | "RANGE_EXPANSION";
  day: string;
  value: number;
  threshold: number;
  explanation: string;
}
export interface MarketOverview {
  note: string;
  routine: { enabled: boolean; localTime: string; timezone: string } | null;
  lastRun: { date: string; status: string } | null;
  references: MarketQuote[];
  gainers: MarketQuote[];
  losers: MarketQuote[];
  alerts: MarketAlertRow[];
  watchlist: MarketWatchRow[];
  counts: { watchedAssets: number; excluded: number };
  budget: { perSweep: number; perMonthEstimate: number; monthlyQuota: number; maxAssets: number };
  asOf: string | null;
}
export interface MarketCandle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface MarketAsset {
  note: string;
  symbol: string;
  market: "B3" | "US";
  role: "asset" | "reference";
  source: string;
  active: boolean;
  candles: MarketCandle[];
  alerts: MarketAlertRow[];
  stats: { lastClose: number; changePct: number | null; high: number; low: number; days: number; asOf: string } | null;
}
/** null when the market data cannot be read (never invented): the page says so. */
export async function marketOverviewFor(principalId: string): Promise<MarketOverview | null> {
  try {
    return (await get<{ market: MarketOverview | null }>("/api/market/overview", { principal: principalId })).market;
  } catch {
    return null;
  }
}
export async function marketAssetFor(principalId: string, symbol: string): Promise<MarketAsset | null> {
  try {
    return (await get<{ asset: MarketAsset | null }>("/api/market/asset", { principal: principalId, symbol })).asset;
  } catch {
    return null;
  }
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

export interface BriefingItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string | null;
  relevance: string;
  origin: "lab" | "press";
}
export interface BriefingSection {
  id: string;
  title: string;
  scope: string;
  items: BriefingItem[];
  empty: string | null;
  unavailable: string | null;
}
export interface BriefingPreview {
  kind: "PREVIEW";
  title: string;
  generatedAt: string;
  period: { from: string; to: string; days: number };
  highlights: BriefingItem[];
  sections: BriefingSection[];
  attention: { label: string; lines: string[] };
  sources: { name: string; url: string; status: "lida" | "indisponível"; items: number }[];
  notes: string[];
}
/** null when the preview cannot be built (never invented): the page says so. */
export async function briefingPreviewFor(days: number): Promise<BriefingPreview | null> {
  try {
    return (await get<{ briefing: BriefingPreview | null }>("/api/briefing/preview", { days: String(days) })).briefing;
  } catch {
    return null;
  }
}

export interface AgendaDay {
  day: string;
  workingDay: boolean;
  meetings: { id: string; title: string; start: string; end: string }[];
  meetingMinutes: number;
  conflicts: { a: { id: string; title: string }; b: { id: string; title: string }; overlapMinutes: number }[];
  noBreak: { meetingIds: string[]; count: number; totalMinutes: number }[];
  overloaded: { minutes: number; limit: number } | null;
  focus: { start: string; end: string; minutes: number }[];
}
export interface AgendaView {
  generatedAt: string;
  timeZone: string;
  days: AgendaDay[];
  reminders: { meetingId: string; title: string; label: string; at: string }[];
  departure: string;
  rules: string[];
  summary: { conflicts: number; overloadedDays: number; noBreakRuns: number; focusBlocks: number; meetings: number };
}
/** null when the agenda cannot be read (never invented): the page says so. */
export async function agendaFor(principalId: string, days: number): Promise<AgendaView | null> {
  try {
    return (await get<{ agenda: AgendaView | null }>("/api/agenda", { principal: principalId, days: String(days) })).agenda;
  } catch {
    return null;
  }
}

export interface EveningPlanView {
  generatedAt: string;
  timeZone: string;
  inWindow: boolean;
  day: string;
  meetings: { id: string; title: string; start: string; end: string }[];
  conflicts: { a: { id: string; title: string }; b: { id: string; title: string }; overlapMinutes: number }[];
  overloaded: { minutes: number; limit: number } | null;
  focus: { start: string; end: string; minutes: number }[];
  tasks: { id: string; title: string; why: string; dueAt: string | null }[];
  proposal: string[];
  question: string;
  notes: string[];
}
/** null when the plan cannot be read (never invented). */
export async function eveningPlanFor(principalId: string): Promise<EveningPlanView | null> {
  try {
    return (await get<{ plan: EveningPlanView | null }>("/api/agenda/plan", { principal: principalId })).plan;
  } catch {
    return null;
  }
}
