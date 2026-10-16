"use client";
import { useRef, useState } from "react";
import { Breakdown, Donut, Kpi } from "./charts";

/** Payloads emitted by Wendy's agent (src/agent/server.ts). Rendered as-is; nothing is computed here but display math. */
export interface AnswerPayload {
  question: string;
  answer: string;
  answerValid: boolean;
  models: string[];
  notClaude: boolean;
  claims: { label: string; kind: string; statement: string; confidence: number; evidence: string[] }[];
  rejectedClaims: number;
  evidence: { handle: string; kind: string; id: string; text: string; at: string | null }[];
  conflicts: { description: string; evidence: string[] }[];
  gaps: string[];
}

export interface SitePayload {
  label: string;
  siteUrl: string;
  importance: number | null;
  daily: { date: string; clicks: number; impressions: number }[];
  current: { start: string; end: string; clicks: number; impressions: number; ctr: number; position: number } | null;
  baseline: { start: string; end: string; clicks: number; impressions: number; ctr: number; position: number } | null;
  baselineWeekly: { clicks: number; impressions: number } | null;
  movers: { dimension: "page" | "query"; key: string; deltaClicks: number; deltaImpressions: number }[];
  direction: "DROP" | "RISE" | null;
  topPages?: { key: string; clicks: number }[];
}

const KIND: Record<string, { label: string; tone: string }> = {
  INFERENCE: { label: "Conclusão", tone: "bg-info-soft text-info" },
  HYPOTHESIS: { label: "Hipótese", tone: "bg-warn-soft text-warn" },
  ANTICIPATION: { label: "Antecipação", tone: "bg-accent-soft text-accent-ink" },
  RECOMMENDATION: { label: "Recomendação", tone: "bg-accent-soft text-accent-ink" },
};
const SOURCE: Record<string, string> = { search_metric: "Search Console", message: "E-mail", meeting: "Reunião", commitment: "Compromisso", memory: "Memória", person: "Pessoa", event: "Pergunta", insight: "Insight anterior" };

