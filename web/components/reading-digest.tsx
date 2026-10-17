"use client";
import { useState, useTransition } from "react";
import { markDigestRead, refreshDigest } from "@/lib/actions";
import type { DigestView } from "@/lib/wendy";

/**
 * "Leituras do dia": the best new reading in ML/AI/science, picked by an explained rule (src/research/rank.ts). The text under each title is
 * the SOURCE's own abstract, shortened and labelled as such; Wendy writes nothing here. Links open the original in a new tab.
 */
const age = (iso: string | null) => {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? "há menos de 1 h" : h < 24 ? `há ${Math.floor(h)} h` : `há ${Math.floor(h / 24)} d`;
};

export function ReadingDigest({ digest, canWrite }: { digest: DigestView | null; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!digest) return <p className="text-muted">Não consegui ler as leituras agora. Elas continuam guardadas; tento de novo na próxima atualização da tela.</p>;
  const unread = digest.items.filter((i) => !i.read);
  const shown = digest.items.slice(0, 8);
  return (
    <div>
      <p className="text-sm text-muted">
        {digest.routine ? (digest.routine.enabled ? `Busca automática todo dia às ${digest.routine.localTime} (${digest.routine.timezone.replace("_", " ")}), com o Mac ligado.` : "Busca automática desativada.") : "Rotina ainda não ativada."}
        {digest.lastRun ? ` Última busca: ${digest.lastRun.date}${digest.lastRun.status === "FAILED" ? " (falhou)" : ""}.` : ""}
      </p>
      {shown.length ? (
        <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">
          {shown.map((i) => (
            <li key={i.id} className={`px-5 py-4 ${i.read ? "opacity-60" : ""}`}>
              <a href={i.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-accent lg:min-h-0">
                {i.title}
              </a>
              <span className="mt-0.5 block text-sm text-muted">
                {i.source}
                {i.publishedAt ? ` · ${age(i.publishedAt)}` : ""}
              </span>
              {i.summary ? (
                <span className="mt-2 block text-sm text-ink-2">
                  <span className="text-micro uppercase tracking-wide text-faint">Resumo da fonte · </span>
                  {i.summary}
                </span>
              ) : null}
              {i.why ? <span className="mt-1 block text-sm text-faint">Por que apareceu: {i.why}</span> : null}
              {canWrite && !i.read ? (
                <button type="button" disabled={pending} onClick={() => start(async () => { const r = await markDigestRead(i.id); setMsg(r.ok ? null : r.error); })} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-accent-ink hover:underline lg:min-h-8">
                  Marcar como lida
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">Ainda não há leituras. {digest.routine ? "A primeira busca roda no horário acima, ou toque em atualizar." : ""}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canWrite && digest.routine ? (
          <button type="button" disabled={pending} onClick={() => start(async () => { const r = await refreshDigest(); setMsg(r.ok ? "Leituras atualizadas." : r.error); })} className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-60 lg:min-h-9">
            {pending ? "Buscando…" : "Atualizar agora"}
          </button>
        ) : null}
        <a href="/briefing" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-ink hover:underline lg:min-h-9">
          Ver o briefing de IA (prévia)
        </a>
        <span className="text-sm text-faint">{unread.length ? `${unread.length} não ${unread.length === 1 ? "lida" : "lidas"}` : ""}</span>
        <span role="status" className="text-sm text-muted">
          {msg}
        </span>
      </div>
    </div>
  );
}
