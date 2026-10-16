/**
 * The Web Speech API adapters (web/lib/speech/webSpeech.ts) against FAKE browser objects. Pure: no browser, no microphone, no network.
 * Fixtures prove the mapping and the lifecycle. They do NOT prove Chrome's recognizer works in pt-BR with your microphone: docs/VOICE_VALIDATION.md.
 */
import { describe, expect, it } from 'vitest';
import { createWebSpeechRecognition, createWebSpeechSynthesis, isPtBr, mapRecognitionError, orderVoices, type RecognitionLike, type SpeechWindow } from '../../web/lib/speech/webSpeech.js';
import type { RecognitionCallbacks, SpeechCallbacks, VoiceInfo } from '../../web/lib/speech/types.js';

class FakeRec implements RecognitionLike {
  static last: FakeRec | null = null;
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onaudiostart: (() => void) | null = null;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  abortedCount = 0;
  throwOnStart = false;
  constructor() {
    FakeRec.last = this;
  }
  start() {
    if (this.throwOnStart) throw new Error('InvalidStateError');
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.abortedCount++;
    this.onerror?.({ error: 'aborted' }); // browsers report an abort as an error event, then end
    this.onend?.();
  }
  result(idx: number, items: { t: string; final: boolean }[]) {
    this.onresult?.({ resultIndex: idx, results: items.map((i) => ({ isFinal: i.final, 0: { transcript: i.t } })) });
  }
}

function recorder() {
  const log: string[] = [];
  const cb: RecognitionCallbacks = {
    onStart: () => log.push('start'),
    onInterim: (t) => log.push(`interim:${t}`),
    onFinal: (t, id) => log.push(`final:${t}@${id}`),
    onError: (c) => log.push(`error:${c}`),
    onEnd: () => log.push('end'),
  };
  return { log, cb };
}

describe('recognition: availability', () => {
  it('no recognition API → unsupported; webkit-prefixed is used when that is all there is; an insecure context is refused', () => {
    expect(createWebSpeechRecognition({}).availability()).toEqual({ ok: false, reason: 'unsupported' });
    expect(createWebSpeechRecognition({ webkitSpeechRecognition: FakeRec }).availability()).toEqual({ ok: true });
    expect(createWebSpeechRecognition({ SpeechRecognition: FakeRec }).availability()).toEqual({ ok: true });
    expect(createWebSpeechRecognition({ SpeechRecognition: FakeRec, isSecureContext: false }).availability()).toEqual({ ok: false, reason: 'insecure_context' });
  });
  it('starting without an API throws (the manager turns that into an error, never a fake "listening")', () => {
    expect(() => createWebSpeechRecognition({}).start({ lang: 'pt-BR' }, recorder().cb)).toThrow();
  });
});

describe('recognition: configuration and events', () => {
  const provider = createWebSpeechRecognition({ SpeechRecognition: FakeRec }); // one provider for the whole app, as in the real use
  const start = () => {
    const r = recorder();
    const h = provider.start({ lang: 'pt-BR' }, r.cb);
    return { ...r, h, rec: FakeRec.last! };
  };
  it('configures pt-BR, interim results, one utterance, one alternative; and starts it once', () => {
    const { rec } = start();
    expect(rec).toMatchObject({ lang: 'pt-BR', continuous: false, interimResults: true, maxAlternatives: 1, started: 1 });
  });
  it('"started" is reported when AUDIO CAPTURE begins (after the permission prompt), not when start() is called', () => {
    const { log, rec } = start();
    expect(log).toEqual([]);
    rec.onaudiostart!();
    expect(log).toEqual(['start']);
  });
  it('interim text is reported as it grows; a final result carries a stable id and is reported once', () => {
    const { log, rec } = start();
    rec.result(0, [{ t: 'quais são', final: false }]);
    rec.result(0, [{ t: 'quais são minhas tarefas', final: true }]);
    expect(log).toEqual(['interim:quais são', expect.stringMatching(/^final:quais são minhas tarefas@\d+:0$/)]);
  });
  it('two final results in one session get distinct ids (so a repeat of the SAME id can be told apart)', () => {
    const { log, rec } = start();
    rec.result(0, [{ t: 'um', final: true }]);
    rec.result(1, [{ t: 'um', final: true }, { t: 'dois', final: true }]); // the API delivers the cumulative list; resultIndex points at the new one
    const ids = log.map((l) => l.split('@')[1]);
    expect(new Set(ids).size).toBe(2);
  });
  it('different sessions never share an id', () => {
    const a = start();
    a.rec.result(0, [{ t: 'a', final: true }]);
    const b = start();
    b.rec.result(0, [{ t: 'b', final: true }]);
    expect(a.log[0]!.split('@')[1]).not.toBe(b.log[0]!.split('@')[1]);
  });
  it('the session ends once: onEnd is reported one time even if the browser fires it twice', () => {
    const { log, rec } = start();
    rec.onend!();
    rec.onend!();
    expect(log).toEqual(['end']);
  });
  it('stop() asks the browser to finish (it delivers what it heard); abort() discards: nothing is reported after it, not even the abort error or the end', () => {
    const a = start();
    a.h.stop();
    expect(a.rec.stopped).toBe(1);
    const b = start();
    b.h.abort();
    b.rec.result(0, [{ t: 'tarde', final: true }]);
    expect(b.rec.abortedCount).toBe(1);
    expect(b.log).toEqual([]); // the browser's abort error + end are swallowed; a late result is dropped
  });
  it('calling stop/abort after the session is over does not throw', () => {
    const { h, rec } = start();
    rec.stop = () => {
      throw new Error('InvalidStateError');
    };
    rec.abort = () => {
      throw new Error('InvalidStateError');
    };
    expect(() => h.stop()).not.toThrow();
    expect(() => h.abort()).not.toThrow();
  });
  it('a start() that the browser refuses throws to the caller', () => {
    class Refusing extends FakeRec {
      throwOnStart = true;
    }
    expect(() => createWebSpeechRecognition({ SpeechRecognition: Refusing }).start({ lang: 'pt-BR' }, recorder().cb)).toThrow();
  });
});