const strip = (s: string) => s.replace(/\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\]/g, "");
const n = (x: number) => Math.round(x).toLocaleString("pt-BR");
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** `proofOnly` hides the answer text when the chat already shows it right above. */
export function AnswerCard({ a, proofOnly = false }: { a: AnswerPayload; proofOnly?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const byHandle = new Map(a.evidence.map((e) => [e.handle, e]));
  return (
    <article className="card p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">{proofOnly ? "Como a Wendy verificou" : "Resposta"}</span>
        {a.notClaude ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">{a.models.join(", ")} · não é o Claude</span> : null}
      </div>
      {proofOnly ? null : (() => {
        // Lead with the first sentence; the rest at reading size.
        const text = strip(a.answer) || "Não encontrei evidência suficiente para responder com segurança.";
        const cut = text.search(/[.!?](\s|$)/);
        const lead = cut > 0 ? text.slice(0, cut + 1) : text;
        const rest = cut > 0 ? text.slice(cut + 1).trim() : "";
        return (
          <>
            <p className="mt-4 text-xl font-medium leading-snug tracking-tight sm:text-2xl">{lead}</p>
            {rest ? <p className="mt-3 max-w-3xl text-[16px] leading-relaxed text-ink-2">{rest}</p> : null}
          </>
        );
      })()}
      {!a.answerValid && !proofOnly ? <p className="mt-2 text-sm text-warn">O texto livre não passou na validação; acima estão só as afirmações comprovadas.</p> : null}

      {a.claims.length ? (
        <section className={proofOnly ? "mt-4" : "mt-8"}>
          {proofOnly ? null : <h3 className="eyebrow">Por que eu digo isso</h3>}
          <ul className="mt-3 grid gap-3">
            {a.claims.map((c) => (
              <li key={c.label} className="rounded-2xl border border-line-2 bg-surface-2/50 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 ${KIND[c.kind]?.tone ?? "bg-surface-2 text-ink-2"}`}>{KIND[c.kind]?.label ?? c.kind}</span>
                  <span className="num text-faint">confiança {c.confidence.toFixed(2)}</span>
                </div>
                <p className="mt-2 leading-relaxed">{c.statement}</p>
                {c.evidence.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {c.evidence
                      .filter((h) => byHandle.has(h))
                      .map((h) => {
                        const e = byHandle.get(h)!;
                        const key = `${c.label}:${h}`;
                        return (
                          <button
                            key={h}
                            type="button"
                            onClick={() => setOpen(open === key ? null : key)}
                            aria-expanded={open === key}
                            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${open === key ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:border-accent"}`}
                          >
                            {SOURCE[e.kind] ?? e.kind} · <span className="num">{h}</span>
                          </button>
                        );
                      })}
                  </div>
                ) : null}
                {c.evidence.map((h) =>
                  open === `${c.label}:${h}` && byHandle.get(h) ? (
                    <pre key={h} className="mt-3 whitespace-pre-wrap rounded-xl bg-surface px-3 py-2 text-xs leading-relaxed text-ink-2 [font-family:var(--font-geist-mono)]">
                      {byHandle.get(h)!.text}
                    </pre>
                  ) : null,
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {a.conflicts.length ? (
        <section className="mt-6 rounded-2xl bg-warn-soft p-4 text-sm text-warn">
          <p className="font-medium">As fontes se contradizem</p>
          <ul className="mt-1 list-disc pl-5">{a.conflicts.map((c, i) => <li key={i}>{c.description}</li>)}</ul>
        </section>
      ) : null}

      {a.gaps.length ? (
        <section className="mt-6">
          <h3 className="eyebrow">O que eu não sei</h3>
          <ul className="mt-2 grid gap-1.5 text-body text-ink-2">{a.gaps.map((g, i) => <li key={i}>— {g}</li>)}</ul>
        </section>
      ) : null}

      <p className="mt-6 text-xs text-faint">
        {a.claims.length} afirmação(ões) validada(s) contra {a.evidence.length} fonte(s){a.rejectedClaims ? ` · ${a.rejectedClaims} descartada(s) pela validação` : ""}.
      </p>
    </article>
  );
}

/** Daily clicks with the two compared windows shaded; hover shows the day and its clicks. */
function SiteChart({ s }: { s: SitePayload }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const w = 640;
  const h = 160;
  // Focus on what is compared: one week before the baseline through the latest day.
  const from = s.baseline ? new Date(Date.parse(s.baseline.start) - 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const pts = from ? s.daily.filter((d) => d.date >= from) : s.daily;
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((p) => p.clicks), 1);
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - 4 - (v / max) * (h - 16);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.clicks).toFixed(1)}`).join(" ");
  const idx = (d: string) => pts.findIndex((p) => p.date === d);
  const band = (from?: string, to?: string) => {
    if (!from || !to) return null;
    const a = idx(from);
    const b = idx(to);
    return a >= 0 && b >= 0 ? { x: x(a), w: Math.max(2, x(b) - x(a)) } : null;
  };
  const base = band(s.baseline?.start, s.baseline?.end);
  const cur = band(s.current?.start, s.current?.end);
  // Red only for a drop as large as the detector's alarm threshold (−20%); smaller moves stay neutral.
  const alarm = s.current && s.baselineWeekly ? (s.current.clicks - s.baselineWeekly.clicks) / s.baselineWeekly.clicks <= -0.2 : false;
  const tone = alarm ? "var(--bad)" : "var(--brand)";
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))));
  };
  const hp = hover !== null ? pts[hover]! : null;
  return (
    <figure className="relative mt-6">
      <svg ref={ref} viewBox={`0 0 ${w} ${h}`} className="h-40 w-full touch-none" preserveAspectRatio="none" role="img" aria-label={`Cliques diários de ${s.label}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {base ? <rect x={base.x} y={0} width={base.w} height={h} fill="var(--surface-2)" /> : null}
        {cur ? <rect x={cur.x} y={0} width={cur.w} height={h} fill={alarm ? "var(--bad-soft)" : "var(--accent-soft)"} /> : null}
        <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={tone} opacity={0.08} />
        <path d={line} fill="none" stroke={tone} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hp ? <line x1={x(hover!)} x2={x(hover!)} y1={0} y2={h} stroke="var(--subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="3 3" /> : null}
      </svg>
      {hp ? (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm"
          style={{ left: `${Math.min(88, Math.max(12, (hover! / (pts.length - 1)) * 100))}%` }}
        >
          <span className="text-muted">{dm(hp.date)}</span> · <span className="num font-semibold">{n(hp.clicks)}</span> cliques
        </div>
      ) : null}
      <figcaption className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
        <span>
          {dm(pts[0]!.date)} – {dm(pts[pts.length - 1]!.date)} · cliques por dia
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-surface-2 ring-1 ring-line" />base (28 dias)</span>
          <span className="flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${alarm ? "bg-bad-soft" : "bg-accent-soft"} ring-1 ring-line`} />última semana</span>
        </span>
      </figcaption>
    </figure>
  );
}


const path = (k: string) => k.replace(/^https?:\/\/(www\.)?[^/]+/, "") || "/";

export function SiteCard({ s }: { s: SitePayload }) {
  const pct = (cur?: number, base?: number) => (cur === undefined || !base ? null : ((cur - base) / base) * 100);
  const cp = pct(s.current?.clicks, s.baselineWeekly?.clicks);
  const ip = pct(s.current?.impressions, s.baselineWeekly?.impressions);
  const low = s.baselineWeekly !== null && s.baselineWeekly.clicks < 20;
  const alarm = cp !== null && cp <= -20 && !low;
  const fmtPct = (x: number | null) => (x === null ? null : `${x > 0 ? "+" : ""}${x.toFixed(1).replace(".", ",")}%`);
  const moved = s.movers.reduce((a, m) => a + Math.abs(m.deltaImpressions), 0);
  const pages = s.topPages ?? [];
  return (
    <article className="card p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="eyebrow">Site · Google Search Console</span>
          <h3 className="mt-1 text-2xl font-semibold tracking-tight">{s.label}</h3>
        </div>
        <span className="text-sm text-muted">{s.current ? `${dm(s.current.start)}–${dm(s.current.end)} vs. ${s.baseline ? `${dm(s.baseline.start)}–${dm(s.baseline.end)}` : "—"}` : ""}</span>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-[1.3fr_1fr]">
        <Kpi
          label="Cliques · últimos 7 dias"
          value={s.current ? n(s.current.clicks) : "—"}
          change={fmtPct(cp)}
          changeLabel={`vs. média de ${s.baselineWeekly ? n(s.baselineWeekly.clicks) : "—"} por semana`}
          alarm={alarm}
          note={low ? "Volume baixo — as variações percentuais não são conclusivas." : undefined}
        />
        <dl className="grid grid-cols-1 gap-3 self-end">
          <div>
            <dt className="eyebrow">Impressões</dt>
            <dd className="num mt-0.5 text-lg font-semibold">
              {s.current ? n(s.current.impressions) : "—"} <span className={`text-sm font-normal ${ip !== null && ip <= -20 && !low ? "text-bad" : "text-muted"}`}>{fmtPct(ip)}</span>
            </dd>
          </div>
          <div>
            <dt className="eyebrow">CTR</dt>
            <dd className="num mt-0.5 text-lg font-semibold">
              {s.current ? `${(s.current.ctr * 100).toFixed(2)}%` : "—"} <span className="text-sm font-normal text-muted">antes {s.baseline ? `${(s.baseline.ctr * 100).toFixed(2)}%` : "—"}</span>
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Posição média</dt>
            <dd className="num mt-0.5 text-lg font-semibold">
              {s.current ? s.current.position.toFixed(1) : "—"} <span className="text-sm font-normal text-muted">antes {s.baseline ? s.baseline.position.toFixed(1) : "—"}</span>
            </dd>
          </div>
        </dl>
      </div>

      <SiteChart s={s} />

      {s.movers.length || pages.length ? (
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          {s.movers.length ? (
            <section>
              <h4 className="font-medium">{s.direction === "DROP" ? "Onde mais caiu" : "Onde mais subiu"}</h4>
              <p className="mt-0.5 text-xs text-muted">impressões por semana · parte da variação entre os {s.movers.length} maiores</p>
              <div className="mt-4">
                <Breakdown
                  ariaLabel={s.direction === "DROP" ? "Onde as impressões mais caíram" : "Onde as impressões mais subiram"}
                  tone={s.direction === "DROP" ? "bad" : "good"}
                  items={s.movers.map((m) => ({
                    label: m.dimension === "page" ? path(m.key) : m.key,
                    tag: m.dimension === "page" ? "página" : "busca",
                    share: moved ? Math.abs(m.deltaImpressions) / moved : 0,
                    value: `${m.deltaImpressions > 0 ? "+" : ""}${n(m.deltaImpressions)}`,
                    note: Math.abs(m.deltaClicks) < 0.5 ? "cliques praticamente iguais" : `${m.deltaClicks > 0 ? "+" : "−"}${n(Math.abs(m.deltaClicks))} cliques por semana`,
                  }))}
                />
              </div>
              <p className="mt-3 text-xs text-faint">Só aparecem páginas e buscas presentes nas duas janelas; o restante da variação está espalhado por outras.</p>
            </section>
          ) : null}
          {pages.length ? (
            <section>
              <h4 className="font-medium">De onde vêm os cliques</h4>
              <p className="mt-0.5 text-xs text-muted">últimos 7 dias, por página</p>
              <div className="mt-4">
                <Donut
                  ariaLabel={`Cliques de ${s.label} por página nos últimos 7 dias`}
                  centerValue={s.current ? n(s.current.clicks) : "—"}
                  centerLabel="cliques"
                  items={pages.map((p) => ({ label: p.key ? path(p.key) : "outras páginas", value: p.clicks, valueLabel: n(p.clicks), other: !p.key }))}
                />
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
