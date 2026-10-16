"use client";
import { useId } from "react";
import { CONSENT_BODY, CONSENT_TITLE, micEnabled, micLabel, statusLine } from "@/lib/speech/copy";
import type { VoiceInfo, VoiceMachineState, VoicePreferences } from "@/lib/speech/types";

/** The microphone button, in the composer. Its name changes with the state; it is not pressable while a turn is out. */
export function MicButton({ kind, supported, onPress }: { kind: VoiceMachineState["kind"]; supported: boolean | null; onPress: () => void }) {
  const listening = kind === "LISTENING";
  const off = supported === false;
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={!micEnabled(kind) || supported === null}
      aria-label={off ? "Voz indisponível neste navegador" : micLabel(kind)}
      aria-pressed={listening}
      title={off ? "Este navegador não oferece reconhecimento de voz. Toque para ver o motivo." : micLabel(kind)}
      data-voice-state={kind}
      className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border text-sm transition-colors disabled:opacity-40 lg:min-h-9 lg:min-w-9 ${listening ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"} ${off ? "opacity-60" : ""}`}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="7" y="2.5" width="6" height="10" rx="3" />
        <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" />
      </svg>
    </button>
  );
}

/** Under the composer: what the voice is doing, the way out, the consent disclosure, and the settings. Silent when there is nothing to say. */
export function VoicePanel({
  state,
  supported,
  prefs,
  voices,
  askConsent,
  onConsent,
  onDecline,
  onCancel,
  onReset,
  onPrefs,
}: {
  state: VoiceMachineState;
  supported: boolean | null;
  prefs: VoicePreferences;
  voices: VoiceInfo[];
  askConsent: boolean;
  onConsent: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onReset: () => void;
  onPrefs: (p: Partial<VoicePreferences>) => void;
}) {
  const id = useId();
  const line = statusLine(state);
  const busy = state.kind === "LISTENING" || state.kind === "TRANSCRIBING" || state.kind === "SPEAKING" || state.kind === "INTERRUPTED";
  return (
    <div className="mt-1.5 px-1" data-voice-panel>
      {askConsent ? (
        <div role="alertdialog" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`} className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
          <p id={`${id}-t`} className="font-medium">
            {CONSENT_TITLE}
          </p>
          <p id={`${id}-b`} className="mt-1 text-ink-2">
            {CONSENT_BODY}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onConsent} className="inline-flex min-h-11 items-center rounded-full bg-accent px-4 text-sm font-medium text-bg lg:min-h-9">
              Entendi, ativar a voz
            </button>
            <button type="button" onClick={onDecline} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm text-ink-2 hover:bg-surface lg:min-h-9">
              Agora não
            </button>
          </div>
        </div>
      ) : null}

      <div role="status" aria-live="polite" className="min-h-5 text-micro text-ink-2">
        {line}
        {supported === false && !line ? <span className="text-muted">Voz indisponível neste navegador: você pode escrever normalmente.</span> : null}
      </div>

      {busy || state.kind === "ERROR" ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {state.kind === "SPEAKING" || state.kind === "LISTENING" || state.kind === "TRANSCRIBING" ? (
            <button type="button" onClick={onCancel} className="inline-flex min-h-11 items-center rounded-full border border-line px-3 text-xs text-ink-2 hover:bg-surface-2 lg:min-h-8">
              {state.kind === "SPEAKING" ? "Parar de falar" : "Descartar"}
            </button>
          ) : null}
          {state.kind === "ERROR" ? (
            <button type="button" onClick={onReset} className="inline-flex min-h-11 items-center rounded-full border border-line px-3 text-xs text-ink-2 hover:bg-surface-2 lg:min-h-8">
              Fechar aviso
            </button>
          ) : null}
        </div>
      ) : null}

      {supported ? (
        <details className="mt-1 text-xs text-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center lg:min-h-8">Configurar voz</summary>
          <div className="mt-1 grid gap-2 rounded-xl border border-line p-3 text-ink-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={prefs.speakReplies} onChange={(e) => onPrefs({ speakReplies: e.target.checked })} />
              Ler as respostas em voz alta (só quando a pergunta foi falada)
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={prefs.autoSend} onChange={(e) => onPrefs({ autoSend: e.target.checked })} />
              <span>
                Enviar sozinha depois de falar
                <span className="block text-muted">Desligado é o mais seguro: você revisa o texto, e uma palavra mal entendida não vira ordem.</span>
              </span>
            </label>
            <label className="grid gap-1">
              Volume
              <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => onPrefs({ volume: Number(e.target.value) })} />
            </label>
            <label className="grid gap-1">
              Velocidade
              <input type="range" min={0.5} max={2} step={0.1} value={prefs.rate} onChange={(e) => onPrefs({ rate: Number(e.target.value) })} />
            </label>
            {voices.length ? (
              <label className="grid gap-1">
                Voz
                <select value={prefs.voiceId ?? ""} onChange={(e) => onPrefs({ voiceId: e.target.value || null })} className="min-h-11 rounded-lg border border-line bg-transparent px-2 lg:min-h-8">
                  <option value="">Automática (português do Brasil)</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {v.lang}
                      {v.local ? "" : " · online"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" onClick={() => onPrefs({ consented: false })} className="inline-flex min-h-11 w-fit items-center rounded-full border border-line px-3 hover:bg-surface-2 lg:min-h-8">
              Retirar o consentimento da voz
            </button>
          </div>
        </details>
      ) : null}
    </div>
  );
}
