/**
 * SALIENCE. Deterministic, explainable scoring over named factors.
 *
 * Factor values come from data (relationship settings, interaction history, deadlines from the
 * calendar / commitments / detectors, prior insights) or from model assessments that survived
 * validation (urgency must quote the source; business impact must cite evidence). A factor that
 * does not apply is excluded and the remaining weights are renormalized — never filled with a guess.
 */
import { SALIENCE_WEIGHTS, SURFACE_THRESHOLD } from '../config.js';
import { HOUR_MS } from '../util/clock.js';
import type { ValidationReport } from './validator.js';

export type FactorName = keyof typeof SALIENCE_WEIGHTS;

export interface Factor {
  name: FactorName;
  value: number | null; // null = not applicable
  basis: string; // where the value came from
}

export interface SalienceResult {
  score: number;
  surfaced: boolean;
  threshold: number;
  factors: (Factor & { weight: number; contribution: number })[];
  explanation: string[];
}

export interface SalienceInputs {
  relationship: {
    explicitImportance: number | null;
    interactions90d: number;
    lastInteractionAt: Date | null;
    /** Derived from persisted messages (relationshipMetrics); absent → reply_pressure does not apply. */
    replies?: { unansweredInbound: number; oldestUnansweredAt: Date | null; principalReplyHoursMedian: number | null };
  } | null;
  /** For events about something other than a person (e.g. a website): its principal-set importance. */
  subject?: { importance: number | null; label: string } | null;
  deadlines: { at: Date; basis: string }[];
  now: Date;
  priorSimilarInsights: number;
  validation: ValidationReport;
  sourceKind: 'TEXT' | 'STATE';
}

/** Interaction volume → relevance: 0 interactions → 0, saturating around 12 in 90 days. Recency boosts. */
function relationshipRelevance(interactions90d: number, lastAt: Date | null, now: Date): number {
  const volume = 1 - Math.exp(-interactions90d / 6);
  if (!lastAt) return volume * 0.5;
  const days = Math.max(0, (now.getTime() - lastAt.getTime()) / 86_400_000);
  const recency = Math.exp(-days / 45);
  return Math.min(1, 0.6 * volume + 0.4 * recency);
}

/**
 * Reply pressure: the principal owes this person a reply. Applies only when there is real debt —
 * two or more of their messages unanswered, or the oldest one waiting longer than the principal's
 * own typical reply time (24h when there is no history). Otherwise it is not applicable (null).
 */
export function replyPressure(r: { unansweredInbound: number; oldestUnansweredAt: Date | null; principalReplyHoursMedian: number | null }, now: Date): { value: number; basis: string } | null {
  if (r.unansweredInbound === 0 || !r.oldestUnansweredAt) return null;
  const typical = r.principalReplyHoursMedian ?? 24;
  const waiting = Math.max(0, (now.getTime() - r.oldestUnansweredAt.getTime()) / HOUR_MS);
  if (r.unansweredInbound < 2 && waiting < typical) return null;
  const value = Math.min(1, Math.max(waiting / (3 * Math.max(typical, 1)), (r.unansweredInbound - 1) / 3));
  return {
    value,
    basis: `${r.unansweredInbound} mensagem(ns) da pessoa sem resposta sua, a mais antiga há ${Math.round(waiting)}h (${r.principalReplyHoursMedian == null ? 'sem histórico de respostas suas; referência de 24h' : `você costuma responder em ${Math.round(typical * 10) / 10}h`})`,
  };
}

/** Hours until the nearest deadline → sensitivity. Overdue or ≤4h → 1; one week → ~0.2. */
export function timeSensitivity(hours: number): number {
  if (hours <= 4) return 1;
  if (hours >= 168) return 0.1;
  return Math.max(0.1, 1 - ((hours - 4) / (168 - 4)) * 0.85);
}