describe('recognition: error mapping (none is swallowed, none becomes success)', () => {
  it('maps the browser\'s names to ours; anything unknown is a provider error', () => {
    const table: [string, string][] = [
      ['not-allowed', 'permission'],
      ['service-not-allowed', 'permission'],
      ['audio-capture', 'no_microphone'],
      ['network', 'network'],
      ['no-speech', 'no_speech'],
      ['aborted', 'aborted'],
      ['language-not-supported', 'provider'],
      ['bad-grammar', 'provider'],
      ['something-new', 'provider'],
      ['', 'provider'],
    ];
    for (const [from, to] of table) expect(mapRecognitionError(from), from).toBe(to);
  });
  it('an error event reaches the callbacks mapped', () => {
    const r = recorder();
    createWebSpeechRecognition({ SpeechRecognition: FakeRec }).start({ lang: 'pt-BR' }, r.cb);
    FakeRec.last!.onerror!({ error: 'not-allowed' });
    expect(r.log).toEqual(['error:permission']);
  });
});

// --- synthesis -------------------------------------------------------------------------------------------------------------------
class FakeUtter {
  static all: FakeUtter[] = [];
  lang = '';
  voice: unknown = null;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  constructor(readonly text: string) {
    FakeUtter.all.push(this);
  }
}
const VOICES = [
  { voiceURI: 'en-1', name: 'Alex', lang: 'en-US', localService: true },
  { voiceURI: 'pt-remote', name: 'Zeca', lang: 'pt-BR', localService: false },
  { voiceURI: 'pt-local-b', name: 'Bia', lang: 'pt-BR', localService: true },
  { voiceURI: 'pt-pt', name: 'Joana', lang: 'pt-PT', localService: true },
  { voiceURI: 'pt-local-a', name: 'Ana', lang: 'pt_BR', localService: true },
];
function synthWin(over: Partial<SpeechWindow['speechSynthesis'] & object> = {}) {
  FakeUtter.all = [];
  const spoken: FakeUtter[] = [];
  let cancels = 0;
  const win: SpeechWindow = {
    SpeechSynthesisUtterance: FakeUtter,
    speechSynthesis: { speak: (u) => spoken.push(u as unknown as FakeUtter), cancel: () => void cancels++, getVoices: () => VOICES, ...over },
  };
  return { win, spoken, cancels: () => cancels };
}
function speechRecorder() {
  const log: string[] = [];
  const cb: SpeechCallbacks = { onStart: () => log.push('start'), onEnd: () => log.push('end'), onCancelled: () => log.push('cancelled'), onError: () => log.push('error') };
  return { log, cb };
}
const OPTS = { lang: 'pt-BR', voiceId: null, rate: 1, volume: 1 };

