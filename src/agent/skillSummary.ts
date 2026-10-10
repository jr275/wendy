/** The chat line that accompanies a skill run's card. Built by code from the run's state; no model. */
import { pendingApprovals, type ExecutionView } from '../skills/view.js';

const strip = (s: string) => s.replace(/\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\]/g, '').trim();

interface AnalysisLike {
  answer?: string;
  answerValid?: boolean;
  claims?: unknown[];
}

function analysisText(o: AnalysisLike): string {
  const text = strip(o.answer ?? '');
  if (!o.claims?.length) return 'Não encontrei nas fontes nada que eu consiga afirmar com segurança. Veja abaixo o que li e o que faltou.';
  return o.answerValid === false ? `${text}\n\n_Este texto não passou inteiro na validação — confie só nas afirmações comprovadas abaixo._` : text;
}

export function summarizeRun(v: ExecutionView): string {
  const pending = pendingApprovals(v);
  const call = pending.find((p) => p.tool === 'voice.call');
  if (call) return `Entendi assim:\n${call.items.map((i) => `- ${i}`).join('\n')}\n\nPosso fazer essa ligação? Aprove ou recuse no cartão abaixo.`;
  if (pending.length) return `Preciso da sua aprovação para continuar: ${pending.map((p) => p.label.toLowerCase()).join(', ')}. Está no cartão abaixo.`;
  if (v.status === 'failed') return `Não consegui concluir "${v.skillName}": ${v.error?.message ?? 'erro desconhecido'}.`;
  if (v.status === 'cancelled') return `"${v.skillName}" foi cancelada.`;
  if (v.status !== 'completed') return `Estou trabalhando em "${v.skillName}" e continuo em segundo plano. O cartão abaixo se atualiza sozinho.`;

  const o = (v.output ?? {}) as Record<string, unknown>;
  switch (v.skillId) {
    case 'web-research':
    case 'document-analysis':
      return analysisText(o as AnalysisLike);
    case 'task-management': {
      const n = (o.tasks as unknown[] | undefined)?.length ?? 0;
      if (o.status === 'declined') return `Não mexi nas suas tarefas: ${o.reason === 'principal policy: never' ? 'sua política proíbe essa ação' : 'você recusou'}.`;
      if (o.operation === 'list') return n ? `Você tem ${n} tarefa${n === 1 ? '' : 's'} em aberto.` : 'Você não tem tarefas em aberto.';
      if (o.operation === 'create') return `Pronto: ${n} tarefa${n === 1 ? ' criada' : 's criadas'}.`;
      return o.operation === 'complete' ? 'Pronto: tarefa marcada como feita.' : 'Pronto: tarefa apagada (fica no histórico).';
    }
    case 'research-and-plan': {
      const research = v.children.find((c) => c.skillId === 'web-research');
      const tasks = o.tasks as { status: string; items: unknown[] } | undefined;
      const head = research?.output ? analysisText(research.output as AnalysisLike) : '';
      const tail =
        tasks?.status === 'done'
          ? `Criei ${tasks.items.length} tarefa${tasks.items.length === 1 ? '' : 's'} de acompanhamento.`
          : tasks?.status === 'declined'
            ? 'Não criei as tarefas: você recusou.'
            : tasks?.status === 'none_justified'
              ? 'Nenhuma tarefa se justificava pelo que as fontes dizem.'
              : '';
      return [head, tail].filter(Boolean).join('\n\n');
    }
    case 'learn-about-me': {
      const n = (o.proposed as unknown[] | undefined)?.length ?? 0;
      const sensitive = (o.droppedSensitive as number) ?? 0;
      const head = n ? `Separei ${n} coisa${n === 1 ? '' : 's'} sobre você, cada uma com a frase de onde veio. Confirme o que estiver certo; nada vale até você confirmar.` : 'Não encontrei nada sobre você que eu consiga citar com segurança nessa fonte.';
      return sensitive ? `${head}\n\nDeixei de fora ${sensitive} ponto${sensitive === 1 ? '' : 's'} sensíve${sensitive === 1 ? 'l' : 'is'} (saúde, família, dinheiro…). Só guardo esse tipo de coisa se você pedir.` : head;
    }
    case 'voice-concierge': {
      if (o.status === 'needs_information' || o.status === 'phone_unresolved') {
        const qs = (o.questions as string[]) ?? [];
        return `Antes de ligar, preciso de ${qs.length === 1 ? 'uma informação' : 'algumas informações'}:\n${qs.map((q) => `- ${q}`).join('\n')}`;
      }
      if (o.notice) return o.notice as string;
      const summary = (o.result as { summary?: string } | null)?.summary ?? `"${v.skillName}" concluída.`;
      const cost = o.cost as { amount: number; currency: string } | null;
      if (!cost || cost.amount <= 0) return summary;
      const value = `${cost.currency} ${cost.amount.toFixed(2).replace('.', ',')}`;
      return (o.result as { simulated?: boolean } | null)?.simulated ? `${summary}\n\nCusto estimado: ${value} (simulação — nada foi cobrado).` : `${summary}\n\nCusto estimado da ligação: ${value}.`;
    }
    default:
      return `"${v.skillName}" concluída.`;
  }
}
