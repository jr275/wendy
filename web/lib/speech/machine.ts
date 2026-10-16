/**
 * The voice state machine: a pure reducer. (state, event) → (state, effects). No timers, no browser, no providers: the session manager
 * (session.ts) runs the effects and feeds the events back, so every path here is testable with plain data.
 *
 * Rules it enforces, so the UI and the providers cannot get them wrong:
 *  - the microphone is NEVER open while Wendy is speaking, and starts again only after speech has really stopped (no feedback loop);
 *  - nothing is sent to the conversation until the person has reviewed the transcript (unless they turned auto-send on);
 *  - a second press, a repeated final result or a late answer can never create a second turn or a second spoken reply;
 *  - an unavailable or blocked microphone is an ERROR in words — never a "listening" screen and never a pretend transcript.
 */
import { INTERRUPT_MS, NO_SPEECH_MS, THINK_MS, type VoiceEffect, type VoiceErrorCode, type VoiceEvent, type VoiceMachineState } from "./types";

export const INITIAL_VOICE_STATE: VoiceMachineState = {
  kind: "IDLE",
  turn: 0,
  micLive: false,
  interim: "",
  transcript: "",
  error: null,
  notice: null,
  lastFinalId: null,
  speakReplies: true,
  autoSend: false,
};

export interface Step {
  state: VoiceMachineState;
  effects: VoiceEffect[];
}

const RETRYABLE: Record<VoiceErrorCode, boolean> = { unsupported: false, permission: false, no_microphone: false, network: true, provider: true, reply_failed: true, timeout: true };
const same = (state: VoiceMachineState): Step => ({ state, effects: [] });

/** Leave whatever is going on and go to IDLE, stopping every activity that could still be running. */
function toIdle(s: VoiceMachineState, extra: Partial<VoiceMachineState> = {}): Step {
  const effects: VoiceEffect[] = [];
  if (s.kind === "LISTENING" || s.kind === "INTERRUPTED") effects.push({ type: "abortRecognition" });
  if (s.kind === "LISTENING") effects.push({ type: "clearTimer", timer: "noSpeech" });
  if (s.kind === "SPEAKING" || s.kind === "INTERRUPTED") effects.push({ type: "cancelSpeech" }, { type: "clearTimer", timer: "interrupt" });
  if (s.kind === "THINKING") effects.push({ type: "cancelTurn", turn: s.turn }, { type: "clearTimer", timer: "think" });
  return { state: { ...s, kind: "IDLE", micLive: false, interim: "", transcript: "", error: null, notice: null, ...(s.kind === "THINKING" ? { turn: s.turn + 1 } : {}), ...extra }, effects };
}

function toError(s: VoiceMachineState, code: VoiceErrorCode): Step {
  const idle = toIdle(s);
  return { state: { ...idle.state, kind: "ERROR", error: { code, retryable: RETRYABLE[code] } }, effects: idle.effects };
}

function startListening(s: VoiceMachineState, keepTranscript: boolean): Step {
  return {
    state: { ...s, kind: "LISTENING", micLive: false, interim: "", transcript: keepTranscript ? s.transcript : "", error: null, notice: null },
    effects: [{ type: "startRecognition" }],
  };
}

function submit(s: VoiceMachineState, text: string): Step {
  const turn = s.turn + 1;
  return {
    state: { ...s, kind: "THINKING", turn, micLive: false, interim: "", transcript: "", error: null, notice: null },
    effects: [{ type: "submit", text, turn }, { type: "startTimer", timer: "think", ms: THINK_MS }],
  };
}

function speakOrIdle(s: VoiceMachineState, turn: number, text: string): Step {
  const clean = text.trim();
  const base = { ...s, interim: "", transcript: "", micLive: false };
  if (!s.speakReplies || !clean) return { state: { ...base, kind: "IDLE" }, effects: [{ type: "clearTimer", timer: "think" }] };
  // The microphone is closed here and stays closed until speech has stopped.
  return { state: { ...base, kind: "SPEAKING" }, effects: [{ type: "clearTimer", timer: "think" }, { type: "abortRecognition" }, { type: "speak", text: clean, turn }] };
}