describe('synthesis', () => {
  it('availability reflects the API; voices are ordered pt-BR first, local first, then by name', () => {
    expect(createWebSpeechSynthesis({}).availability()).toEqual({ ok: false, reason: 'unsupported' });
    const { win } = synthWin();
    const p = createWebSpeechSynthesis(win);
    expect(p.availability()).toEqual({ ok: true });
    expect(p.voices().map((v) => v.id)).toEqual(['pt-local-a', 'pt-local-b', 'pt-remote', 'pt-pt', 'en-1']);
    expect(createWebSpeechSynthesis({}).voices()).toEqual([]);
    expect(isPtBr('pt-BR')).toBe(true);
    expect(isPtBr('pt_br')).toBe(true);
    expect(isPtBr('pt-PT')).toBe(false);
  });
  it('speaks in pt-BR with a pt-BR voice (a local one preferred), at the chosen rate and volume, and says "started" once', () => {
    const { win, spoken } = synthWin();
    const r = speechRecorder();
    createWebSpeechSynthesis(win).speak('Olá, tudo bem?', { lang: 'pt-BR', voiceId: null, rate: 1.25, volume: 0.5 }, r.cb);
    const u = spoken[0]!;
    expect(u).toMatchObject({ lang: 'pt-BR', rate: 1.25, volume: 0.5, text: 'Olá, tudo bem?' });
    expect((u.voice as { voiceURI: string }).voiceURI).toBe('pt-local-a');
    u.onstart!();
    u.onstart!();
    u.onend!();
    expect(r.log).toEqual(['start', 'end']);
  });
  it('a chosen voice is used when it exists; an unknown voice id falls back to a pt-BR voice', () => {
    const a = synthWin();
    createWebSpeechSynthesis(a.win).speak('oi', { ...OPTS, voiceId: 'pt-remote' }, speechRecorder().cb);
    expect((a.spoken[0]!.voice as { voiceURI: string }).voiceURI).toBe('pt-remote');
    const b = synthWin();
    createWebSpeechSynthesis(b.win).speak('oi', { ...OPTS, voiceId: 'gone' }, speechRecorder().cb);
    expect((b.spoken[0]!.voice as { voiceURI: string }).voiceURI).toBe('pt-local-a');
  });
  it('anything already speaking is cancelled first (no two voices at once)', () => {
    const { win, cancels } = synthWin();
    createWebSpeechSynthesis(win).speak('oi', OPTS, speechRecorder().cb);
    expect(cancels()).toBe(1);
  });
  it('long text is spoken in sentence-sized pieces, one after another, and "end" is reported only after the LAST', () => {
    const { win, spoken } = synthWin();
    const r = speechRecorder();
    const text = Array.from({ length: 6 }, (_, i) => `Esta é a frase número ${i + 1}, com um tamanho razoável para forçar a divisão.`).join(' ');
    createWebSpeechSynthesis(win).speak(text, OPTS, r.cb);
    expect(spoken).toHaveLength(1);
    spoken[0]!.onstart!();
    for (let i = 0; i < 20 && r.log.at(-1) !== 'end'; i++) {
      expect(r.log).not.toContain('end');
      spoken.at(-1)!.onend!();
      if (r.log.at(-1) === 'end') break;
    }
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.every((u) => u.text.length <= 200)).toBe(true);
    expect(r.log).toEqual(['start', 'end']);
  });
  it('cancel() stops it and reports "cancelled" (not an error), once; the browser\'s "canceled" error event is not a failure either', () => {
    const { win, spoken } = synthWin();
    const r = speechRecorder();
    const h = createWebSpeechSynthesis(win).speak('Uma resposta.', OPTS, r.cb);
    h.cancel();
    h.cancel();
    spoken[0]!.onerror!({ error: 'canceled' });
    expect(r.log).toEqual(['cancelled']);
    const r2 = speechRecorder();
    const w2 = synthWin();
    createWebSpeechSynthesis(w2.win).speak('Outra.', OPTS, r2.cb);
    w2.spoken[0]!.onerror!({ error: 'interrupted' });
    expect(r2.log).toEqual(['cancelled']);
  });
  it('a real synthesis failure is reported as an error, once', () => {
    const { win, spoken } = synthWin();
    const r = speechRecorder();
    createWebSpeechSynthesis(win).speak('Oi.', OPTS, r.cb);
    spoken[0]!.onerror!({ error: 'synthesis-failed' });
    spoken[0]!.onend?.();
    expect(r.log).toEqual(['error']);
  });
  it('nothing to say (empty after chunking) ends at once without touching the speakers', () => {
    const { win, spoken } = synthWin();
    const r = speechRecorder();
    createWebSpeechSynthesis(win).speak('   ', OPTS, r.cb);
    expect(spoken).toHaveLength(0);
    expect(r.log).toEqual(['end']);
  });
  it('with no synthesis API, speak() throws (the manager reports the written answer as the only output)', () => {
    expect(() => createWebSpeechSynthesis({}).speak('oi', OPTS, speechRecorder().cb)).toThrow();
  });
  it('orderVoices does not mutate its input', () => {
    const v: VoiceInfo[] = [{ id: 'b', name: 'B', lang: 'en-US', local: true }, { id: 'a', name: 'A', lang: 'pt-BR', local: true }];
    const copy = JSON.stringify(v);
    orderVoices(v);
    expect(JSON.stringify(v)).toBe(copy);
  });
});
