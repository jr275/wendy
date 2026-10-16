/**
 * The voice session manager (web/lib/speech/session.ts) with FAKE providers and FAKE timers. Pure: no browser, no microphone, no network.
 * These fixtures prove the wiring between the machine, the providers and the conversation. They do NOT prove a real microphone or a real
 * recognizer works (that is validated by hand in Chrome: docs/VOICE_VALIDATION.md).
 */
import { describe, expect, it } from 'vitest';
import { VoiceSession, type Timers } from '../../web/lib/speech/session.js';
import { DEFAULT_VOICE_PREFS } from '../../web/lib/speech/prefs.js';
import type { Availability, RecognitionCallbacks, SpeakOptions, SpeechCallbacks, SpeechRecognitionProvider, SpeechSynthesisProvider, VoicePreferences } from '../../web/lib/speech/types.js';

class FakeRecognition implements SpeechRecognitionProvider {
  readonly name = 'fake-rec';
  available: Availability = { ok: true };
  throwOnStart = false;
  starts: { lang: string; cb: RecognitionCallbacks }[] = [];
  stops = 0;
  aborts = 0;
  availability() {
    return this.available;
  }
  start(opts: { lang: string }, cb: RecognitionCallbacks) {
    if (this.throwOnStart) throw new Error('refused');
    this.starts.push({ lang: opts.lang, cb });
    return { stop: () => void this.stops++, abort: () => void this.aborts++ };
  }
  get current() {
    return this.starts.at(-1)!.cb;
  }
}

class FakeSynthesis implements SpeechSynthesisProvider {
  readonly name = 'fake-synth';
  available: Availability = { ok: true };
  throwOnSpeak = false;
  spoken: { text: string; opts: SpeakOptions; cb: SpeechCallbacks }[] = [];
  cancels = 0;
  availability() {
    return this.available;
  }
  voices() {
    return [];
  }
  speak(text: string, opts: SpeakOptions, cb: SpeechCallbacks) {
    if (this.throwOnSpeak) throw new Error('refused');
    this.spoken.push({ text, opts, cb });
    return { cancel: () => void this.cancels++ };
  }
  cancel() {
    this.cancels++;
  }
  get current() {
    return this.spoken.at(-1)!.cb;
  }
}

class FakeTimers implements Timers {
  private n = 0;
  private pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number) {
    const id = ++this.n;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(h: unknown) {
    this.pending.delete(h as number);
  }
  get active() {
    return [...this.pending.values()].map((t) => t.ms);
  }
  fireAll() {
    const all = [...this.pending.entries()];
    for (const [id, t] of all) {
      if (this.pending.delete(id)) t.fn();
    }
  }
}

function setup(prefs: Partial<VoicePreferences> = {}) {
  const rec = new FakeRecognition();
  const synth = new FakeSynthesis();
  const timers = new FakeTimers();
  const submitted: { text: string; turn: number }[] = [];
  const cancelled: number[] = [];
  const states: string[] = [];
  const p: VoicePreferences = { ...DEFAULT_VOICE_PREFS, consented: true, ...prefs };
  const session = new VoiceSession({ recognition: rec, synthesis: synth, timers, prefs: () => p, submit: (text, turn) => submitted.push({ text, turn }), cancelTurn: (t) => cancelled.push(t), onChange: (s) => states.push(s.kind) });
  return { session, rec, synth, timers, submitted, cancelled, states, p };
}
const kind = (s: VoiceSession) => s.snapshot.kind;