export function voiceReduce(s: VoiceMachineState, e: VoiceEvent): Step {
  // Events that mean the same in every state.
  if (e.type === "PREFS") {
    const next = { ...s, speakReplies: e.prefs.speakReplies, autoSend: e.prefs.autoSend };
    // Turning reading-aloud off while Wendy is speaking stops her at once.
    if (s.kind === "SPEAKING" && !e.prefs.speakReplies) return toIdle(next);
    return same(next);
  }
  if (e.type === "UNAVAILABLE") return toError(s, e.code);
  // CANCEL and RESET both mean "stop whatever is going on and go back to idle" (nothing is sent, nothing keeps running).
  if (e.type === "CANCEL" || e.type === "RESET") return s.kind === "IDLE" || s.kind === "ERROR" ? same({ ...s, kind: "IDLE", error: null, notice: null }) : toIdle(s);

  switch (s.kind) {
    case "IDLE":
    case "ERROR": {
      if (e.type === "MIC_PRESS") {
        if (s.kind === "ERROR" && s.error && !s.error.retryable) return same(s); // permission / unsupported: a press does not fix them
        return startListening(s, false);
      }
      return same(s); // late provider events after a cancel are ignored
    }

    case "LISTENING": {
      switch (e.type) {
        case "RECOGNITION_STARTED":
          return { state: { ...s, micLive: true }, effects: [{ type: "startTimer", timer: "noSpeech", ms: NO_SPEECH_MS }] };
        case "INTERIM":
          return { state: { ...s, interim: e.text }, effects: [] };
        case "FINAL": {
          if (e.id === s.lastFinalId) return same(s); // a repeated final result is not a second utterance
          const text = e.text.trim();
          const done = { ...s, lastFinalId: e.id, micLive: false, interim: "" };
          if (!text) return { state: { ...done, kind: "IDLE", notice: "no_speech" }, effects: [{ type: "clearTimer", timer: "noSpeech" }, { type: "abortRecognition" }] };
          const transcript = s.transcript ? `${s.transcript} ${text}` : text;
          const stop: VoiceEffect[] = [{ type: "clearTimer", timer: "noSpeech" }, { type: "abortRecognition" }];
          if (s.autoSend) {
            const t = submit({ ...done, transcript }, transcript);
            return { state: t.state, effects: [...stop, ...t.effects] };
          }
          return { state: { ...done, kind: "TRANSCRIBING", transcript }, effects: stop };
        }
        case "RECOGNITION_ENDED": {
          // The provider ended without a final result: what was heard so far is offered for review, never sent on its own.
          const heard = s.interim.trim();
          const base = { ...s, micLive: false, interim: "" };
          if (!heard) return { state: { ...base, kind: s.transcript ? "TRANSCRIBING" : "IDLE", notice: s.transcript ? null : "no_speech" }, effects: [{ type: "clearTimer", timer: "noSpeech" }] };
          const transcript = s.transcript ? `${s.transcript} ${heard}` : heard;
          return { state: { ...base, kind: "TRANSCRIBING", transcript }, effects: [{ type: "clearTimer", timer: "noSpeech" }] };
        }
        case "RECOGNITION_ERROR": {
          if (e.code === "aborted") return same(s); // we aborted it ourselves
          if (e.code === "no_speech") return { state: { ...s, kind: s.transcript ? "TRANSCRIBING" : "IDLE", micLive: false, interim: "", notice: s.transcript ? null : "no_speech" }, effects: [{ type: "clearTimer", timer: "noSpeech" }] };
          return toError(s, e.code);
        }
        case "TIMEOUT":
          if (e.timer !== "noSpeech") return same(s);
          return { state: { ...s, kind: s.transcript ? "TRANSCRIBING" : "IDLE", micLive: false, interim: "", notice: s.transcript ? null : "no_speech" }, effects: [{ type: "abortRecognition" }] };
        case "MIC_PRESS":
        case "STOP_PRESS":
          // A second press finishes listening: what was heard is delivered by the provider as a final (or ends empty).
          return { state: s, effects: [{ type: "stopRecognition" }] };
        default:
          return same(s);
      }
    }

    case "TRANSCRIBING": {
      switch (e.type) {
        case "TRANSCRIPT_EDITED":
          return same({ ...s, transcript: e.text });
        case "SEND": {
          const text = s.transcript.trim();
          if (!text) return same(s);
          return submit(s, text);
        }
        case "MIC_PRESS":
          return startListening(s, true); // keep what is there and add to it
        default:
          return same(s);
      }
    }

    case "THINKING": {
      switch (e.type) {
        case "REPLY":
          return e.turn === s.turn ? speakOrIdle(s, e.turn, e.text) : same(s); // an answer for an abandoned turn is dropped
        case "REPLY_FAILED":
          return e.turn === s.turn ? toError({ ...s }, "reply_failed") : same(s);
        case "TIMEOUT":
          return e.timer === "think" ? toError(s, "timeout") : same(s);
        default:
          return same(s); // a second press, a second SEND, a late recognition event: all ignored while the turn is out
      }
    }

    case "SPEAKING": {
      switch (e.type) {
        case "SPEECH_ENDED":
          return { state: { ...s, kind: "IDLE" }, effects: [] };
        case "SPEECH_ERROR":
          // The written answer is already on screen; losing the voice must not lose anything else.
          return { state: { ...s, kind: "IDLE", notice: "speech_failed" }, effects: [] };
        case "SPEECH_CANCELLED":
          return { state: { ...s, kind: "IDLE" }, effects: [] };
        case "MIC_PRESS":
        case "STOP_PRESS":
          // Barge-in: she stops first; the microphone opens only once speech has really stopped.
          return { state: { ...s, kind: "INTERRUPTED" }, effects: [{ type: "cancelSpeech" }, { type: "startTimer", timer: "interrupt", ms: INTERRUPT_MS }] };
        default:
          return same(s);
      }
    }

    case "INTERRUPTED": {
      if (e.type === "SPEECH_ENDED" || e.type === "SPEECH_CANCELLED" || e.type === "SPEECH_ERROR" || (e.type === "TIMEOUT" && e.timer === "interrupt")) {
        const l = startListening(s, false);
        return { state: l.state, effects: [{ type: "clearTimer", timer: "interrupt" }, ...l.effects] };
      }
      return same(s);
    }
  }
}
