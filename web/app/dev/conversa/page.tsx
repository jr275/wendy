import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TopBar } from "@/components/top-bar";
import { CHARACTERS } from "@/lib/characters";

/**
 * DEV ONLY — three visual options for the conversation, side by side, with the same fictional
 * example. Static: nothing here calls a model or reads Wendy's data, and the real conversation
 * (components/concierge/conversation.tsx) is not touched. ?theme=dark shows the dark theme.
 */
const EXAMPLE = [
  { from: "user", text: "Estou muito ansioso com essa viagem" },
  { from: "wendy", text: "Compreendo que você esteja ansioso com essa viagem. Podemos organizar o que está te preocupando ou olhar a agenda juntos. Quer começar por onde?" },
  { from: "user", text: "Quais são minhas tarefas?" },
  { from: "wendy", text: "Você tem 3 tarefas abertas. A mais antiga é “Revisar a proposta”." },
] as const;

const C = CHARACTERS.anxiety;
const accent = { "--char-accent": C.accent } as React.CSSProperties;

async function ThemeOverride({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  return (await searchParams).theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null;
}

function Frame({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mb-3 mt-1 text-sm text-muted">{note}</p>
      <div className="flex h-[620px] flex-col overflow-hidden rounded-3xl border border-line bg-surface/60 shadow-sm">{children}</div>
    </section>
  );
}

function Composer({ pill = true }: { pill?: boolean }) {
  return (
    <div className="border-t border-line/70 p-3">
      <div className={`flex items-end gap-2 border border-line bg-surface p-1.5 pl-4 ${pill ? "rounded-2xl" : "rounded-lg"}`}>
        <span className="flex-1 py-2 text-body text-faint">Pergunte ou peça algo à Wendy…</span>
        <span className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-bg opacity-40">Enviar</span>
      </div>
    </div>
  );
}

/* eslint-disable @next/next/no-img-element -- local avatars, static dev gallery */

/** A — classic chat: bubbles, a small avatar beside each Wendy message. */
function VariantA() {
  return (
    <Frame title="A · Chat clássico" note="Balões, avatar pequeno ao lado das respostas. O mais familiar.">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {EXAMPLE.map((m, i) =>
          m.from === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-body leading-snug text-bg">{m.text}</p>
            </div>
          ) : (
            <div key={i} className="flex items-end gap-2">
              <span className="char-slot" style={accent}>
                <span className="char" data-interaction="idle" data-size="primary">
                  <img src={C.src} alt="" width={36} height={36} draggable={false} />
                </span>
              </span>
              <p className="max-w-[80%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-2.5 text-body leading-relaxed text-ink">{m.text}</p>
            </div>
          ),
        )}
      </div>
      <Composer />
    </Frame>
  );
}

/** B — editorial: no bubbles, generous reading column, the character is a quiet header. */
function VariantB() {
  return (
    <Frame title="B · Editorial, limpo" note="Sem balões: texto largo e legível, rótulos “Você” e “Wendy”. Para quem lê muito.">
      <div className="flex items-center gap-3 border-b border-line/70 px-5 py-3">
        <span className="char-slot" style={accent}>
          <span className="char" data-interaction="idle" data-size="primary">
            <img src={C.src} alt="" width={40} height={40} draggable={false} />
          </span>
        </span>
        <div className="leading-tight">
          <p className="text-sm font-medium">Wendy</p>
          <p className="text-xs text-muted">percebi {C.label.toLowerCase()} · calma e objetiva</p>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {EXAMPLE.map((m, i) => (
          <div key={i}>
            <p className="eyebrow mb-1">{m.from === "user" ? "Você" : "Wendy"}</p>
            <p className={m.from === "user" ? "text-body leading-relaxed text-ink-2" : "text-lead leading-relaxed text-ink"}>{m.text}</p>
            {i < EXAMPLE.length - 1 ? <div className="mt-5 border-t border-line/60" /> : null}
          </div>
        ))}
      </div>
      <Composer pill={false} />
    </Frame>
  );
}

/** C — presence first: a large character band tinted with its colour; answers as soft cards. */
function VariantC() {
  const tint = { backgroundColor: "color-mix(in srgb, var(--char-accent) 9%, transparent)", borderColor: "color-mix(in srgb, var(--char-accent) 28%, transparent)" } as React.CSSProperties;
  return (
    <Frame title="C · Presença em destaque" note="Personagem grande no topo, cartões com a cor dele, balões do usuário em pílula. Mais emocional.">
      <div className="flex items-center gap-4 px-5 py-4" style={{ ...accent, backgroundColor: "color-mix(in srgb, var(--char-accent) 10%, transparent)" }}>
        <img src={C.src} alt="" width={84} height={84} draggable={false} className="rounded-full ring-2" style={{ boxShadow: `0 0 0 3px ${C.accent}55` }} />
        <div className="leading-snug">
          <p className="text-xs uppercase tracking-wide text-muted">Agora</p>
          <p className="text-lg font-semibold tracking-tight">{C.label}</p>
          <p className="text-sm text-ink-2">estou aqui com você</p>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" style={accent}>
        {EXAMPLE.map((m, i) =>
          m.from === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-full bg-ink px-4 py-2 text-body text-bg">{m.text}</p>
            </div>
          ) : (
            <p key={i} className="max-w-[92%] rounded-2xl border px-4 py-3 text-body leading-relaxed text-ink" style={tint}>
              {m.text}
            </p>
          ),
        )}
      </div>
      <Composer />
    </Frame>
  );
}

export default function ConversationVariants({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <Suspense fallback={null}>
        <ThemeOverride searchParams={searchParams} />
      </Suspense>
      <TopBar reasoner={null} wide />
      <main className="mx-auto max-w-7xl px-4 pb-24 pt-10 sm:px-6">
        <p className="eyebrow">Desenvolvimento · exemplo fictício</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Conversa — 3 variações</h1>
        <p className="mt-2 max-w-2xl text-muted">A mesma conversa de exemplo nos três estilos. Nada aqui chama o modelo nem usa seus dados, e a conversa real não foi alterada. Escolha uma (ou misture) e eu aplico.</p>
        <div className="mt-8 grid gap-8 lg:grid-cols-3">
          <VariantA />
          <VariantB />
          <VariantC />
        </div>
      </main>
    </>
  );
}
