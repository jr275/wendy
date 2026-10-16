/**
 * The voice session manager: the imperative shell around the pure state machine (machine.ts).
 *
 * It owns the providers, the timers and the queue; the machine owns every decision. The manager:
 *  - runs the machine's effects against the providers and feeds the providers' callbacks back as events;
 *  - checks availability BEFORE starting, so an unavailable microphone is an error and never a "listening" screen;
 *  - ignores callbacks of a recognition/speech session that is no longer current (a late event after a cancel cannot start a turn or a loop);
 *  - processes events one at a time (an event raised while an effect runs is queued), so effects never interleave.
 * Everything it needs from the outside is injected: providers, timers and the function that hands text to the conversation.
 */
import { INITIAL_VOICE_STATE, voiceReduce } from "./machine";
import type { RecognitionHandle, SpeechHandle, SpeechRecognitionProvider, SpeechSynthesisProvider, TimerName, VoiceEffect, VoiceEvent, VoiceMachineState, VoicePreferences } from "./types";

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoiceSessionDeps {
  recognition: SpeechRecognitionProvider;
  synthesis: SpeechSynthesisProvider;
  /** Hand the text to the conversation (the same send the keyboard uses). */
  submit(text: string, turn: number): void;
  /** Abandon a turn that is out (stop the run). */
  cancelTurn(turn: number): void;
  prefs(): VoicePreferences;
  timers?: Timers;
  onChange?(state: VoiceMachineState): void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class VoiceSession {
  private state: VoiceMachineState;
  private rec: RecognitionHandle | null = null;
  private speech: SpeechHandle | null = null;
  private recEpoch = 0;
  private speechEpoch = 0;
  private readonly timerHandles = new Map<TimerName, unknown>();
  private readonly queue: VoiceEvent[] = [];
  private draining = false;
  private readonly timers: Timers;

  constructor(private readonly deps: VoiceSessionDeps) {
    this.timers = deps.timers ?? realTimers;
    const p = deps.prefs();
    this.state = { ...INITIAL_VOICE_STATE, speakReplies: p.speakReplies, autoSend: p.autoSend };
  }

  get snapshot(): VoiceMachineState {
    return this.state;
  }

  /** Every input goes through here. */
  dispatch(e: VoiceEvent): void {
    this.queue.push(e);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) this.step(this.queue.shift()!);
    } finally {
      this.draining = false;
    }
  }

  /** The press on the microphone button: checks the microphone is even possible before the machine is asked to "listen". */
  pressMic(): void {
    const k = this.state.kind;
    if (k === "IDLE" || k === "ERROR" || k === "TRANSCRIBING") {
      const a = this.deps.recognition.availability();
      if (!a.ok) return this.dispatch({ type: "UNAVAILABLE", code: "unsupported" });
      if (!this.deps.prefs().consented) return; // the UI shows the disclosure first; nothing starts without the person's agreement
    }
    this.dispatch({ type: "MIC_PRESS" });
  }

  setPrefs(): void {
    const p = this.deps.prefs();
    this.dispatch({ type: "PREFS", prefs: { speakReplies: p.speakReplies, autoSend: p.autoSend } });
  }

  /** Release everything (the component is going away). */
  dispose(): void {
    this.recEpoch++;
    this.speechEpoch++;
    try {
      this.rec?.abort();
    } catch {
      /* nothing to release */
    }
    try {
      this.deps.synthesis.cancel();
    } catch {
      /* nothing to release */
    }
    for (const h of this.timerHandles.values()) this.timers.clear(h);
    this.timerHandles.clear();
    this.rec = null;
    this.speech = null;
    this.queue.length = 0;
  }

  private step(e: VoiceEvent): void {
    const out = voiceReduce(this.state, e);
    this.state = out.state;
    for (const fx of out.effects) this.run(fx);
    this.deps.onChange?.(this.state);
  }

  private run(fx: VoiceEffect): void {
    switch (fx.type) {
      case "startRecognition":
        return this.startRecognition();
      case "stopRecognition":
        try {
          this.rec?.stop();
        } catch {
          /* it ends on its own */
        }
        return;
      case "abortRecognition": {
        this.recEpoch++; // everything the old session says from now on is ignored
        const h = this.rec;
        this.rec = null;
        try {
          h?.abort();
        } catch {
          /* already over */
        }
        return;
      }
      case "speak":
        return this.speak(fx.text);
      case "cancelSpeech": {
        this.speechEpoch++;
        this.speech = null;
        try {
          this.deps.synthesis.cancel();
        } catch {
          /* already over */
        }
        // cancel() is synchronous and the old session's callbacks are now ignored, so the stop is confirmed here: this is what lets a barge-in
        // open the microphone right after speech has stopped (the interrupt timer is only the safety net if a provider cannot say so).
        this.queue.push({ type: "SPEECH_CANCELLED" });
        return;
      }
      case "submit":
        return this.deps.submit(fx.text, fx.turn);
      case "cancelTurn":
        return this.deps.cancelTurn(fx.turn);
      case "startTimer": {
        this.clearTimer(fx.timer);
        this.timerHandles.set(fx.timer, this.timers.set(() => {
          this.timerHandles.delete(fx.timer);
          this.dispatch({ type: "TIMEOUT", timer: fx.timer });
        }, fx.ms));
        return;
      }
      case "clearTimer":
        return this.clearTimer(fx.timer);
    }
  }

  private clearTimer(name: TimerName): void {
    const h = this.timerHandles.get(name);
    if (h !== undefined) this.timers.clear(h);
    this.timerHandles.delete(name);
  }

  private startRecognition(): void {
    const epoch = ++this.recEpoch;
    const live = () => epoch === this.recEpoch;
    try {
      this.rec = this.deps.recognition.start(
        { lang: this.deps.prefs().lang },
        {
          onStart: () => live() && this.dispatch({ type: "RECOGNITION_STARTED" }),
          onInterim: (text) => live() && this.dispatch({ type: "INTERIM", text }),
          onFinal: (text, id) => live() && this.dispatch({ type: "FINAL", text, id }),
          onError: (code) => live() && this.dispatch({ type: "RECOGNITION_ERROR", code }),
          onEnd: () => live() && this.dispatch({ type: "RECOGNITION_ENDED" }),
        },
      );
    } catch {
      // Starting threw (the browser refused). Said as an error: never a pretend "listening".
      this.rec = null;
      this.recEpoch++;
      this.queue.push({ type: "RECOGNITION_ERROR", code: "provider" });
    }
  }

  private speak(text: string): void {
    const epoch = ++this.speechEpoch;
    const live = () => epoch === this.speechEpoch;
    const p = this.deps.prefs();
    const a = this.deps.synthesis.availability();
    if (!a.ok) {
      this.queue.push({ type: "SPEECH_ERROR" }); // the written answer is already on screen
      return;
    }
    try {
      this.speech = this.deps.synthesis.speak(text, { lang: p.lang, voiceId: p.voiceId, rate: p.rate, volume: p.volume }, {
        onStart: () => live() && this.dispatch({ type: "SPEECH_STARTED" }),
        onEnd: () => live() && this.dispatch({ type: "SPEECH_ENDED" }),
        onCancelled: () => live() && this.dispatch({ type: "SPEECH_CANCELLED" }),
        onError: () => live() && this.dispatch({ type: "SPEECH_ERROR" }),
      });
    } catch {
      this.speech = null;
      this.queue.push({ type: "SPEECH_ERROR" });
    }
  }
}
