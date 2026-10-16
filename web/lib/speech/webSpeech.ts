/**
 * Web Speech API adapters (the FIRST provider; the contracts in types.ts allow others, e.g. a realtime one, later).
 *
 * The `window` is injected so the adapters are tested against fakes. What they never do:
 *  - pretend: no recognition API → `availability()` says so; the error codes of the API are mapped, not swallowed;
 *  - leave a session running: every start has a single owner, and `abort()` really ends it;
 *  - read "network" as success: a recognition error is reported as an error.
 *
 * Privacy: in Chrome the recognition service usually sends the audio to the vendor's servers. The UI says so before the microphone is ever opened.
 */
import { chunkForSpeech } from "./reply";
import type { Availability, RecognitionCallbacks, RecognitionHandle, SpeakOptions, SpeechCallbacks, SpeechHandle, SpeechRecognitionProvider, SpeechSynthesisProvider, VoiceErrorCode, VoiceInfo } from "./types";

// Minimal structural types of the browser APIs (no `lib.dom` speech types are relied upon).
interface RecResult {
  isFinal: boolean;
  0: { transcript: string; confidence?: number };
}
interface RecEvent {
  resultIndex: number;
  results: ArrayLike<RecResult>;
}
interface RecErrorEvent {
  error: string;
}
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onaudiostart: (() => void) | null;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface UtteranceLike {
  lang: string;
  voice: unknown;
  rate: number;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}
export interface SpeechWindow {
  isSecureContext?: boolean;
  SpeechRecognition?: new () => RecognitionLike;
  webkitSpeechRecognition?: new () => RecognitionLike;
  SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
  speechSynthesis?: {
    speak(u: UtteranceLike): void;
    cancel(): void;
    getVoices(): VoiceLike[];
  };
}

/** The browser's error names → ours. Unknown names are "provider": reported, never ignored. */
export function mapRecognitionError(name: string): VoiceErrorCode | "no_speech" | "aborted" {
  switch (name) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission";
    case "audio-capture":
      return "no_microphone";
    case "network":
      return "network";
    case "no-speech":
      return "no_speech";
    case "aborted":
      return "aborted";
    case "language-not-supported":
    case "bad-grammar":
    default:
      return "provider";
  }
}

export function createWebSpeechRecognition(win: SpeechWindow): SpeechRecognitionProvider {
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  let sessions = 0;
  return {
    name: "web-speech",
    availability(): Availability {
      if (!Ctor) return { ok: false, reason: "unsupported" };
      if (win.isSecureContext === false) return { ok: false, reason: "insecure_context" };
      return { ok: true };
    },
    start(opts, cb: RecognitionCallbacks): RecognitionHandle {
      if (!Ctor) throw new Error("no recognition API");
      const rec = new Ctor();
      const session = ++sessions;
      rec.lang = opts.lang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let ended = false;
      let aborted = false;
      let finalCount = 0;
      rec.onaudiostart = () => !ended && cb.onStart();
      rec.onresult = (e) => {
        if (ended || aborted) return;
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]!;
          const text = r[0].transcript;
          if (r.isFinal) cb.onFinal(text, `${session}:${finalCount++}`);
          else interim += text;
        }
        if (interim) cb.onInterim(interim);
      };
      rec.onerror = (e) => {
        if (ended) return;
        const code = mapRecognitionError(e.error);
        if (aborted && code === "aborted") return;
        cb.onError(code);
      };
      rec.onend = () => {
        if (ended) return;
        ended = true;
        if (!aborted) cb.onEnd();
      };
      rec.start(); // throws if already started: the manager reports it as an error
      return {
        stop: () => {
          try {
            rec.stop();
          } catch {
            /* already over */
          }
        },
        abort: () => {
          aborted = true;
          try {
            rec.abort();
          } catch {
            /* already over */
          }
        },
      };
    },
  };
}

export const isPtBr = (lang: string) => /^pt[-_]BR$/i.test(lang);

/** pt-BR voices first, local ones before remote ones, then by name. */
export function orderVoices(voices: VoiceInfo[]): VoiceInfo[] {
  const rank = (v: VoiceInfo) => (isPtBr(v.lang) ? 0 : /^pt/i.test(v.lang) ? 1 : 2) * 2 + (v.local ? 0 : 1);
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function createWebSpeechSynthesis(win: SpeechWindow): SpeechSynthesisProvider {
  const synth = win.speechSynthesis;
  const Utter = win.SpeechSynthesisUtterance;
  const infoOf = (v: VoiceLike): VoiceInfo => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService });
  return {
    name: "web-speech",
    availability(): Availability {
      return synth && Utter ? { ok: true } : { ok: false, reason: "unsupported" };
    },
    voices() {
      return synth ? orderVoices(synth.getVoices().map(infoOf)) : [];
    },
    speak(text: string, opts: SpeakOptions, cb: SpeechCallbacks): SpeechHandle {
      if (!synth || !Utter) throw new Error("no synthesis API");
      synth.cancel(); // defensive: a stuck or overlapping utterance must not talk over this one
      const pieces = chunkForSpeech(text);
      const voices = synth.getVoices();
      const chosen = (opts.voiceId ? voices.find((v) => v.voiceURI === opts.voiceId) : undefined) ?? orderVoices(voices.map(infoOf)).map((i) => voices.find((v) => v.voiceURI === i.id)!).find((v) => isPtBr(v.lang));
      let cancelled = false;
      let done = false;
      let started = false;
      const finish = (kind: "end" | "cancelled" | "error") => {
        if (done) return;
        done = true;
        if (kind === "end") cb.onEnd();
        else if (kind === "cancelled") cb.onCancelled();
        else cb.onError();
      };
      const speakPiece = (i: number) => {
        if (cancelled) return;
        const u = new Utter(pieces[i]!);
        u.lang = opts.lang;
        if (chosen) u.voice = chosen;
        u.rate = opts.rate;
        u.volume = opts.volume;
        u.onstart = () => {
          if (!started) {
            started = true;
            cb.onStart();
          }
        };
        u.onend = () => (i + 1 < pieces.length ? speakPiece(i + 1) : finish("end"));
        u.onerror = (e) => {
          // "canceled" / "interrupted" are what a deliberate cancel() produces: not a failure.
          if (cancelled || e.error === "canceled" || e.error === "interrupted") finish("cancelled");
          else finish("error");
        };
        synth.speak(u);
      };
      if (!pieces.length) {
        finish("end");
        return { cancel: () => undefined };
      }
      speakPiece(0);
      return {
        cancel: () => {
          cancelled = true;
          synth.cancel();
          finish("cancelled");
        },
      };
    },
    cancel() {
      synth?.cancel();
    },
  };
}
