import type { EveningPlanView } from "@/lib/wendy";

/**
 * "Planejamento de amanhã": what tomorrow looks like and the question Wendy asks. Built only from the person's agenda and tasks; Wendy proposes and asks,
 * she does not set priorities or book anything. Plain server markup (no client code).
 */
export function EveningPlan({ plan, showWhenClosed = false }: { plan: EveningPlanView | null; showWhenClosed?: boolean }) {
  if (!plan) return showWhenClosed ? <p className="text-muted">Não consegui montar o planejamento agora. A Wendy não mostra o que não conseguiu ler.</p> : null;
  if (!plan.inWindow && !showWhenClosed) return null;
  const label = new Date(`${plan.day}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "long" });
  return (
    <div className="card px-5 py-4" aria-labelledby="h-plano-amanha">
      <h3 id="h-plano-amanha" className="font-semibold">
        Planejamento de amanhã <span className="font-normal capitalize text-muted">· {label}</span>
      </h3>
      {!plan.inWindow ? <p className="mt-1 text-sm text-faint">Na tela inicial isto aparece a partir das 21h. Aqui dá para ver a qualquer hora.</p> : null}
      <ul className="mt-3 space-y-1 text-sm">
        {plan.proposal.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {plan.tasks.length ? (
        <>
          <p className="eyebrow mt-4">Tarefas que pedem atenção</p>
          <ul className="mt-2 space-y-1 text-sm">
            {plan.tasks.map((t) => (
              <li key={t.id}>
                {t.title} <span className="text-muted">· {t.why}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">Nenhuma tarefa atrasada, com prazo para amanhã ou marcada por você como urgente.</p>
      )}
      <p className="mt-4 font-medium">{plan.question}</p>
      <p className="mt-1 text-sm text-faint">Responda na conversa. Eu não defino prioridade nem prazo e não marco nada na agenda.</p>
      {plan.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-faint">
          {n}
        </p>
      ))}
    </div>
  );
}
