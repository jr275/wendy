/**
 * Task presentation model — the ONLY place where Wendy's runtime state becomes interface state.
 * Pure: (ExecutionView from Wendy, now) → TaskPresentation. Nothing is stored or guessed here:
 *   - the state is read from the run status, the voice.call action and the call fold (voice block);
 *   - an approval is shown only while the action really is AWAITING_APPROVAL;
 *   - facts come only from Wendy's structured result; missing facts stay missing;
 *   - costs and limits are the backend's numbers.
 * The visual entity (presence) is derived from the same state, so the look can change freely.
 */
import type { ExecutionView, Money, PhoneSource, VoiceView } from "./wendy";

export const TASK_STATES = [
  "PLANNING",
  "NEEDS_INFO",
  "BLOCKED",
  "AWAITING_APPROVAL",
  "WAITING",
  "DIALING",
  "CONNECTED",
  "ACTIVE",
  "ACTION_REQUIRED",
  "ENDING",
  "COMPLETED",
  "PARTIAL_SUCCESS",
  "NEEDS_YOU",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Ended for good: the task will not move again on its own. */
export const TERMINAL: readonly TaskState[] = ["NEEDS_INFO", "BLOCKED", "COMPLETED", "PARTIAL_SUCCESS", "NEEDS_YOU", "FAILED", "CANCELLED"];
/** A call is under way (dialing → wrapping up). */
export const IN_CALL: readonly TaskState[] = ["DIALING", "CONNECTED", "ACTIVE", "ACTION_REQUIRED", "ENDING"];

/** How the visual Wendy behaves. Presentation only; the agent knows nothing about it. */
export type PresenceState = "idle" | "listening" | "thinking" | "planning" | "awaiting" | "waiting" | "calling" | "connected" | "attention" | "done" | "error";

export interface TimelineStep {
  label: string;
  status: "done" | "current" | "pending" | "failed" | "skipped";
}

export interface TaskPresentation {
  id: string;
  state: TaskState;
  terminal: boolean;
  inCall: boolean;
  /** Can the principal still stop it? Only before anything was approved (Wendy re-checks on the server). */
  cancellable: boolean;
  presence: PresenceState;
  /** e.g. "Reservar uma mesa" (Wendy's objective, in the principal's language). */
  title: string;
  /** Who Wendy calls (from the mandate). */
  target: string | null;
  /** e.g. "Restaurante Aurora · hoje · 20:00 · 2 pessoas" — only what the mandate holds. */
  subtitle: string | null;
  /** One short concierge sentence for the state. Announced to screen readers when it changes. */
  line: string;
  timeline: TimelineStep[];
  approval: {
    actionId: string;
    target: string;
    phone: string;
    source: string;
    terms: string[];
    maxMinutes: number;
    cost: string;
    simulated: boolean;
    authorizedByRequest: boolean;
  } | null;
  call: { state: string; startedAt: string | null; connectedAt: string | null; lastEventAt: string | null; durationSeconds: number | null; transcript: { speaker: "Wendy" | "Eles"; text: string }[]; simulated: boolean } | null;
  blocked: { title: string; body: string; usage: { label: string; value: string; ratio: number } | null } | null;
  questions: string[];
  result: {
    tone: "success" | "partial" | "needs_you" | "failure" | "neutral";
    headline: string;
    facts: { label: string; value: string }[];
    whatHappened: string | null;
    next: string | null;
    cost: string | null;
    simulated: boolean;
    channel: string | null;
  } | null;
}

interface VoiceOutput {
  status: "needs_information" | "phone_unresolved" | "called" | "not_called";
  questions: string[];
  understood: string[];
  notice: string | null;
  cost: (Money & { billedMinutes: number }) | null;
  objective: string;
  target: string;
  result: { success: boolean; outcome: string; summary: string; extractedFacts: { key: string; value: string }[]; nextActions: string[]; requiresUserAction: boolean; simulated: boolean } | null;
}

// ── formatting (pt-BR) ───────────────────────────────────────────────────────────────────
export function money(m: Money | null | undefined): string {
  if (!m) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: m.currency }).format(m.amount).replace(/\u00a0/g, " ");
  } catch {
    return `${m.currency} ${m.amount.toFixed(2).replace(".", ",")}`;
  }
}