describe('microphone availability is checked before "listening"', () => {
  it('no recognition API → ERROR "unsupported"; the provider is never started and the state is never LISTENING', () => {
    const t = setup();
    t.rec.available = { ok: false, reason: 'unsupported' };
    t.session.pressMic();
    expect(t.session.snapshot).toMatchObject({ kind: 'ERROR', error: { code: 'unsupported' } });
    expect(t.rec.starts).toHaveLength(0);
    expect(t.states).not.toContain('LISTENING');
  });
  it('without the person\'s consent the microphone is never opened (the UI shows the disclosure first)', () => {
    const t = setup({ consented: false });
    t.session.pressMic();
    expect(kind(t.session)).toBe('IDLE');
    expect(t.rec.starts).toHaveLength(0);
  });
  it('the browser refusing to start is an error in words, not a silent "listening"', () => {
    const t = setup();
    t.rec.throwOnStart = true;
    t.session.pressMic();
    expect(t.session.snapshot).toMatchObject({ kind: 'ERROR', error: { code: 'provider' } });
  });
  it('permission blocked while starting → ERROR "permission" (not retryable); a second press opens nothing', () => {
    const t = setup();
    t.session.pressMic();
    expect(t.session.snapshot).toMatchObject({ kind: 'LISTENING', micLive: false }); // waiting on the permission prompt: NOT live
    t.rec.current.onError('permission');
    expect(t.session.snapshot).toMatchObject({ kind: 'ERROR', error: { code: 'permission', retryable: false } });
    t.session.pressMic();
    expect(t.rec.starts).toHaveLength(1);
  });
  it('the recognition language is pt-BR', () => {
    const t = setup();
    t.session.pressMic();
    expect(t.rec.starts[0]!.lang).toBe('pt-BR');
  });
});

describe('a full turn through the conversation', () => {
  it('listen → review → send → the SAME send the keyboard uses → answer spoken → idle', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onStart();
    expect(t.session.snapshot.micLive).toBe(true);
    t.rec.current.onInterim('quais');
    t.rec.current.onFinal('quais são minhas tarefas', 'a:0');
    expect(t.session.snapshot).toMatchObject({ kind: 'TRANSCRIBING', transcript: 'quais são minhas tarefas' });
    expect(t.submitted).toEqual([]); // reviewed first: nothing sent yet
    t.session.dispatch({ type: 'SEND' });
    expect(t.submitted).toEqual([{ text: 'quais são minhas tarefas', turn: 1 }]);
    expect(kind(t.session)).toBe('THINKING');
    t.session.dispatch({ type: 'REPLY', turn: 1, text: 'Você tem 3 tarefas.' });
    expect(t.synth.spoken.map((s) => s.text)).toEqual(['Você tem 3 tarefas.']);
    expect(t.synth.spoken[0]!.opts).toMatchObject({ lang: 'pt-BR', rate: 1, volume: 1 });
    t.synth.current.onStart();
    t.synth.current.onEnd();
    expect(kind(t.session)).toBe('IDLE');
    expect(t.rec.starts).toHaveLength(1); // no automatic listening after she finishes: no loop
  });
  it('the recognizer is closed once a final result arrives (it cannot send a second one)', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    expect(t.rec.aborts).toBe(1);
  });
  it('a late callback from the finished recognition session changes nothing (no second turn)', () => {
    const t = setup({ autoSend: true });
    t.session.pressMic();
    const old = t.rec.current;
    old.onFinal('oi', 'a:0');
    expect(t.submitted).toHaveLength(1);
    old.onFinal('oi outra vez', 'a:1');
    old.onEnd();
    old.onError('provider');
    expect(t.submitted).toHaveLength(1);
    expect(kind(t.session)).toBe('THINKING');
  });
  it('a late result from a CANCELLED recognition session is ignored while a NEW session is listening (the dangerous case: the machine would accept it)', () => {
    const t = setup();
    t.session.pressMic();
    const first = t.rec.current;
    t.session.dispatch({ type: 'CANCEL' }); // session A is aborted
    t.session.pressMic(); // session B starts
    expect(t.rec.starts).toHaveLength(2);
    expect(kind(t.session)).toBe('LISTENING');
    first.onStart();
    first.onInterim('fantasma');
    first.onFinal('texto fantasma da sessão antiga', 'a:0');
    first.onEnd();
    expect(t.session.snapshot).toMatchObject({ kind: 'LISTENING', micLive: false, interim: '', transcript: '' });
    t.rec.current.onFinal('texto da sessão nova', 'b:0'); // the current session still works
    expect(t.session.snapshot).toMatchObject({ kind: 'TRANSCRIBING', transcript: 'texto da sessão nova' });
  });
  it('auto-send submits immediately after the final result; still exactly once', () => {
    const t = setup({ autoSend: true });
    t.session.pressMic();
    t.rec.current.onFinal('quais minhas tarefas', 'a:0');
    t.rec.current.onFinal('quais minhas tarefas', 'a:0'); // the same utterance repeated
    expect(t.submitted).toEqual([{ text: 'quais minhas tarefas', turn: 1 }]);
  });
  it('reading replies aloud off: the answer is not spoken and the state returns to idle', () => {
    const t = setup({ speakReplies: false });
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'REPLY', turn: 1, text: 'Olá' });
    expect(t.synth.spoken).toHaveLength(0);
    expect(kind(t.session)).toBe('IDLE');
  });
  it('changing the preference while she is speaking takes effect at once', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'REPLY', turn: 1, text: 'Olá' });
    expect(kind(t.session)).toBe('SPEAKING');
    t.p.speakReplies = false;
    t.session.setPrefs();
    expect(kind(t.session)).toBe('IDLE');
    expect(t.synth.cancels).toBeGreaterThan(0);
  });
});

