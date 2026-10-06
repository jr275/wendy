/**
 * Presentation of a persisted insight. Pure formatting of stored records: the narrative and claims
 * come from validated reasoning; what was prepared / what awaits approval comes from the actual
 * action states in the database (Claude can never claim an action happened).
 */
import type { Queryable } from '../db/db.js';

interface ClaimRow {
  ordinal: number;
  label: string;
  kind: string;
  statement: string;
  confidence: number;
  evidence: { handle: string; kind: string; id: string }[];
  derived_from: number[];
  produced_by: string;
  validation_status: string;
}

const KIND_PT: Record<string, string> = {
  FACT: 'FATO',
  INFERENCE: 'INFERÊNCIA',
  HYPOTHESIS: 'HIPÓTESE',
  ANTICIPATION: 'ANTECIPAÇÃO',
  RECOMMENDATION: 'RECOMENDAÇÃO',
};

const STATE_PT: Record<string, string> = {
  AWAITING_APPROVAL: 'aguardando sua aprovação',
  APPROVED: 'aprovada, na fila de execução',
  EXECUTING: 'em execução',
  EXECUTED: 'executada, aguardando verificação',
  VERIFIED: 'executada e verificada',
  REJECTED: 'rejeitada',
  FAILED: 'falhou',
  CANCELLED: 'cancelada',
  EXPIRED: 'expirada',
};

export async function renderInsight(q: Queryable, insightId: string): Promise<string> {
  const insight = (
    await q.query<{ status: string; headline: string | null; narrative: string | null; salience: { score: number; explanation: string[] }; validation: { gaps: string[]; conflicts: { description: string }[]; summary: { claimsRejected: number } } }>(
      'SELECT status, headline, narrative, salience, validation FROM insights WHERE id = $1',
      [insightId],
    )
  ).rows[0];
  if (!insight) throw new Error(`insight ${insightId} not found`);
  const claims = (await q.query<ClaimRow>('SELECT * FROM claims WHERE insight_id = $1 ORDER BY ordinal', [insightId])).rows;
  const actions = (
    await q.query<{ id: string; action_type: string; state: string; content: Record<string, unknown>; verification: { provider: string; deliversExternally: boolean } | null }>(
      `SELECT a.id, a.action_type, a.state, v.content, e.verification
       FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
       LEFT JOIN action_executions e ON e.action_id = a.id
       WHERE a.insight_id = $1 ORDER BY a.created_at`,
      [insightId],
    )
  ).rows;

  const valid = claims.filter((c) => c.validation_status === 'VALID');
  const label = (ord: number) => valid.find((c) => c.ordinal === ord)?.label ?? `#${ord}`;
  const out: string[] = [];

  if (insight.status === 'SURFACED') out.push('Encontrei algo que acho que você deveria saber.');
  else if (insight.status === 'SUPPRESSED') out.push('(Registrado sem interromper — abaixo do limiar de atenção.)');
  else out.push('(Raciocínio rejeitado pela validação de evidências — nada a apresentar.)');
  out.push('');
  if (insight.headline && insight.status !== 'REJECTED_BY_VALIDATION') out.push(`## ${insight.headline}`, '');

  if (insight.narrative) out.push(insight.narrative, '');
  else if (insight.status !== 'REJECTED_BY_VALIDATION') {
    out.push('(Narrativa do modelo rejeitada pela validação; exibindo apenas afirmações validadas.)', '');
  }

  out.push('### Por que isso apareceu', ...insight.salience.explanation.map((l) => `- ${l}`), '');

  for (const kind of ['FACT', 'INFERENCE', 'HYPOTHESIS', 'ANTICIPATION', 'RECOMMENDATION']) {
    const group = valid.filter((c) => c.kind === kind);
    if (!group.length) continue;
    out.push(`### ${KIND_PT[kind]}`);
    for (const c of group) {
      if (kind === 'FACT') out.push(`- [${c.evidence.map((e) => e.handle).join(', ')}] ${c.statement.split('\n')[0]}`);
      else
        out.push(
          `- [${c.label}] ${c.statement} (confiança ${c.confidence.toFixed(2)}; base: ${c.derived_from.map(label).join(', ') || '—'})`,
        );
    }
    out.push('');
  }

  if (insight.validation.conflicts.length) out.push('### Evidências conflitantes', ...insight.validation.conflicts.map((c) => `- ${c.description}`), '');
  if (insight.validation.gaps.length) out.push('### O que eu não sei', ...insight.validation.gaps.map((g) => `- ${g}`), '');

  const prepared = actions.filter((a) => a.state !== 'AWAITING_APPROVAL');
  const pending = actions.filter((a) => a.state === 'AWAITING_APPROVAL');
  if (prepared.length) {
    out.push('### O que preparei');
    for (const a of prepared) {
      const where = a.verification ? ` via ${a.verification.provider}${a.verification.deliversExternally ? '' : ' (local, não entregue externamente)'}` : '';
      out.push(`- ${a.action_type}: ${STATE_PT[a.state] ?? a.state}${where}${a.action_type === 'PREPARE_BRIEFING' ? ` — "${String(a.content.title ?? '')}"` : ''}`);
    }
    out.push('');
  }
  if (pending.length) {
    out.push('### Precisa da sua aprovação');
    for (const a of pending) {
      if (a.action_type === 'SEND_EMAIL') out.push(`- E-mail para ${(a.content.to as string[]).join(', ')} — assunto: "${String(a.content.subject)}" (ação ${a.id})`);
      else out.push(`- ${a.action_type} (ação ${a.id})`);
    }
    out.push('');
  }
  if (insight.validation.summary.claimsRejected) out.push(`(${insight.validation.summary.claimsRejected} afirmação(ões) rejeitada(s) pela validação e omitida(s).)`);
  return out.join('\n').trim();
}
