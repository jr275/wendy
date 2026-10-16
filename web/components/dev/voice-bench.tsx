"use client";
/* eslint-disable react-hooks/set-state-in-effect -- dev bench: it reads what this browser offers once, on mount */
import { useEffect, useRef, useState } from "react";
import { MicButton } from "@/components/concierge/voice-controls";
import { micLabel, statusLine } from "@/lib/speech/copy";
import { INITIAL_VOICE_STATE } from "@/lib/speech/machine";
import { DEFAULT_VOICE_PREFS } from "@/lib/speech/prefs";
import { VoiceSession } from "@/lib/speech/session";
import type { RecognitionCallbacks, SpeechCallbacks, VoiceInfo, VoiceMachineState, VoicePreferences } from "@/lib/speech/types";
import { createWebSpeechRecognition, createWebSpeechSynthesis, type SpeechWindow } from "@/lib/speech/webSpeech";

/**
 * DEV ONLY — a bench to validate the REAL browser providers with a real microphone. The recognizer and the speech are the real Web Speech
 * providers and the machine is the real one. The "reply" is an echo labelled as a TEST, so nothing is sent to Wendy or to a model.
 * It logs every provider callback and state change with a timestamp, so what really happened can be read afterwards.
 */
type Row = { t: string; text: string };