/** +552130001000 → +55 21 3000-1000; anything else as given. */
export function phone(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : e164;
}

const SOURCE: Record<string, string> = { official_site: "site oficial", business_listing: "guia de estabelecimentos", other: "outra página" };
const CONFIDENCE: Record<string, string> = { high: "confiança alta", medium: "confiança média", low: "confiança baixa" };
function sourceLabel(s: PhoneSource): string {
  if (s.kind === "principal") return "número que você informou";
  return [s.title ?? (s.sourceType ? SOURCE[s.sourceType] : "página na web"), s.confidence ? CONFIDENCE[s.confidence] : null].filter(Boolean).join(" · ");
}

function dayLabel(iso: string, now: Date, tz: string): string {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = fmt(now);
  const tomorrow = fmt(new Date(now.getTime() + 86_400_000));
  if (iso === today) return "hoje";
  if (iso === tomorrow) return "amanhã";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

const PEOPLE_KEYS = ["party_size", "guests", "partySize"];
function subtitleOf(m: NonNullable<VoiceView["mandate"]> | null, fallbackTarget: string | null, now: Date, tz: string): string | null {
  const p = m?.parameters ?? {};
  const people = PEOPLE_KEYS.map((k) => p[k]).find((x) => x !== undefined);
  const date = typeof p.date === "string" ? dayLabel(p.date, now, tz) : typeof p.check_in === "string" ? dayLabel(p.check_in, now, tz) : null;
  const parts = [m?.targetName ?? fallbackTarget, date, typeof p.time === "string" ? p.time : null, people !== undefined ? `${people} ${Number(people) === 1 ? "pessoa" : "pessoas"}` : null].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
}

const FACT_LABEL: Record<string, string> = { date: "Dia", time: "Horário", party_size: "Pessoas", guests: "Hóspedes", check_in: "Entrada", check_out: "Saída", "alternativa.time": "Alternativa oferecida", "alternativa.date": "Outra data oferecida", cobrança: "Cobrança pedida", disponibilidade: "Disponibilidade" };
function factsOf(r: VoiceOutput["result"], now: Date, tz: string): { label: string; value: string }[] {
  return (r?.extractedFacts ?? [])
    .filter((f) => f.key !== "status")
    .map((f) => ({ label: FACT_LABEL[f.key] ?? f.key, value: f.key === "date" || f.key === "check_in" || f.key === "check_out" ? dayLabel(f.value, now, tz) : f.value }));
}

const ratio = (x: number, max: number) => (max > 0 ? Math.min(1, Math.max(0, x / max)) : 0);

/** Strips the simulation prefix the backend adds (the UI shows simulation as its own label). */
const plain = (s: string) => s.replace(/^\(Simulação — nenhuma ligação real\.\)\s*/, "");

const LIVE_LINE: Record<string, string> = {
  available: "Têm disponibilidade. Estou confirmando.",
  confirmed: "Confirmaram. Estou encerrando a ligação.",
  alternative: "Ofereceram outra opção. Estou avaliando com o que você me autorizou.",
  charge: "Mencionaram uma cobrança. Não aceito sem você.",
  requests_info: "Pediram uma informação. Só passo o que você autorizou.",
  unavailable: "Não têm o que você pediu.",
};

// ── state ───────────────────────────────────────────────────────────────────────────────
export function taskState(v: ExecutionView): TaskState {
  const o = v.output as VoiceOutput | null;
  const voice = v.voice;
  if (v.status === "failed") return "FAILED";
  if (v.status === "cancelled") return "CANCELLED";
  if (v.status === "completed") {
    if (!o) return "FAILED";
    if (o.status === "needs_information" || o.status === "phone_unresolved") return "NEEDS_INFO";
    if (o.status === "not_called") return o.notice ? "BLOCKED" : o.result?.outcome === "FAILED" ? "FAILED" : "CANCELLED";
    switch (o.result?.outcome) {
      case "COMPLETED":
        return "COMPLETED";
      case "PARTIAL_SUCCESS":
        return "PARTIAL_SUCCESS";
      case "REQUIRES_CONFIRMATION":
        return "NEEDS_YOU";
      case "CANCELLED":
        return "CANCELLED";
      default:
        return "FAILED";
    }
  }
  // Not finished. Approval first: while the action waits for the principal, nothing is running.
  if (v.approvals.some((a) => a.tool === "voice.call" && a.state === "AWAITING_APPROVAL")) return "AWAITING_APPROVAL";
  const call = voice?.call;
  if (call) {
    if (call.state === "DIALING") return "DIALING";
    if (call.state === "CONNECTED") return "CONNECTED";
    if (call.state === "ACTIVE") return "ACTIVE";
    if (call.state === "ACTION_REQUIRED") return "ACTION_REQUIRED";
    if (call.state === "ENDED" || call.terminal) return "ENDING"; // the call is over; Wendy is classifying it
    return "DIALING"; // the call exists (created) and is being placed
  }
  // The action's state is the authority: refused or expired means nothing will be dialed.
  if (voice?.action && ["REJECTED", "CANCELLED", "EXPIRED"].includes(voice.action.state)) return "CANCELLED";
  if (voice?.action?.state === "FAILED") return "FAILED";
  if (voice?.action && ["APPROVED", "EXECUTING", "EXECUTED"].includes(voice.action.state)) return "WAITING";
  return "PLANNING";
}

const PRESENCE: Record<TaskState, PresenceState> = {
  PLANNING: "planning",
  NEEDS_INFO: "listening",
  BLOCKED: "attention",
  AWAITING_APPROVAL: "awaiting",
  WAITING: "waiting",
  DIALING: "calling",
  CONNECTED: "connected",
  ACTIVE: "connected",
  ACTION_REQUIRED: "attention",
  ENDING: "thinking",
  COMPLETED: "done",
  PARTIAL_SUCCESS: "attention",
  NEEDS_YOU: "attention",
  FAILED: "error",
  CANCELLED: "idle",
};

function timelineOf(state: TaskState, voice: VoiceView | undefined): TimelineStep[] {
  const byRequest = voice?.approvedBy === "principal_message";
  const steps: { key: string; label: string }[] = [
    { key: "understand", label: "Entender o pedido" },
    ...(voice?.phone === "not_needed" ? [] : [{ key: "phone", label: "Encontrar o número" }]),
    { key: "approve", label: byRequest ? "Autorizado no seu pedido" : "Sua aprovação" },
    { key: "call", label: "Ligar" },
    { key: "result", label: "Confirmar" },
  ];
  const reached: Record<TaskState, string> = {
    PLANNING: voice?.phone === "searching" ? "phone" : voice?.mandate ? (voice.phone === "resolved" || voice.phone === "not_needed" ? "approve" : "phone") : "understand",
    NEEDS_INFO: voice?.phone === "failed" ? "phone" : "understand",
    BLOCKED: "approve",
    AWAITING_APPROVAL: "approve",
    WAITING: "call",
    DIALING: "call",
    CONNECTED: "call",
    ACTIVE: "call",
    ACTION_REQUIRED: "call",
    ENDING: "result",
    COMPLETED: "end",
    PARTIAL_SUCCESS: "result",
    NEEDS_YOU: "result",
    FAILED: voice?.call ? "call" : voice?.action ? "approve" : "understand",
    CANCELLED: "approve",
  };
  const at = reached[state];
  const idx = at === "end" ? steps.length : Math.max(0, steps.findIndex((s) => s.key === at));
  const stopped = TERMINAL.includes(state) && state !== "COMPLETED";
  return steps.map((s, i) => ({
    label: s.label,
    // Stopped tasks: waiting on the principal's answer shows as current; anything else as interrupted.
    status: i < idx ? "done" : i === idx ? (stopped ? (state === "NEEDS_INFO" ? "current" : "failed") : at === "end" ? "done" : "current") : stopped ? "skipped" : "pending",
  }));
}

export function toTaskPresentation(v: ExecutionView, now: Date = new Date(), tz = "America/Sao_Paulo"): TaskPresentation {
  const state = taskState(v);
  const o = v.output as VoiceOutput | null;
  const voice = v.voice;
  const m = voice?.mandate ?? null;
  const pending = v.approvals.find((a) => a.tool === "voice.call" && a.state === "AWAITING_APPROVAL");
  const call = voice?.call ?? null;
  const simulated = call?.simulated ?? voice?.estimate.simulated ?? true;
  const lastSignal = call ? [...call.signals].reverse()[0]?.kind : undefined;

  const line = ((): string => {
    switch (state) {
      case "PLANNING":
        return voice?.phone === "searching" ? "Estou procurando o número certo." : "Deixa comigo. Estou organizando o pedido.";
      case "NEEDS_INFO":
        return "Preciso de um detalhe antes de ligar.";
      case "BLOCKED":
        return "Não posso ligar agora.";
      case "AWAITING_APPROVAL":
        return "Posso cuidar disso. Posso ligar para eles?";
      case "WAITING":
        return "Autorizado. Vou ligar agora.";
      case "DIALING":
        return "Ligando…";
      case "CONNECTED":
        return "Atenderam. Estou falando com eles.";
      case "ACTIVE":
        return (lastSignal && LIVE_LINE[lastSignal]) || "Estou falando com eles.";
      case "ACTION_REQUIRED":
        return "Pediram algo que depende de você. Não aceito nada sem você.";
      case "ENDING":
        return "Terminei a ligação. Organizando o resultado.";
      case "COMPLETED":
        return "Está confirmado.";
      case "PARTIAL_SUCCESS":
        return "Não deu como você pediu, mas há uma alternativa.";
      case "NEEDS_YOU":
        return "Eles podem seguir, mas precisam da sua confirmação.";
      case "FAILED":
        return "Não consegui concluir esta.";
      case "CANCELLED":
        return "Tudo bem, não liguei.";
    }
  })();

  const blocked = ((): TaskPresentation["blocked"] => {
    if (state !== "BLOCKED") return null;
    const b = voice?.blocked;
    const L = b?.limits;
    const cur = L?.currency ?? "USD";
    const amt = (x: number) => money({ amount: x, currency: cur });
    switch (b?.kind) {
      case "permission":
        return { title: "Ligações estão bloqueadas", body: "Nas suas permissões, a Wendy não faz ligações. Você pode mudar isso quando quiser.", usage: null };
      case "calls_per_day":
        return { title: "Limite de ligações do dia", body: `Você já chegou a ${L?.callsPerDay} ligações hoje.`, usage: { label: "Ligações hoje", value: `${b.usage?.callsToday ?? "—"} / ${L?.callsPerDay}`, ratio: ratio(b.usage?.callsToday ?? 0, L?.callsPerDay ?? 0) } };
      case "per_call":
        return { title: "Esta ligação pode custar mais que o seu limite", body: `Uma ligação pode chegar a ${money(b.worstCase)}; seu limite por ligação é ${amt(L!.maxPerCall)}.`, usage: null };
      case "day":
        return { title: "Passaria do seu orçamento de hoje", body: `Mais uma ligação pode custar até ${money(b.worstCase)}.`, usage: { label: "Uso estimado hoje", value: `${amt(b.usage?.spentToday ?? 0)} / ${amt(L!.maxPerDay)}`, ratio: ratio(b.usage?.spentToday ?? 0, L!.maxPerDay) } };
      case "month":
        return { title: "Passaria do seu orçamento do mês", body: `Mais uma ligação pode custar até ${money(b.worstCase)}.`, usage: { label: "Uso estimado no mês", value: `${amt(b.usage?.spentMonth ?? 0)} / ${amt(L!.maxPerMonth)}`, ratio: ratio(b.usage?.spentMonth ?? 0, L!.maxPerMonth) } };
      default:
        return { title: "Não posso ligar agora", body: o?.notice ?? "", usage: null };
    }
  })();

  const result = ((): TaskPresentation["result"] => {
    if (!TERMINAL.includes(state) || state === "BLOCKED" || state === "NEEDS_INFO") return null;
    const r = o?.result ?? null;
    const cost = o?.cost && o.cost.amount > 0 ? money(o.cost) : null;
    const base = { facts: factsOf(r, now, tz), cost, simulated: r?.simulated ?? simulated, channel: call ? "por telefone" : null };
    switch (state) {
      case "COMPLETED":
        return { ...base, tone: "success", headline: "Está confirmado.", whatHappened: null, next: null };
      case "PARTIAL_SUCCESS":
        return {
          ...base,
          tone: "partial",
          headline: "Há uma alternativa.",
          whatHappened: base.facts.length ? `Não tinham o que você pediu. Ofereceram ${base.facts.map((f) => f.value).join(", ")} — não aceitei sem você.` : r ? plain(r.summary) : null,
          next: "Se quiser, me peça de novo com o novo horário.",
        };
      case "NEEDS_YOU":
        return { ...base, tone: "needs_you", headline: "Precisa da sua decisão.", whatHappened: r ? plain(r.summary) : null, next: "Ainda não aceito cobranças por você; nada foi pago." };
      case "CANCELLED":
        return { ...base, tone: "neutral", headline: "Não liguei.", whatHappened: r ? plain(r.summary) : null, next: null };
      default: {
        const what = r ? plain(r.summary) : (v.error?.message ?? null);
        const next =
          r?.outcome === "NO_ANSWER" || r?.outcome === "BUSY" || r?.outcome === "VOICEMAIL"
            ? "Não tentei de novo sozinha. Posso ligar mais tarde — é só pedir."
            : r?.outcome === "POLICY_VIOLATION"
              ? (r.nextActions[0] ?? null)
              : null;
        return { ...base, tone: "failure", headline: "Não consegui concluir esta.", whatHappened: what, next };
      }
    }
  })();

  return {
    id: v.id,
    state,
    terminal: TERMINAL.includes(state),
    inCall: IN_CALL.includes(state),
    cancellable: state === "PLANNING" || state === "AWAITING_APPROVAL",
    presence: PRESENCE[state],
    title: m?.objective ?? o?.objective ?? "Ligação",
    target: m?.targetName ?? (o?.target || null),
    subtitle: subtitleOf(m, o?.target || null, now, tz),
    line,
    timeline: timelineOf(state, voice),
    approval:
      state === "AWAITING_APPROVAL" && pending && m && voice
        ? {
            actionId: pending.actionId,
            target: m.targetName,
            phone: phone(m.phone),
            source: sourceLabel(m.phoneSource),
            // Wendy's own summary of the mandate, minus the first two lines (target and objective, shown above).
            terms: pending.items.slice(2),
            maxMinutes: Math.ceil(voice.estimate.maxCallSeconds / 60),
            cost: money(voice.estimate.worstCase),
            simulated,
            authorizedByRequest: voice.confirmationReasons.length === 0,
          }
        : null,
    call: call
      ? {
          state: call.state,
          startedAt: call.transcript[0]?.at ?? null,
          connectedAt: call.connectedAt,
          lastEventAt: call.endedAt ?? call.transcript.at(-1)?.at ?? call.connectedAt,
          durationSeconds: call.durationSeconds,
          transcript: call.transcript.map((t) => ({ speaker: t.speaker === "agent" ? "Wendy" : "Eles", text: t.text })),
          simulated: call.simulated,
        }
      : null,
    blocked,
    questions: state === "NEEDS_INFO" ? (o?.questions ?? []) : [],
    result,
  };
}

/** The desk's Wendy: the live task leads; else the agent's own activity; else at rest. */
export function deskPresence(tasks: TaskPresentation[], agentRunning: boolean, composing: boolean): PresenceState {
  const live = tasks.find((t) => !t.terminal);
  if (live) return live.presence;
  if (agentRunning) return "thinking";
  if (composing) return "listening";
  return "idle";
}