describe('interruption (barge-in), cancel and the microphone loop', () => {
  function speaking() {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'REPLY', turn: 1, text: 'Uma resposta longa que está sendo lida.' });
    t.synth.current.onStart();
    return t;
  }
  it('pressing the microphone while she speaks stops the speech FIRST, then opens the microphone', () => {
    const t = speaking();
    const cancelsBefore = t.synth.cancels;
    const startsBefore = t.rec.starts.length;
    t.session.pressMic();
    expect(t.synth.cancels).toBeGreaterThan(cancelsBefore); // she was stopped…
    expect(t.rec.starts.length).toBe(startsBefore + 1); // …and only then the microphone opened (confirmed by the session itself)
    expect(kind(t.session)).toBe('LISTENING');
  });
  it('the microphone is never open at the same time as speech: no recognizer starts between the answer and its end', () => {
    const t = speaking();
    expect(t.rec.starts).toHaveLength(1); // only the one from the first press
    t.synth.current.onEnd();
    expect(t.rec.starts).toHaveLength(1);
    expect(kind(t.session)).toBe('IDLE');
  });
  it('a late "ended" from the cancelled utterance does not disturb the new listening session', () => {
    const t = speaking();
    const old = t.synth.current;
    t.session.pressMic();
    old.onEnd();
    old.onError();
    expect(kind(t.session)).toBe('LISTENING');
  });
  it('the end of an OLD utterance does not cut the NEW one short (the dangerous case: the machine would accept it)', () => {
    const t = speaking();
    const old = t.synth.current;
    t.session.dispatch({ type: 'CANCEL' }); // utterance A is cancelled
    t.session.pressMic();
    t.rec.current.onFinal('de novo', 'b:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'REPLY', turn: 2, text: 'Segunda resposta.' }); // cancelling a SPEAKING turn does not bump the counter; the next send is turn 2
    expect(kind(t.session)).toBe('SPEAKING');
    old.onEnd(); // the old utterance reports its end late
    old.onCancelled();
    expect(kind(t.session)).toBe('SPEAKING');
    t.synth.current.onEnd(); // only the current utterance ends it
    expect(kind(t.session)).toBe('IDLE');
  });
  it('the written answer is never lost if speech fails: speech error → idle with a notice', () => {
    const t = speaking();
    t.synth.current.onError();
    expect(t.session.snapshot).toMatchObject({ kind: 'IDLE', notice: 'speech_failed' });
  });
  it('speech unavailable or refused by the browser → idle with a notice; no crash and no stuck SPEAKING', () => {
    const a = setup();
    a.synth.available = { ok: false, reason: 'unsupported' };
    a.session.pressMic();
    a.rec.current.onFinal('oi', 'a:0');
    a.session.dispatch({ type: 'SEND' });
    a.session.dispatch({ type: 'REPLY', turn: 1, text: 'Olá' });
    expect(a.session.snapshot).toMatchObject({ kind: 'IDLE', notice: 'speech_failed' });
    const b = setup();
    b.synth.throwOnSpeak = true;
    b.session.pressMic();
    b.rec.current.onFinal('oi', 'a:0');
    b.session.dispatch({ type: 'SEND' });
    b.session.dispatch({ type: 'REPLY', turn: 1, text: 'Olá' });
    expect(b.session.snapshot).toMatchObject({ kind: 'IDLE', notice: 'speech_failed' });
  });
  it('cancel while THINKING abandons the turn (the run is told to stop); a late answer is not spoken', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'CANCEL' });
    expect(t.cancelled).toEqual([1]);
    t.session.dispatch({ type: 'REPLY', turn: 1, text: 'tarde demais' });
    expect(t.synth.spoken).toHaveLength(0);
    expect(kind(t.session)).toBe('IDLE');
  });
  it('cancel while listening aborts the recognizer and nothing is submitted', () => {
    const t = setup();
    t.session.pressMic();
    t.session.dispatch({ type: 'CANCEL' });
    expect(t.rec.aborts).toBe(1);
    t.rec.starts[0]!.cb.onFinal('depois do cancelamento', 'x:0');
    expect(t.submitted).toEqual([]);
    expect(kind(t.session)).toBe('IDLE');
  });
});