export function VoiceBench() {
  const [state, setState] = useState<VoiceMachineState>(INITIAL_VOICE_STATE);
  const [rows, setRows] = useState<Row[]>([]);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [consented, setConsented] = useState(false);
  const [voiceId, setVoiceId] = useState<string>("");
  const [volume, setVolume] = useState(1);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState("");
  const session = useRef<VoiceSession | null>(null);
  const speakTest = useRef<((text: string) => void) | null>(null);
  const lastKind = useRef<string>("IDLE");
  const prefs = useRef<VoicePreferences>(DEFAULT_VOICE_PREFS);
  const log = (text: string) => setRows((r) => [...r, { t: new Date().toLocaleTimeString("pt-BR", { hour12: false }) + "." + String(Date.now() % 1000).padStart(3, "0"), text }].slice(-80));

  useEffect(() => {
    prefs.current = { ...DEFAULT_VOICE_PREFS, consented, speakReplies, volume, voiceId: voiceId || null };
    session.current?.setPrefs();
  }, [consented, speakReplies, volume, voiceId]);

  useEffect(() => {
    const win = window as unknown as SpeechWindow;
    const rec = createWebSpeechRecognition(win);
    const synth = createWebSpeechSynthesis(win);
    // Wrap the real providers only to LOG what they report; behaviour is unchanged.
    const loggedRec = {
      ...rec,
      start: (o: { lang: string }, cb: RecognitionCallbacks) =>
        rec.start(o, {
          onStart: () => (log("reconhecimento: captura de áudio começou (microfone ao vivo)"), cb.onStart()),
          onInterim: (t) => (log(`reconhecimento: parcial «${t}»`), cb.onInterim(t)),
          onFinal: (t, id) => (log(`reconhecimento: FINAL «${t}» (${id})`), cb.onFinal(t, id)),
          onError: (c) => (log(`reconhecimento: ERRO ${c}`), cb.onError(c)),
          onEnd: () => (log("reconhecimento: terminou"), cb.onEnd()),
        }),
    };
    const loggedSynth = {
      ...synth,
      speak: (text: string, o: Parameters<typeof synth.speak>[1], cb: SpeechCallbacks) =>
        synth.speak(text, o, {
          onStart: () => (log("fala: começou"), cb.onStart()),
          onEnd: () => (log("fala: terminou"), cb.onEnd()),
          onCancelled: () => (log("fala: cancelada"), cb.onCancelled()),
          onError: () => (log("fala: ERRO"), cb.onError()),
        }),
    };
    const s = new VoiceSession({
      recognition: loggedRec,
      synthesis: loggedSynth,
      prefs: () => prefs.current,
      submit: (text, turn) => {
        log(`CONVERSA (de teste): enviaria «${text}» como turno ${turn}`);
        // A clearly labelled TEST reply, so the speaking path can be exercised without Wendy or a model.
        setTimeout(() => s.dispatch({ type: "REPLY", turn, text: `Resposta de teste, não é a Wendy. Você disse: ${text}.` }), 400);
      },
      cancelTurn: (turn) => log(`CONVERSA (de teste): turno ${turn} abandonado`),
      onChange: (st) => {
        // Logged here, not inside a state updater (React may run an updater twice in development).
        if (lastKind.current !== st.kind) log(`estado: ${lastKind.current} → ${st.kind}${st.error ? ` (${st.error.code})` : ""}`);
        lastKind.current = st.kind;
        setState(st);
        if (st.kind === "TRANSCRIBING") setDraft(st.transcript);
      },
    });
    session.current = s;
    // The speech provider alone (no microphone, not through the machine): proves the real text-to-speech path by itself.
    speakTest.current = (text) => {
      try {
        loggedSynth.speak(text, { lang: "pt-BR", voiceId: prefs.current.voiceId, rate: 1, volume: prefs.current.volume }, { onStart: () => undefined, onEnd: () => undefined, onCancelled: () => undefined, onError: () => undefined });
      } catch {
        log("fala: o navegador recusou iniciar a fala");
      }
    };
    const ok = rec.availability();
    const sy = synth.availability();
    setEnv({
      "reconhecimento (STT)": ok.ok ? "disponível" : `indisponível (${ok.reason})`,
      "síntese (TTS)": sy.ok ? "disponível" : "indisponível",
      "contexto seguro": String((window as { isSecureContext?: boolean }).isSecureContext),
      navegador: navigator.userAgent.replace(/\s+/g, " ").slice(0, 110),
    });
    const loadVoices = () => setVoices(synth.voices());
    loadVoices();
    const synthTarget = win.speechSynthesis as unknown as EventTarget | undefined;
    if (synthTarget && typeof synthTarget.addEventListener === "function") synthTarget.addEventListener("voiceschanged", loadVoices); // voices load after the page does
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then((p) => setEnv((e) => ({ ...e, "permissão do microfone": p.state }))).catch(() => setEnv((e) => ({ ...e, "permissão do microfone": "não consultável" })));
    return () => {
      if (synthTarget && typeof synthTarget.removeEventListener === "function") synthTarget.removeEventListener("voiceschanged", loadVoices);
      s.dispose();
    };
  }, []);

  const pressMic = () => session.current?.pressMic();
  const line = statusLine(state);
  return (
    <div className="grid gap-6">
      <section aria-label="Comece aqui" className="card border-accent/40 p-5">
        <h2 className="eyebrow mb-3">Comece aqui</h2>
        <ol className="grid gap-1 text-sm text-ink-2">
          <li>1. Marque a caixinha abaixo: <strong>&quot;Entendo que o Chrome costuma enviar o áudio…&quot;</strong></li>
          <li>2. Clique no botão verde grande.</li>
          <li>3. O Chrome vai mostrar um aviso <strong>no canto superior esquerdo</strong>, perguntando pelo microfone: clique em <strong>Permitir ao visitar o site</strong>.</li>
          <li>4. Fale uma frase curta em português.</li>
        </ol>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
          <span>Entendo que o Chrome costuma enviar o áudio ao Google para transcrever. Esta bancada não envia nada à Wendy nem a um modelo.</span>
        </label>
        <button
          type="button"
          onClick={pressMic}
          disabled={!consented}
          data-testid="big-mic"
          className="mt-4 inline-flex min-h-14 items-center gap-3 rounded-full bg-accent px-8 text-lg font-semibold text-bg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="7" y="2.5" width="6" height="10" rx="3" />
            <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" />
          </svg>
          {state.kind === "LISTENING" ? "Parar de ouvir" : state.kind === "SPEAKING" ? "Interromper e falar" : "Clique aqui e fale"}
        </button>
        {!consented ? <p className="mt-2 text-sm text-muted">O botão fica apagado até você marcar a caixinha acima.</p> : null}
        <p role="status" aria-live="polite" className="mt-3 min-h-6 text-sm font-medium text-ink-2" data-testid="big-status">
          {statusLine(state) ?? ""}
        </p>
      </section>

      <section aria-label="Ambiente" className="card p-5">
        <h2 className="eyebrow mb-3">1 · O que este navegador oferece</h2>
        <dl className="grid gap-1 text-sm">
          {Object.entries(env).map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-48 shrink-0 text-muted">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
          <div className="flex gap-3">
            <dt className="w-48 shrink-0 text-muted">vozes em pt-BR</dt>
            <dd>{voices.filter((v) => /^pt[-_]BR/i.test(v.lang)).map((v) => v.name + (v.local ? "" : " (online)")).join(", ") || "nenhuma"}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="Consentimento" className="card p-5">
        <h2 className="eyebrow mb-3">2 · Consentimento</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
          <span>Entendo que o Chrome costuma enviar o áudio ao Google para transcrever. Esta bancada não envia nada à Wendy nem a um modelo.</span>
        </label>
      </section>

      <section aria-label="Microfone" className="card p-5">
        <h2 className="eyebrow mb-3">3 · Microfone, transcrição e fala</h2>
        <div className="flex flex-wrap items-center gap-3">
          <MicButton kind={state.kind} supported={env["reconhecimento (STT)"] === undefined ? null : env["reconhecimento (STT)"] === "disponível"} onPress={pressMic} />
          <span className="num rounded-full bg-surface-2 px-3 py-1 text-sm" data-testid="voice-state">
            {state.kind}
            {state.kind === "LISTENING" ? (state.micLive ? " · microfone ao vivo" : " · aguardando permissão") : ""}
          </span>
          <button type="button" className="rounded-full border border-line px-3 py-1.5 text-sm" onClick={() => session.current?.dispatch({ type: "CANCEL" })}>
            Cancelar
          </button>
          <button type="button" className="rounded-full border border-line px-3 py-1.5 text-sm" onClick={() => session.current?.dispatch({ type: "RESET" })}>
            Limpar erro
          </button>
          <button type="button" className="rounded-full border border-line px-3 py-1.5 text-sm" data-testid="speak-test" onClick={() => speakTest.current?.("Olá, eu sou a Wendy. Este é um teste da minha voz em português do Brasil.")}>
            Testar só a fala
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-3 min-h-6 text-sm text-ink-2">
          {line ?? <span className="text-faint">{micLabel(state.kind)}.</span>}
        </p>
        <label className="mt-3 grid gap-1 text-sm">
          Texto para revisar (o que foi ouvido aparece aqui; editável)
          <textarea
            className="min-h-20 rounded-xl border border-line bg-transparent p-3"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              session.current?.dispatch({ type: "TRANSCRIPT_EDITED", text: e.target.value });
            }}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-40" disabled={state.kind !== "TRANSCRIBING"} onClick={() => session.current?.dispatch({ type: "SEND" })}>
            Enviar (resposta de teste)
          </button>
        </div>
      </section>

      <section aria-label="Fala" className="card p-5">
        <h2 className="eyebrow mb-3">4 · Preferências de fala</h2>
        <div className="grid gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} />
            Ler a resposta em voz alta
          </label>
          <label className="grid gap-1">
            Volume ({volume})
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
          <label className="grid gap-1">
            Voz
            <select className="min-h-9 rounded-lg border border-line bg-transparent px-2" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              <option value="">Automática (pt-BR)</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.lang}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section aria-label="Registro" className="card p-5">
        <h2 className="eyebrow mb-3">5 · Registro do que aconteceu (copie e me envie se algo falhar)</h2>
        <button
          type="button"
          data-testid="copy-log"
          className="mb-3 inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-bg"
          onClick={async () => {
            const text = [`NAVEGADOR: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" | ")}`, `ESTADO ATUAL: ${state.kind}${state.error ? ` (${state.error.code})` : ""}`, ...rows.map((r) => `${r.t}  ${r.text}`)].join("\n");
            try {
              await navigator.clipboard.writeText(text);
              setCopied("Copiado. Agora cole na conversa com a Wendy (Cmd+V).");
            } catch {
              setCopied("Não consegui copiar sozinho: selecione o texto abaixo e copie com Cmd+C.");
            }
          }}
        >
          Copiar registro
        </button>
        {copied ? <p role="status" className="mb-3 text-sm text-ink-2">{copied}</p> : null}
        <ol className="max-h-72 overflow-y-auto font-mono text-xs leading-relaxed" data-testid="voice-log">
          {rows.length ? rows.map((r, i) => <li key={i}>{`${r.t}  ${r.text}`}</li>) : <li className="text-faint">Nada ainda.</li>}
        </ol>
      </section>
    </div>
  );
}
