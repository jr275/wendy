/**
 * Conversational voice — contracts. Nothing here touches the browser, React or the network.
 *
 * (Not to be confused with `src/voice/`, which is Wendy's PHONE-call feature with a counterparty. This is the principal talking WITH Wendy
 * in the conversation: the transcript goes into the same thread "main", the same agent, the same memory and the same approvals.)
 *
 * Providers are interfaces so the Web Speech API is only the first one: a realtime provider (Gemini Live) can be added later behind the same
 * contracts without touching the state machine or the UI.
 */
export const VOICE_STATES = ["IDLE", "LISTENING", "TRANSCRIBING", "THINKING", "SPEAKING", "INTERRUPTED", "ERROR"] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

/** Why voice could not work. Each is said to the person in words; none is ever turned into a pretend success. */
export type VoiceErrorCode =
  | "unsupported" // this browser has no recognition API
  | "permission" // microphone blocked or not allowed
  | "no_microphone" // no capture device
  | "network" // the recognition service could not be reached
  | "provider" // the provider failed in a way we cannot classify
  | "reply_failed" // the conversation turn failed, so there is nothing to speak
  | "timeout"; // the turn took too long

export interface VoiceErrorInfo {
  code: VoiceErrorCode;
  /** Retrying can help (a new press). Permission and unsupported do not heal by pressing again. */
  retryable: boolean;
}

export type Availability = { ok: true } | { ok: false; reason: "unsupported" | "insecure_context" };

/** Recognition (speech to text). */
export interface RecognitionCallbacks {
  /** Audio capture really began (after any permission prompt). Until then the microphone is NOT live. */
  onStart(): void;
  onInterim(text: string): void;
  /** `id` identifies one final utterance, so a provider that repeats it cannot cause a second turn. */
  onFinal(text: string, id: string): void;
  onError(code: VoiceErrorCode | "no_speech" | "aborted"): void;
  /** The session is over (after a final, an error, stop or abort). */
  onEnd(): void;
}
export interface RecognitionHandle {
  /** Finish: deliver what was heard so far as a final result. */
  stop(): void;
  /** Discard: no result is delivered. */
  abort(): void;
}
export interface SpeechRecognitionProvider {
  readonly name: string;
  availability(): Availability;
  start(opts: { lang: string }, cb: RecognitionCallbacks): RecognitionHandle;
}

/** Synthesis (text to speech). */
export interface SpeechCallbacks {
  onStart(): void;
  /** Spoken to the end. */
  onEnd(): void;
  /** Stopped on purpose (cancel / barge-in): NOT an error. */
  onCancelled(): void;
  onError(): void;
}
export interface SpeechHandle {
  cancel(): void;
}
export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
  local: boolean;
}
export interface SpeakOptions {
  lang: string;
  voiceId: string | null;
  rate: number;
  volume: number;
}
export interface SpeechSynthesisProvider {
  readonly name: string;
  availability(): Availability;
  voices(): VoiceInfo[];
  speak(text: string, opts: SpeakOptions, cb: SpeechCallbacks): SpeechHandle;
  /** Stops anything this provider is saying. Safe to call when idle. */
  cancel(): void;
}

/** What the person chose. Per device; kept in this browser only. */
export interface VoicePreferences {
  version: 1;
  /** The person read how audio is handled and agreed. The microphone is never opened before this. */
  consented: boolean;
  /** Read Wendy's answers aloud — only for turns that were started by voice. */
  speakReplies: boolean;
  /** Send right after the transcript instead of waiting for the person to review it. OFF by default: a misheard word must not become an instruction. */
  autoSend: boolean;
  voiceId: string | null;
  rate: number; // 0.5 – 2
  volume: number; // 0 – 1
  lang: "pt-BR";
}

export type VoiceEvent =
  | { type: "MIC_PRESS" }
  | { type: "STOP_PRESS" }
  | { type: "CANCEL" }
  | { type: "UNAVAILABLE"; code: VoiceErrorCode }
  | { type: "RECOGNITION_STARTED" }
  | { type: "INTERIM"; text: string }
  | { type: "FINAL"; text: string; id: string }
  | { type: "RECOGNITION_ENDED" }
  | { type: "RECOGNITION_ERROR"; code: VoiceErrorCode | "no_speech" | "aborted" }
  | { type: "TRANSCRIPT_EDITED"; text: string }
  | { type: "SEND" }
  | { type: "REPLY"; turn: number; text: string }
  | { type: "REPLY_FAILED"; turn: number }
  | { type: "SPEECH_STARTED" }
  | { type: "SPEECH_ENDED" }
  | { type: "SPEECH_CANCELLED" }
  | { type: "SPEECH_ERROR" }
  | { type: "TIMEOUT"; timer: TimerName }
  | { type: "PREFS"; prefs: Pick<VoicePreferences, "speakReplies" | "autoSend"> }
  | { type: "RESET" };

export type TimerName = "noSpeech" | "think" | "interrupt";

export type VoiceEffect =
  | { type: "startRecognition" }
  | { type: "stopRecognition" }
  | { type: "abortRecognition" }
  | { type: "speak"; text: string; turn: number }
  | { type: "cancelSpeech" }
  /** Hand the text to the conversation (the same send the keyboard uses). `turn` names it, so a stale answer can be told apart. */
  | { type: "submit"; text: string; turn: number }
  | { type: "cancelTurn"; turn: number }
  | { type: "startTimer"; timer: TimerName; ms: number }
  | { type: "clearTimer"; timer: TimerName };

export interface VoiceMachineState {
  kind: VoiceState;
  /** Increments for every turn handed to the conversation, and when a turn is abandoned. An answer for an older turn is ignored. */
  turn: number;
  /** LISTENING only: the microphone is really capturing. False while the browser's permission prompt is open. */
  micLive: boolean;
  /** What is being heard right now (not final). */
  interim: string;
  /** The text awaiting review/sending (TRANSCRIBING) — editable. */
  transcript: string;
  error: VoiceErrorInfo | null;
  /** A short note, not an error ("não ouvi nada"). Cleared by the next press. */
  notice: "no_speech" | "speech_failed" | null;
  lastFinalId: string | null;
  speakReplies: boolean;
  autoSend: boolean;
}

export const NO_SPEECH_MS = 10_000;
export const THINK_MS = 120_000;
export const INTERRUPT_MS = 1_200;
