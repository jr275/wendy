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
}

export async function sites(principalId: string) {
  return (await get<{ sites: Site[] }>("/api/sites", { principal: principalId })).sites;
}

/** Which model reasoned (honesty label shown everywhere). */
export function reasonerLabel(insights: InsightCard[]): string | null {
  const other = insights.find((i) => i.other_model)?.other_model;
  return other ?? null;
}