describe('timers and recovery', () => {
  it('silence: the no-speech timer ends listening with a notice; nothing is sent', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onStart();
    expect(t.timers.active).toContain(10_000);
    t.timers.fireAll();
    expect(t.session.snapshot).toMatchObject({ kind: 'IDLE', notice: 'no_speech' });
    expect(t.rec.aborts).toBe(1);
    expect(t.submitted).toEqual([]);
  });
  it('a turn that never answers times out into an error, abandons the turn, and a retry press works', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    expect(t.timers.active).toContain(120_000);
    t.timers.fireAll();
    expect(t.session.snapshot).toMatchObject({ kind: 'ERROR', error: { code: 'timeout', retryable: true } });
    expect(t.cancelled).toEqual([1]);
    t.session.pressMic();
    expect(kind(t.session)).toBe('LISTENING');
  });
  it('a failed turn is an error and speaks nothing', () => {
    const t = setup();
    t.session.pressMic();
    t.rec.current.onFinal('oi', 'a:0');
    t.session.dispatch({ type: 'SEND' });
    t.session.dispatch({ type: 'REPLY_FAILED', turn: 1 });
    expect(t.session.snapshot).toMatchObject({ kind: 'ERROR', error: { code: 'reply_failed' } });
    expect(t.synth.spoken).toHaveLength(0);
  });
  it('dispose releases the microphone, the speech and the timers, and later callbacks do nothing', () => {
    const t = setup();
    t.session.pressMic();
    const cb = t.rec.current;
    t.session.dispose();
    expect(t.rec.aborts).toBe(1);
    expect(t.synth.cancels).toBeGreaterThan(0);
    expect(t.timers.active).toEqual([]);
    cb.onFinal('tarde', 'a:0');
    expect(t.submitted).toEqual([]);
  });
});

describe('events raised while effects run are processed one at a time', () => {
  it('a provider that calls back synchronously from start() cannot interleave effects or send twice', () => {
    const t = setup({ autoSend: true });
    t.rec.start = (opts, cb) => {
      cb.onStart();
      cb.onFinal('sincrono', 's:0');
      cb.onFinal('sincrono', 's:0');
      cb.onEnd();
      return { stop: () => undefined, abort: () => undefined };
    };
    t.session.pressMic();
    expect(t.submitted).toEqual([{ text: 'sincrono', turn: 1 }]);
    expect(kind(t.session)).toBe('THINKING');
  });
});
