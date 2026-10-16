/**
 * What is spoken and which answer is the one (web/lib/speech/reply.ts), and the preferences (web/lib/speech/prefs.ts). Pure.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../web/lib/conversation.js';
import { DEFAULT_VOICE_PREFS, parseVoicePrefs } from '../../web/lib/speech/prefs.js';
import { chunkForSpeech, replyAfter, SPEAK_MAX, speakableText } from '../../web/lib/speech/reply.js';

describe('speakableText', () => {
  it('keeps plain text and strips Markdown, links, evidence handles and bare URLs', () => {
    expect(speakableText('Você tem **3 tarefas** [C1] abertas.')).toBe('Você tem 3 tarefas abertas.');
    expect(speakableText('Veja [o relatório](https://example.test/x) agora.')).toBe('Veja o relatório agora.');
    expect(speakableText('Acesse https://example.test/muito/longo?x=1 para ver.')).toBe('Acesse um link para ver.');
    expect(speakableText('# Título\n\n- primeiro\n- segundo\n\n1. um\n2. dois')).toBe('Título primeiro segundo um dois');
    expect(speakableText('> citação\n`código` e _ênfase_ e ~~riscado~~')).toBe('citação código e ênfase e riscado');
  });
  it('code blocks and tables are NOT read out: a short note says the rest is on screen', () => {
    expect(speakableText('Aqui vai:\n```ts\nconst x = 1;\n```\nPronto.')).toBe('Aqui vai: Pronto. O restante está na tela.');
    expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Mostrei o resultado na tela.');
    expect(speakableText('Resumo.\n\n| a | b |\n| 1 | 2 |')).toBe('Resumo. O restante está na tela.');
  });
  it('images and control characters disappear; empty in, empty out', () => {
    expect(speakableText('Olá ![logo](https://x.test/a.png) mundo\u0007')).toBe('Olá mundo');
    expect(speakableText('')).toBe('');
    expect(speakableText('   \n  ')).toBe('');
  });
  it('very long answers are cut at a sentence and say the rest is on screen', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Esta é a frase ${i + 1}.`).join(' ');
    const out = speakableText(long);
    expect(out.endsWith('O resto está na tela.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(SPEAK_MAX + 30);
    expect(out).toMatch(/\.\s+O resto está na tela\.$/);
  });
  it('a card-masked number is read as it is (the mask text, never anything recovered)', () => {
    expect(speakableText('Cartão [cartão ocultado] aprovado.')).toBe('Cartão [cartão ocultado] aprovado.');
  });
});

describe('replyAfter: the answer to THIS spoken turn only', () => {
  const u = (id: string, text = 'pergunta'): ConversationItem => ({ kind: 'user', id, text });
  const a = (id: string, text: string): ConversationItem => ({ kind: 'assistant', id, text });
  const card = (id: string): ConversationItem => ({ kind: 'card', id, name: 'show_answer', toolCall: { id, type: 'function', function: { name: 'show_answer', arguments: '{}' } }, toolMessage: undefined }) as ConversationItem;
  it('the assistant text after the message, up to the next user message; cards are skipped', () => {
    const items = [u('u0'), a('a0', 'velha'), u('u1'), card('c1'), a('a1', 'resposta nova'), u('u2'), a('a2', 'outra')];
    expect(replyAfter(items, 'u1')).toBe('resposta nova');
    expect(replyAfter(items, 'u0')).toBe('velha');
  });
  it('several assistant texts are joined in order', () => {
    expect(replyAfter([u('u1'), a('a1', 'primeira'), a('a2', 'segunda')], 'u1')).toBe('primeira\n\nsegunda');
  });
  it('null while there is no answer yet, or when the message is not there (never a guess, never the previous answer)', () => {
    expect(replyAfter([u('u1')], 'u1')).toBeNull();
    expect(replyAfter([u('u0'), a('a0', 'velha'), u('u1')], 'u1')).toBeNull();
    expect(replyAfter([u('u0'), a('a0', 'velha')], 'missing')).toBeNull();
    expect(replyAfter([], 'u1')).toBeNull();
    expect(replyAfter([u('u1'), card('c1')], 'u1')).toBeNull(); // cards only: nothing to say
  });
});

describe('chunkForSpeech', () => {
  it('splits on sentences, keeps every piece within the limit and loses no words', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Frase de teste número ${i + 1} termina aqui.`).join(' ');
    const parts = chunkForSpeech(text, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });
  it('one very long sentence is split at spaces, not mid-word', () => {
    const word = 'palavra';
    const text = Array.from({ length: 80 }, () => word).join(' ');
    const parts = chunkForSpeech(text, 60);
    expect(parts.every((p) => p.length <= 60)).toBe(true);
    expect(parts.join(' ')).toBe(text);
    expect(parts.every((p) => p.split(' ').every((w) => w === word))).toBe(true);
  });
  it('empty and whitespace give no pieces; short text is one piece', () => {
    expect(chunkForSpeech('')).toEqual([]);
    expect(chunkForSpeech('   ')).toEqual([]);
    expect(chunkForSpeech('Oi.')).toEqual(['Oi.']);
  });
});

describe('voice preferences', () => {
  it('defaults: consent OFF, auto-send OFF, read answers ON, pt-BR', () => {
    expect(DEFAULT_VOICE_PREFS).toMatchObject({ consented: false, autoSend: false, speakReplies: true, lang: 'pt-BR', rate: 1, volume: 1, voiceId: null });
  });
  it('anything that is not an object gives the defaults', () => {
    for (const bad of [null, undefined, 'x', 7, true]) expect(parseVoicePrefs(bad), String(bad)).toEqual(DEFAULT_VOICE_PREFS);
  });
  it('consent and auto-send turn ON only for an explicit true (a string "true" or 1 does not)', () => {
    expect(parseVoicePrefs({ consented: true, autoSend: true })).toMatchObject({ consented: true, autoSend: true });
    for (const v of ['true', 1, 'yes', {}, [], null]) expect(parseVoicePrefs({ consented: v, autoSend: v }), String(v)).toMatchObject({ consented: false, autoSend: false });
  });
  it('numbers are clamped; non-numbers fall back; the voice id must be a short string; the language is always pt-BR', () => {
    expect(parseVoicePrefs({ rate: 9, volume: -3 })).toMatchObject({ rate: 2, volume: 0 });
    expect(parseVoicePrefs({ rate: 0.01, volume: 7 })).toMatchObject({ rate: 0.5, volume: 1 });
    expect(parseVoicePrefs({ rate: 'fast', volume: NaN })).toMatchObject({ rate: 1, volume: 1 });
    expect(parseVoicePrefs({ voiceId: 'x'.repeat(301) }).voiceId).toBeNull();
    expect(parseVoicePrefs({ voiceId: 7 }).voiceId).toBeNull();
    expect(parseVoicePrefs({ voiceId: 'com.apple.voice.pt' }).voiceId).toBe('com.apple.voice.pt');
    expect(parseVoicePrefs({ lang: 'en-US' }).lang).toBe('pt-BR');
  });
  it('a stored value round-trips', () => {
    const p = { ...DEFAULT_VOICE_PREFS, consented: true, rate: 1.5, volume: 0.4, voiceId: 'v1' };
    expect(parseVoicePrefs(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

import { decideReply } from '../../web/lib/speech/reply.js';
import { micEnabled, micLabel, statusLine, ERROR_TEXT, NOTICE_TEXT, CONSENT_BODY } from '../../web/lib/speech/copy.js';
import { INITIAL_VOICE_STATE } from '../../web/lib/speech/machine.js';

describe('decideReply: when the spoken turn can be answered', () => {
  const u = (id: string): ConversationItem => ({ kind: 'user', id, text: 'pergunta' });
  const a = (id: string, text: string): ConversationItem => ({ kind: 'assistant', id, text });
  const base = { userId: 'u1', error: null as string | null, running: false, runDone: false };
  it('waits while a run is going, even if an answer is already on screen', () => {
    expect(decideReply({ ...base, items: [u('u1'), a('a1', 'oi')], running: true })).toEqual({ do: 'wait' });
  });
  it('a failed turn is "failed" (nothing is spoken), whatever else is on screen', () => {
    expect(decideReply({ ...base, items: [u('u1'), a('a1', 'oi')], error: 'falhou' })).toEqual({ do: 'failed' });
    expect(decideReply({ ...base, items: [u('u1')], error: 'falhou', runDone: true })).toEqual({ do: 'failed' });
  });
  it('the answer to THIS message is spoken in its speakable form; an older answer is never spoken for a newer message', () => {
    expect(decideReply({ ...base, items: [u('u0'), a('a0', 'velha'), u('u1'), a('a1', 'Você tem **3** tarefas.')] })).toEqual({ do: 'reply', text: 'Você tem 3 tarefas.' });
    expect(decideReply({ ...base, items: [u('u0'), a('a0', 'velha'), u('u1')] })).toEqual({ do: 'wait' });
  });
  it('before the run is known to be over, no answer means wait; after it, an empty reply (cards only) means "nothing to speak"', () => {
    expect(decideReply({ ...base, items: [u('u1')] })).toEqual({ do: 'wait' });
    expect(decideReply({ ...base, items: [u('u1')], runDone: true })).toEqual({ do: 'reply', text: '' });
  });
  it('an answer that is only a table is spoken as a short pointer to the screen, not read out', () => {
    expect(decideReply({ ...base, items: [u('u1'), a('a1', '| a | b |\n| 1 | 2 |')] })).toEqual({ do: 'reply', text: 'Mostrei o resultado na tela.' });
  });
});

describe('the words the voice UI says', () => {
  const st = (over: Partial<typeof INITIAL_VOICE_STATE>) => ({ ...INITIAL_VOICE_STATE, ...over });
  it('never says "Ouvindo" while the microphone is not live (the permission prompt, a blocked microphone)', () => {
    expect(statusLine(st({ kind: 'LISTENING', micLive: false }))).toMatch(/Aguardando o microfone/);
    expect(statusLine(st({ kind: 'LISTENING', micLive: false }))).not.toMatch(/Ouvindo/);
    expect(statusLine(st({ kind: 'LISTENING', micLive: true }))).toBe('Ouvindo…');
    expect(statusLine(st({ kind: 'LISTENING', micLive: true, interim: 'quais são' }))).toBe('Ouvindo… quais são');
  });
  it('every error code has words and tells the person what to do; permission says it is blocked and where to fix it', () => {
    for (const code of ['unsupported', 'permission', 'no_microphone', 'network', 'provider', 'reply_failed', 'timeout'] as const) {
      const line = statusLine(st({ kind: 'ERROR', error: { code, retryable: false } }));
      expect(line, code).toBe(ERROR_TEXT[code]);
      expect(line!.length, code).toBeGreaterThan(20);
    }
    expect(ERROR_TEXT.permission).toMatch(/bloqueado/);
    expect(ERROR_TEXT.permission).toMatch(/cadeado/);
    expect(ERROR_TEXT.unsupported).toMatch(/escreva/);
  });
  it('states and notices: review, speaking, interrupted, silence and a speech failure that says the answer is on screen', () => {
    expect(statusLine(st({ kind: 'TRANSCRIBING' }))).toBe('Revise o texto e envie.');
    expect(statusLine(st({ kind: 'SPEAKING' }))).toMatch(/interromper/);
    expect(statusLine(st({ kind: 'INTERRUPTED' }))).toMatch(/Parando/);
    expect(statusLine(st({ kind: 'THINKING' }))).toBeNull();
    expect(statusLine(st({ kind: 'IDLE' }))).toBeNull();
    expect(statusLine(st({ kind: 'IDLE', notice: 'no_speech' }))).toBe(NOTICE_TEXT.no_speech);
    expect(NOTICE_TEXT.speech_failed).toMatch(/na tela/);
  });
  it('the microphone button is named for what it does now, and is not pressable while a turn is out or speech is stopping', () => {
    expect(micLabel('IDLE')).toBe('Falar com a Wendy');
    expect(micLabel('LISTENING')).toBe('Parar de ouvir');
    expect(micLabel('SPEAKING')).toMatch(/Interromper/);
    for (const k of ['THINKING', 'INTERRUPTED'] as const) expect(micEnabled(k), k).toBe(false);
    for (const k of ['IDLE', 'LISTENING', 'TRANSCRIBING', 'SPEAKING', 'ERROR'] as const) expect(micEnabled(k), k).toBe(true);
  });
  it('the disclosure says where the audio may go, that the text is reviewed, and that the rules are the usual ones', () => {
    expect(CONSENT_BODY).toMatch(/Google/);
    expect(CONSENT_BODY).toMatch(/revisa/);
    expect(CONSENT_BODY).toMatch(/aprovação/);
    expect(CONSENT_BODY).toMatch(/não grava/);
  });
});