export function computeSalience(input: SalienceInputs): SalienceResult {
  const v = input.validation;
  const factors: Factor[] = [];

  if (input.subject) {
    factors.push(
      input.subject.importance != null
        ? { name: 'importance', value: input.subject.importance, basis: `importância definida pelo executivo para ${input.subject.label}` }
        : { name: 'importance', value: 0.3, basis: `${input.subject.label}: importância ainda não definida pelo executivo` },
    );
  } else factors.push(
    input.relationship?.explicitImportance != null
      ? { name: 'importance', value: input.relationship.explicitImportance, basis: 'importância definida pelo executivo para esta pessoa' }
      : { name: 'importance', value: input.relationship ? 0.3 : 0.1, basis: input.relationship ? 'relação registrada, importância não definida' : 'pessoa desconhecida ou sem relação registrada' },
  );

  factors.push(
    input.sourceKind === 'STATE'
      ? { name: 'urgency', value: null, basis: 'evento derivado de estado (sem texto); urgência coberta pelo prazo' }
      : { name: 'urgency', value: v.urgency?.value ?? 0, basis: v.urgency?.quotes.length ? `urgência expressa no texto: "${v.urgency.quotes[0]}"` : 'nenhuma urgência expressa verificável no texto' },
  );

  factors.push(
    input.subject
      ? { name: 'relationship_relevance', value: null, basis: 'evento sobre um site, não sobre uma pessoa' }
      : input.relationship
      ? {
          name: 'relationship_relevance',
          value: relationshipRelevance(input.relationship.interactions90d, input.relationship.lastInteractionAt, input.now),
          basis: `${input.relationship.interactions90d} interações em 90 dias${input.relationship.lastInteractionAt ? `, última em ${input.relationship.lastInteractionAt.toISOString().slice(0, 10)}` : ''}`,
        }
      : { name: 'relationship_relevance', value: 0, basis: 'nenhuma interação registrada' },
  );

  factors.push({
    name: 'business_impact',
    value: v.businessImpact.value,
    basis: v.businessImpact.value == null ? 'impacto não sustentado por evidência (não pontuado)' : `avaliação validada: ${v.businessImpact.rationale}`,
  });

  factors.push({
    name: 'novelty',
    value: input.priorSimilarInsights === 0 ? 1 : 1 / (1 + input.priorSimilarInsights),
    basis: input.priorSimilarInsights === 0 ? 'nenhum insight recente sobre as mesmas pessoas' : `${input.priorSimilarInsights} insight(s) recente(s) sobre as mesmas pessoas`,
  });

  const claudeClaims = v.claims.filter((c) => c.producedBy === 'CLAUDE');
  const validClaude = claudeClaims.filter((c) => c.valid);
  const confidence = claudeClaims.length === 0 ? 0 : (validClaude.reduce((s, c) => s + c.confidence, 0) / claudeClaims.length) * (v.conflicts.length ? 0.8 : 1);
  factors.push({
    name: 'confidence',
    value: confidence,
    basis: `${validClaude.length}/${claudeClaims.length} afirmações validadas${v.conflicts.length ? `; ${v.conflicts.length} conflito(s) de evidência` : ''}`,
  });

  const future = input.deadlines.map((d) => ({ ...d, hours: (d.at.getTime() - input.now.getTime()) / HOUR_MS })).sort((a, b) => a.hours - b.hours);
  const nearest = future.find((d) => d.hours >= -24 * 7);
  factors.push(
    nearest
      ? { name: 'time_sensitivity', value: timeSensitivity(nearest.hours), basis: `${nearest.basis} em ${Math.round(nearest.hours)}h` }
      : { name: 'time_sensitivity', value: 0.1, basis: 'nenhum prazo identificado' },
  );

  const external = v.actions.some((a) => a.type === 'SEND_EMAIL');
  factors.push({
    name: 'actionability',
    value: v.actions.length === 0 ? 0 : external ? 1 : 0.7,
    basis: v.actions.length === 0 ? 'nenhuma ação validada' : `${v.actions.length} ação(ões) validada(s)`,
  });

  const rp = input.relationship?.replies ? replyPressure(input.relationship.replies, input.now) : null;
  factors.push(rp ? { name: 'reply_pressure', ...rp } : { name: 'reply_pressure', value: null, basis: 'nenhuma resposta sua pendente para esta pessoa' });

  const net = v.preferences.reduce((s, p) => s + (p.effect === 'RAISE' ? 1 : -1), 0);
  factors.push(
    v.preferences.length === 0
      ? { name: 'executive_preference', value: null, basis: 'nenhuma preferência registrada se aplica' }
      : { name: 'executive_preference', value: net > 0 ? 1 : net < 0 ? 0 : 0.5, basis: `preferências aplicáveis: ${v.preferences.map((p) => `${p.handle} (${p.effect})`).join(', ')}` },
  );

  const applicable = factors.filter((f) => f.value != null);
  const totalWeight = applicable.reduce((s, f) => s + SALIENCE_WEIGHTS[f.name], 0);
  const scored = factors.map((f) => {
    const weight = f.value == null ? 0 : SALIENCE_WEIGHTS[f.name] / totalWeight;
    return { ...f, weight, contribution: f.value == null ? 0 : weight * f.value };
  });
  const score = Math.round(scored.reduce((s, f) => s + f.contribution, 0) * 1000) / 1000;

  const top = [...scored].filter((f) => f.value != null).sort((a, b) => b.contribution - a.contribution);
  const explanation = [
    `Pontuação ${score.toFixed(2)} (limiar ${SURFACE_THRESHOLD}) — ${score >= SURFACE_THRESHOLD ? 'apresentado proativamente' : 'registrado sem interromper'}.`,
    ...top.slice(0, 4).map((f) => `${f.name}: ${f.value!.toFixed(2)} — ${f.basis}`),
  ];

  return { score, surfaced: score >= SURFACE_THRESHOLD, threshold: SURFACE_THRESHOLD, factors: scored, explanation };
}
