/**
 * The voice state machine (web/lib/speech/machine.ts). Pure: no browser, no microphone, no provider, no network.
 * Fixtures only — this proves the LOGIC of every flow. It does NOT prove that a real microphone or a real recognizer works; that is checked
 * by hand in Chrome (docs/VOICE_VALIDATION.md).
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_VOICE_STATE, voiceReduce, type Step } from '../../web/lib/speech/machine.js';
import { INTERRUPT_MS, NO_SPEECH_MS, THINK_MS, VOICE_STATES, type VoiceEffect, type VoiceEvent, type VoiceMachineState } from '../../web/lib/speech/types.js';

const run = (events: VoiceEvent[], from: VoiceMachineState = INITIAL_VOICE_STATE) => {
  let s = from;
  const log: { e: VoiceEvent; s: VoiceMachineState; fx: VoiceEffect[] }[] = [];
  for (const e of events) {
    const r: Step = voiceReduce(s, e);
    log.push({ e, s: r.state, fx: r.effects });
    s = r.state;
  }
  return { s, log, effects: log.flatMap((l) => l.fx) };
};
const kinds = (events: VoiceEvent[], from?: VoiceMachineState) => run(events, from).log.map((l) => l.s.kind);
const fx = (events: VoiceEvent[], from?: VoiceMachineState) => run(events, from).effects.map((x) => x.type);

const LISTEN: VoiceEvent[] = [{ type: 'MIC_PRESS' }, { type: 'RECOGNITION_STARTED' }];
const SAY = (text: string, id = 'u1'): VoiceEvent[] => [{ type: 'INTERIM', text: text.slice(0, 3) }, { type: 'FINAL', text, id }];

describe('happy path: speak, review, send, hear the answer', () => {
  it('IDLE → LISTENING → TRANSCRIBING → THINKING → SPEAKING → IDLE, with the exact effects', () => {
    const r = run([...LISTEN, ...SAY('quais são minhas tarefas'), { type: 'SEND' }, { type: 'REPLY', turn: 1, text: 'Você tem 3 tarefas.' }, { type: 'SPEECH_STARTED' }, { type: 'SPEECH_ENDED' }]);
    expect(r.log.map((l) => l.s.kind)).toEqual(['LISTENING', 'LISTENING', 'LISTENING', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'SPEAKING', 'IDLE']);
    expect(r.effects).toEqual([
      { type: 'startRecognition' },
      { type: 'startTimer', timer: 'noSpeech', ms: NO_SPEECH_MS },
      { type: 'clearTimer', timer: 'noSpeech' },
      { type: 'abortRecognition' },
      { type: 'submit', text: 'quais são minhas tarefas', turn: 1 },
      { type: 'startTimer', timer: 'think', ms: THINK_MS },
      { type: 'clearTimer', timer: 'think' },
      { type: 'abortRecognition' },
      { type: 'speak', text: 'Você tem 3 tarefas.', turn: 1 },
    ]);
    expect(r.s.kind).toBe('IDLE');
  });
  it('the microphone is not live until the provider says capture began (the permission prompt is not "listening")', () => {
    const r = run([{ type: 'MIC_PRESS' }]);
    expect(r.s).toMatchObject({ kind: 'LISTENING', micLive: false });
    expect(run([...LISTEN]).s.micLive).toBe(true);
  });
  it('the transcript is NOT sent by itself: it waits, editable, until SEND', () => {
    const r = run([...LISTEN, ...SAY('ligar pro contador')]);
    expect(r.s).toMatchObject({ kind: 'TRANSCRIBING', transcript: 'ligar pro contador' });
    expect(r.effects.some((x) => x.type === 'submit')).toBe(false);
    const edited = run([{ type: 'TRANSCRIPT_EDITED', text: 'ligar para o contador' }, { type: 'SEND' }], r.s);
    expect(edited.effects).toContainEqual({ type: 'submit', text: 'ligar para o contador', turn: 1 });
  });
  it('with auto-send on, the final result is submitted at once (still one turn)', () => {
    const r = run([{ type: 'PREFS', prefs: { speakReplies: true, autoSend: true } }, ...LISTEN, ...SAY('oi')]);
    expect(r.s).toMatchObject({ kind: 'THINKING', turn: 1 });
    expect(r.effects.filter((x) => x.type === 'submit')).toEqual([{ type: 'submit', text: 'oi', turn: 1 }]);
  });
  it('a second press while listening finishes listening: it asks the provider to stop (it delivers what it heard), it does not send', () => {
    const r = run([...LISTEN, { type: 'MIC_PRESS' }]);
    expect(r.s.kind).toBe('LISTENING');
    expect(r.log.at(-1)!.fx).toEqual([{ type: 'stopRecognition' }]);
  });
  it('pressing the mic while reviewing keeps the text and adds to it', () => {
    const r = run([...LISTEN, ...SAY('primeira parte', 'a'), { type: 'MIC_PRESS' }, { type: 'RECOGNITION_STARTED' }, ...SAY('segunda parte', 'b')]);
    expect(r.s).toMatchObject({ kind: 'TRANSCRIBING', transcript: 'primeira parte segunda parte' });
  });
});

describe('the microphone is unavailable, blocked or silent: said in words, never pretended', () => {
  it('permission denied → ERROR (not retryable); pressing again changes nothing and opens no microphone', () => {
    const r = run([{ type: 'MIC_PRESS' }, { type: 'RECOGNITION_ERROR', code: 'permission' }, { type: 'MIC_PRESS' }]);
    expect(r.s).toMatchObject({ kind: 'ERROR', error: { code: 'permission', retryable: false } });
    expect(r.effects.filter((x) => x.type === 'startRecognition')).toHaveLength(1); // only the first press
  });
  it('unsupported browser → ERROR directly, and it is never LISTENING', () => {
    const r = run([{ type: 'UNAVAILABLE', code: 'unsupported' }]);
    expect(r.s).toMatchObject({ kind: 'ERROR', error: { code: 'unsupported', retryable: false } });
    expect(r.effects).toEqual([]);
  });
  it('no capture device is ERROR; a network failure is a retryable ERROR and a new press tries again', () => {
    expect(run([{ type: 'MIC_PRESS' }, { type: 'RECOGNITION_ERROR', code: 'no_microphone' }]).s.error).toEqual({ code: 'no_microphone', retryable: false });
    const net = run([{ type: 'MIC_PRESS' }, { type: 'RECOGNITION_ERROR', code: 'network' }]);
    expect(net.s.error).toEqual({ code: 'network', retryable: true });
    expect(run([{ type: 'MIC_PRESS' }], net.s).s.kind).toBe('LISTENING');
  });
  it('an error while listening aborts the recognizer and never produces a transcript', () => {
    const r = run([...LISTEN, { type: 'INTERIM', text: 'olá' }, { type: 'RECOGNITION_ERROR', code: 'provider' }]);
    expect(r.s).toMatchObject({ kind: 'ERROR', transcript: '', interim: '' });
    expect(r.effects).toContainEqual({ type: 'abortRecognition' });
  });
  it('silence: the no-speech timer (or the provider) ends it as a short notice, not an error and not a send', () => {
    const t = run([...LISTEN, { type: 'TIMEOUT', timer: 'noSpeech' }]);
    expect(t.s).toMatchObject({ kind: 'IDLE', notice: 'no_speech', error: null });
    expect(t.effects).toContainEqual({ type: 'abortRecognition' });
    expect(run([...LISTEN, { type: 'RECOGNITION_ERROR', code: 'no_speech' }]).s).toMatchObject({ kind: 'IDLE', notice: 'no_speech' });
    expect(run([...LISTEN, { type: 'FINAL', text: '   ', id: 'x' }]).s).toMatchObject({ kind: 'IDLE', notice: 'no_speech' });
  });
  it('the provider ending with only an interim result offers it for REVIEW; it is not sent', () => {
    const r = run([...LISTEN, { type: 'INTERIM', text: 'acho que falei isto' }, { type: 'RECOGNITION_ENDED' }]);
    expect(r.s).toMatchObject({ kind: 'TRANSCRIBING', transcript: 'acho que falei isto' });
    expect(r.effects.some((x) => x.type === 'submit')).toBe(false);
  });
  it('ending with nothing heard is a notice, not an error', () => {
    expect(run([...LISTEN, { type: 'RECOGNITION_ENDED' }]).s).toMatchObject({ kind: 'IDLE', notice: 'no_speech' });
  });
});

describe('no duplicate turns, no duplicate speech', () => {
  it('a repeated final result (same id) is ignored; a different id is a new utterance', () => {
    const once = run([...LISTEN, ...SAY('um', 'same'), { type: 'MIC_PRESS' }, { type: 'RECOGNITION_STARTED' }, { type: 'FINAL', text: 'um', id: 'same' }]);
    expect(once.s).toMatchObject({ kind: 'LISTENING', transcript: 'um' }); // the repeat was dropped: still listening, transcript not doubled
  });
  it('SEND twice, or a mic press while THINKING, starts nothing new', () => {
    const base = run([...LISTEN, ...SAY('oi')]).s;
    const r = run([{ type: 'SEND' }, { type: 'SEND' }, { type: 'MIC_PRESS' }, { type: 'SEND' }], base);
    expect(r.effects.filter((x) => x.type === 'submit')).toHaveLength(1);
    expect(r.effects.filter((x) => x.type === 'startRecognition')).toHaveLength(0);
    expect(r.s).toMatchObject({ kind: 'THINKING', turn: 1 });
  });
  it('SEND with an empty transcript does nothing', () => {
    expect(run([{ type: 'SEND' }]).effects).toEqual([]);
    expect(run([...LISTEN, ...SAY('x'), { type: 'TRANSCRIPT_EDITED', text: '   ' }, { type: 'SEND' }]).s.kind).toBe('TRANSCRIBING');
  });
  it('an answer for an older turn is dropped; a second answer for the same turn is not spoken twice', () => {
    const thinking = run([...LISTEN, ...SAY('oi'), { type: 'SEND' }]).s; // turn 1
    expect(run([{ type: 'REPLY', turn: 0, text: 'velha' }, { type: 'REPLY', turn: 7, text: 'futura' }], thinking).effects).toEqual([]);
    const r = run([{ type: 'REPLY', turn: 1, text: 'primeira' }, { type: 'REPLY', turn: 1, text: 'segunda' }], thinking);
    expect(r.effects.filter((x) => x.type === 'speak')).toEqual([{ type: 'speak', text: 'primeira', turn: 1 }]);
  });
  it('cancelling while THINKING abandons the turn: its answer, if it still arrives, is never spoken', () => {
    const thinking = run([...LISTEN, ...SAY('oi'), { type: 'SEND' }]).s;
    const r = run([{ type: 'CANCEL' }, { type: 'REPLY', turn: 1, text: 'chegou tarde' }], thinking);
    expect(r.log[0]!.fx).toEqual([{ type: 'cancelTurn', turn: 1 }, { type: 'clearTimer', timer: 'think' }]);
    expect(r.s).toMatchObject({ kind: 'IDLE', turn: 2 });
    expect(r.effects.some((x) => x.type === 'speak')).toBe(false);
  });
  it('a failed turn is an error in words and speaks nothing; a thinking timeout abandons the turn', () => {
    const thinking = run([...LISTEN, ...SAY('oi'), { type: 'SEND' }]).s;
    expect(run([{ type: 'REPLY_FAILED', turn: 1 }], thinking).s).toMatchObject({ kind: 'ERROR', error: { code: 'reply_failed', retryable: true } });
    const t = run([{ type: 'TIMEOUT', timer: 'think' }], thinking);
    expect(t.s).toMatchObject({ kind: 'ERROR', error: { code: 'timeout' } });
    expect(t.effects).toContainEqual({ type: 'cancelTurn', turn: 1 });
    expect(run([{ type: 'REPLY_FAILED', turn: 0 }], thinking).s.kind).toBe('THINKING'); // not this turn's failure
  });
});

describe('speaking, barge-in and the microphone loop', () => {
  const speaking = () => run([...LISTEN, ...SAY('oi'), { type: 'SEND' }, { type: 'REPLY', turn: 1, text: 'Olá, tudo bem?' }]).s;
  it('reading replies aloud off: the answer stays on screen and nothing is spoken', () => {
    const r = run([{ type: 'PREFS', prefs: { speakReplies: false, autoSend: false } }, ...LISTEN, ...SAY('oi'), { type: 'SEND' }, { type: 'REPLY', turn: 1, text: 'Olá' }]);
    expect(r.s.kind).toBe('IDLE');
    expect(r.effects.some((x) => x.type === 'speak')).toBe(false);
  });
  it('an empty answer (cards only) speaks nothing', () => {
    expect(run([{ type: 'REPLY', turn: 1, text: '  ' }], run([...LISTEN, ...SAY('oi'), { type: 'SEND' }]).s).s.kind).toBe('IDLE');
  });
  it('barge-in: pressing the mic while she speaks stops her FIRST; the microphone opens only after speech has stopped', () => {
    const r = run([{ type: 'MIC_PRESS' }], speaking());
    expect(r.s.kind).toBe('INTERRUPTED');
    expect(r.effects).toEqual([{ type: 'cancelSpeech' }, { type: 'startTimer', timer: 'interrupt', ms: INTERRUPT_MS }]); // no startRecognition yet
    const after = run([{ type: 'SPEECH_CANCELLED' }], r.s);
    expect(after.s.kind).toBe('LISTENING');
    expect(after.effects).toEqual([{ type: 'clearTimer', timer: 'interrupt' }, { type: 'startRecognition' }]);
  });
  it('if the provider never confirms the stop, the interrupt timer opens the microphone anyway (cancel was already sent)', () => {
    const r = run([{ type: 'MIC_PRESS' }, { type: 'TIMEOUT', timer: 'interrupt' }], speaking());
    expect(r.s.kind).toBe('LISTENING');
    expect(r.effects.map((x) => x.type)).toEqual(['cancelSpeech', 'startTimer', 'clearTimer', 'startRecognition']);
  });
  it('the microphone is not opened by anything else while speaking: late recognition events and a stray SEND are ignored', () => {
    const r = run([{ type: 'RECOGNITION_STARTED' }, { type: 'FINAL', text: 'eco', id: 'e' }, { type: 'SEND' }, { type: 'INTERIM', text: 'eco' }], speaking());
    expect(r.s.kind).toBe('SPEAKING');
    expect(r.effects).toEqual([]);
  });
  it('a speech failure returns to IDLE with a notice: the written answer is untouched (nothing else is lost)', () => {
    expect(run([{ type: 'SPEECH_ERROR' }], speaking()).s).toMatchObject({ kind: 'IDLE', notice: 'speech_failed', error: null });
  });
  it('CANCEL while speaking stops speech and goes idle; turning reading-aloud off mid-speech does the same', () => {
    const c = run([{ type: 'CANCEL' }], speaking());
    expect(c.s.kind).toBe('IDLE');
    expect(c.effects).toContainEqual({ type: 'cancelSpeech' });
    const p = run([{ type: 'PREFS', prefs: { speakReplies: false, autoSend: false } }], speaking());
    expect(p.s.kind).toBe('IDLE');
    expect(p.effects).toContainEqual({ type: 'cancelSpeech' });
  });
  it('speech ending returns to IDLE with the microphone closed (no automatic listening: no feedback loop)', () => {
    const r = run([{ type: 'SPEECH_ENDED' }], speaking());
    expect(r.s).toMatchObject({ kind: 'IDLE', micLive: false });
    expect(r.effects).toEqual([]);
  });
});

describe('cancel and reset', () => {
  it('CANCEL while listening aborts the recognizer and discards everything; nothing is submitted', () => {
    const r = run([...LISTEN, { type: 'INTERIM', text: 'olá' }, { type: 'CANCEL' }]);
    expect(r.s).toMatchObject({ kind: 'IDLE', interim: '', transcript: '' });
    expect(r.effects).toContainEqual({ type: 'abortRecognition' });
    expect(r.effects.some((x) => x.type === 'submit')).toBe(false);
  });
  it('CANCEL while reviewing discards the transcript', () => {
    expect(run([...LISTEN, ...SAY('x'), { type: 'CANCEL' }]).s).toMatchObject({ kind: 'IDLE', transcript: '' });
  });
  it('RESET leaves the ERROR state and a press can start again (when it can heal)', () => {
    const e = run([{ type: 'MIC_PRESS' }, { type: 'RECOGNITION_ERROR', code: 'network' }, { type: 'RESET' }]);
    expect(e.s).toMatchObject({ kind: 'IDLE', error: null });
  });
  it('events from an old provider session after a cancel are ignored', () => {
    const r = run([...LISTEN, { type: 'CANCEL' }, { type: 'FINAL', text: 'atrasado', id: 'z' }, { type: 'RECOGNITION_ERROR', code: 'provider' }, { type: 'RECOGNITION_ENDED' }]);
    expect(r.s.kind).toBe('IDLE');
    expect(r.effects.some((x) => x.type === 'submit')).toBe(false);
  });
});

// --- invariants over random event sequences ---------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const EDGES: Record<string, string[]> = {
  IDLE: ['IDLE', 'LISTENING', 'ERROR'],
  LISTENING: ['LISTENING', 'IDLE', 'TRANSCRIBING', 'THINKING', 'ERROR'],
  TRANSCRIBING: ['TRANSCRIBING', 'LISTENING', 'THINKING', 'IDLE', 'ERROR'],
  THINKING: ['THINKING', 'SPEAKING', 'IDLE', 'ERROR'],
  SPEAKING: ['SPEAKING', 'IDLE', 'INTERRUPTED', 'ERROR'],
  INTERRUPTED: ['INTERRUPTED', 'LISTENING', 'IDLE', 'ERROR'],
  ERROR: ['ERROR', 'IDLE', 'LISTENING'],
};
describe('invariants hold over 6,000 random event sequences (seeded, deterministic)', () => {
  const CODES = ['unsupported', 'permission', 'no_microphone', 'network', 'provider', 'reply_failed', 'timeout', 'no_speech', 'aborted'] as const;
  const gen = (r: () => number, turn: number): VoiceEvent => {
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const k = Math.floor(r() * 21);
    switch (k) {
      case 0: return { type: 'MIC_PRESS' };
      case 1: return { type: 'STOP_PRESS' };
      case 2: return { type: 'CANCEL' };
      case 3: return { type: 'UNAVAILABLE', code: pick(['unsupported', 'permission'] as const) };
      case 4: return { type: 'RECOGNITION_STARTED' };
      case 5: return { type: 'INTERIM', text: pick(['', 'oi', 'olá mundo']) };
      case 6: return { type: 'FINAL', text: pick(['', ' ', 'oi', 'quais minhas tarefas']), id: `f${Math.floor(r() * 4)}` };
      case 7: return { type: 'RECOGNITION_ENDED' };
      case 8: return { type: 'RECOGNITION_ERROR', code: pick(CODES) };
      case 9: return { type: 'TRANSCRIPT_EDITED', text: pick(['', 'texto editado', '  ']) };
      case 10: return { type: 'SEND' };
      case 11: return { type: 'REPLY', turn: pick([turn, turn, turn - 1, turn + 1, 0]), text: pick(['', 'resposta', ' ']) };
      case 12: return { type: 'REPLY_FAILED', turn: pick([turn, turn - 1]) };
      case 13: return { type: 'SPEECH_STARTED' };
      case 14: return { type: 'SPEECH_ENDED' };
      case 15: return { type: 'SPEECH_CANCELLED' };
      case 16: return { type: 'SPEECH_ERROR' };
      case 17: return { type: 'TIMEOUT', timer: pick(['noSpeech', 'think', 'interrupt'] as const) };
      case 18: return { type: 'PREFS', prefs: { speakReplies: r() < 0.7, autoSend: r() < 0.3 } };
      case 19: return { type: 'RESET' };
      default: return { type: 'MIC_PRESS' };
    }
  };
  it('never listens while speaking, never has two turns out, never submits outside THINKING, only legal moves, errors are consistent', () => {
    let steps = 0;
    for (let seed = 1; seed <= 6000; seed++) {
      const r = rng(seed);
      let s: VoiceMachineState = INITIAL_VOICE_STATE;
      let speechActive = false; // a `speak` effect was issued and not yet cancelled/ended
      let lastTurn = 0;
      for (let i = 0; i < 40; i++) {
        const e = gen(r, s.turn);
        const prev = s;
        const out = voiceReduce(s, e);
        s = out.state;
        steps++;
        const ctx = `seed ${seed} step ${i} ${JSON.stringify(e)}: ${prev.kind} → ${s.kind}`;
        // legal edges
        expect(EDGES[prev.kind]!.includes(s.kind), ctx).toBe(true);
        for (const x of out.effects) {
          if (x.type === 'speak') {
            expect(speechActive, `second speak without the first ending: ${ctx}`).toBe(false);
            expect(x.text.trim().length, ctx).toBeGreaterThan(0);
            speechActive = true;
          }
          if (x.type === 'cancelSpeech') speechActive = false;
          if (x.type === 'startRecognition') expect(speechActive, `microphone opened while speaking: ${ctx}`).toBe(false);
          if (x.type === 'submit') {
            expect(s.kind, `submit outside THINKING: ${ctx}`).toBe('THINKING');
            // The turn is the previous state's turn + 1, and strictly above every turn sent before (an abandoned turn also advances the counter).
            expect(x.turn, `turn did not advance: ${ctx}`).toBe(prev.turn + 1);
            expect(x.turn, `turn not above the last one sent: ${ctx}`).toBeGreaterThan(lastTurn);
            expect(x.text.trim().length, ctx).toBeGreaterThan(0);
            lastTurn = x.turn;
          }
        }
        if (e.type === 'SPEECH_ENDED' || e.type === 'SPEECH_CANCELLED' || e.type === 'SPEECH_ERROR') speechActive = false;
        // state consistency
        expect(s.kind === 'ERROR', ctx).toBe(s.error !== null);
        if (s.micLive) expect(s.kind, ctx).toBe('LISTENING');
        expect(s.turn >= prev.turn, ctx).toBe(true);
        if (s.kind === 'SPEAKING') expect(speechActive, `SPEAKING without a speak effect: ${ctx}`).toBe(true);
        expect(VOICE_STATES.includes(s.kind), ctx).toBe(true);
      }
    }
    expect(steps).toBe(240_000);
  });
});
