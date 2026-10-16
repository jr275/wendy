/**
 * What a proactive suggestion must tell the principal, built ONLY from what Wendy recorded:
 *   o que foi detectado · de onde veio · por que apareceu · que ação existe e de que natureza.
 * Nothing here is inferred or invented: origin comes from the evidence the validated claims cite,
 * "por que" from the salience explanation Wendy stored, and the action from her action records.
 * "Why now" is therefore only as specific as Wendy's own explanation — when she recorded none, none is shown.
 */
import { ACTION_LABEL, EVENT_LABEL, stripRefs } from "./format";
import type { InsightCard } from "./wendy";

export type ActionNature = "suggestion" | "done" | "none" | "stopped";

export interface Anatomy {
  detected: string;
  origin: string;
  whyShown: string | null;
  action: { nature: ActionNature; text: string };
}

const KIND_LABEL: Record<string, string> = {
  message: "e-mail",
  meeting: "reunião",
  memory: "memória",
  commitment: "compromisso",
  person: "pessoa",
  search_metric: "Search Console",
  event: "evento",
  insight: "insight anterior",
  document: "documento",
  web_page: "página web",
};
const ORDER = Object.keys(KIND_LABEL);

export function originOf(i: Pick<InsightCard, "cited" | "event_type">): string {
  const kinds = [...new Set((i.cited ?? []).map((c) => c.kind))].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const labels = kinds.filter((k) => k !== "event").map((k) => KIND_LABEL[k] ?? k);
  if (labels.length) return labels.join(" · ");
  return EVENT_LABEL[i.event_type] ?? i.event_type;
}

const label = (t: string) => ACTION_LABEL[t] ?? t;

/** The action of a suggestion, in words, with its nature: needs you (suggestion), already done, nothing, or stopped. */
export function actionOf(actions: InsightCard["actions"]): Anatomy["action"] {
  const list = actions ?? [];
  if (!list.length) return { nature: "none", text: "Nenhuma ação sugerida: é só informação." };
  const pick = (states: string[]) => list.find((a) => states.includes(a.state));
  const waiting = pick(["PROPOSED", "STAGED", "AWAITING_APPROVAL"]);
  if (waiting) return { nature: "suggestion", text: `${label(waiting.type)} aguardando sua aprovação. Nada sai antes disso.` };
  const running = pick(["APPROVED", "EXECUTING"]);
  if (running) return { nature: "suggestion", text: `${label(running.type)} aprovado e em execução.` };
  const done = pick(["EXECUTED", "VERIFIED"]);
  if (done) return { nature: "done", text: `${label(done.type)} concluído e verificado.` };
  const rejected = pick(["REJECTED"]);
  if (rejected) return { nature: "stopped", text: `${label(rejected.type)} recusado por você.` };
  const failed = pick(["FAILED"]);
  if (failed) return { nature: "stopped", text: `${label(failed.type)} não foi concluído.` };
  const lapsed = pick(["EXPIRED", "CANCELLED"]);
  return { nature: "stopped", text: `${label(lapsed?.type ?? list[0]!.type)} ${lapsed?.state === "CANCELLED" ? "cancelado" : "expirou sem decisão"}.` };
}

export function anatomyOf(i: InsightCard): Anatomy {
  return {
    detected: stripRefs(i.headline) || "Sem título",
    origin: originOf(i),
    whyShown: i.explanation?.[0]?.trim() || null,
    action: actionOf(i.actions),
  };
}

export const NATURE_LABEL: Record<ActionNature, string> = { suggestion: "Sugestão", done: "Feito", none: "Informação", stopped: "Parado" };

/** How many quiet items the list shows before the principal asks for more of Wendy's records. */
export const QUIET_LIMIT = 10;

/**
 * The insights Wendy RECORDED without interrupting (below the relevance threshold), newest first —
 * so "5 others were registered" is something that can be opened and read, not a dead number.
 * Surfaced and rejected ones are not here; nothing is re-scored or filtered by anything but Wendy's own status.
 */
export function quietOf(insights: readonly InsightCard[], limit = QUIET_LIMIT): InsightCard[] {
  return insights
    .filter((i) => i.status === "SUPPRESSED")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
