/**
 * Card-data redaction (src/security/cardRedaction.ts), as hardened in Phase 1.3.15. Pure: no database, no network, no provider,
 * no agent. Every card number below is SYNTHETIC (test numbers or numbers generated here with a Luhn check digit).
 *
 * Sections: separators and boundaries, labels, security code and expiry, idempotence and partial masks, documented limits,
 * strategy comparison on a documented corpus, redactSecrets (other secrets unchanged), and the destinations that really use
 * the redactor (recordedError, loggableError, the model_calls.error written by the Claude client, toExecutionError).
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { friendlyRunError, loggableError } from '../../src/agent/errors.js';
import { saveMessages } from '../../src/agent/chatLog.js';
import { ClaudeReasoningClient, finishModelCall } from '../../src/cognition/llm.js';
import { DEFAULT_RETRY_POLICY, recordedError, redactSecrets, withRetry } from '../../src/cognition/resilience.js';
import type { Db, Queryable } from '../../src/db/db.js';
import { CARD_MASK, maskCardData, maskCardDeep } from '../../src/security/cardRedaction.js';
import { toExecutionError } from '../../src/skills/runtime.js';
import { grouped, groupedAmex, legacyLuhnOnly, negativeSets, positiveNumbers, unknownIssuerNumbers } from '../helpers/cardCorpus.js';

const M = CARD_MASK;
const VISA = '4111111111111111';
const MC = '5555555555554444';
const AMEX = '378282246310005';
const DINERS = '30569309025904';
const ELO_LIKE = '6362970000457013'; // Luhn-valid, 636 prefix
const mapDigits = (s: string, zero: number) => Array.from(s, (c) => String.fromCharCode(zero + c.charCodeAt(0) - 48)).join('');

describe('number recognition: separators and boundaries (all cases that leaked in the Phase 1.3.14 audit)', () => {
  const g = (sep: string) => grouped(VISA, sep);
  const SEPARATORS: [string, string][] = [
    ['one space', ' '], ['two spaces', '  '], ['hyphen', '-'], ['space-hyphen-space', ' - '], ['dot', '.'], ['slash', '/'], ['tab', '\t'], ['newline', '\n'], ['NBSP', ' '], ['zero-width space', '​'],
  ];
  for (const [name, sep] of SEPARATORS) {
    it(`a grouped number separated by ${name} is fully masked`, () => {
      expect(maskCardData(`payment for ${g(sep)} failed`)).toBe(`payment for ${M} failed`);
    });
  }
  it('a contiguous number is masked, whatever surrounds it', () => {
    expect(maskCardData(`card ${VISA} ok`)).toBe(`card ${M} ok`);
    expect(maskCardData(`x${VISA}y`)).toBe(`x${M}y`);
    expect(maskCardData(`id_${VISA}_x`)).toBe(`id_${M}_x`);
    expect(maskCardData(`pan:${VISA},`)).toBe(`pan:${M},`);
    expect(maskCardData(`https://x.test/pay?n=${VISA}&a=1`)).toBe(`https://x.test/pay?n=${M}&a=1`);
  });
  it('adjacent hyphens do not hide a number (order-<PAN>, <PAN>-ABC)', () => {
    expect(maskCardData(`order-${VISA} failed`)).toBe(`order-${M} failed`);
    expect(maskCardData(`${VISA}-ABC`)).toBe(`${M}-ABC`);
    expect(maskCardData(`ref-${MC}-retry`)).toBe(`ref-${M}-retry`);
  });
  it('other card shapes: 4-6-5 (amex), 4-6-4 (diners), 13 and 19 digits, a number typed digit by digit', () => {
    expect(maskCardData(`a ${groupedAmex(AMEX)} b`)).toBe(`a ${M} b`);
    expect(maskCardData(`a ${groupedAmex(DINERS, '-')} b`)).toBe(`a ${M} b`);
    expect(maskCardData('a 4222222222222 b')).toBe(`a ${M} b`);
    expect(maskCardData(`a ${Array.from(VISA).join(' ')} b`)).toBe(`a ${M} b`);
    expect(maskCardData(ELO_LIKE)).toBe(M);
  });
  it('digits of other scripts are recognised one by one, and only the matched span is replaced', () => {
    expect(maskCardData(`n ${mapDigits(VISA, 0xff10)} é`)).toBe(`n ${M} é`); // fullwidth
    expect(maskCardData(`n ${mapDigits(VISA, 0x0660)} é`)).toBe(`n ${M} é`); // Arabic-Indic
    expect(maskCardData(`ｃａｒｄ ${VISA}`)).toBe(`ｃａｒｄ ${M}`); // the fullwidth letters of the surrounding text are NOT normalised
  });
  it('a serialised JSON string and an escaped string-of-JSON are masked the same way', () => {
    expect(maskCardData(`{"card":"${VISA}"}`)).toBe(`{"card":"${M}"}`);
    expect(maskCardData(`{"number":"${VISA}"}`)).toBe(`{"number":"${M}"}`);
    expect(maskCardData(JSON.stringify(JSON.stringify({ card: VISA })))).toBe(`"{\\"card\\":\\"${M}\\"}"`);
  });
  it('a multi-line message keeps everything that is not the card', () => {
    const msg = `Payment failed\ncard: ${grouped(VISA)}\nretry in 30 s\nreq 1791684469123`;
    expect(maskCardData(msg)).toBe(`Payment failed\ncard: ${M}\nretry in 30 s\nreq 1791684469123`);
  });
  it('two cards in one text, and a card next to other numbers', () => {
    expect(maskCardData(`${VISA} and ${MC}`)).toBe(`${M} and ${M}`);
    expect(maskCardData(`${grouped(VISA)} 2026-10-10 22:03:48`)).toBe(`${M} 2026-10-10 22:03:48`);
  });
});

describe('number recognition: labels are evidence, Luhn alone is not', () => {
  const NOT_LUHN = '4111111111111112';
  it('a labelled number is masked even when it fails Luhn or has an unknown issuer', () => {
    expect(maskCardData(`card number: ${NOT_LUHN}`)).toBe(`card number: ${M}`);
    expect(maskCardData(`cartão ${NOT_LUHN}`)).toBe(`cartão ${M}`);
    expect(maskCardData(`Número do cartão: ${grouped('9999888877776666')}`)).toBe(`Número do cartão: ${M}`);
    expect(maskCardData(`credit card=${NOT_LUHN}`)).toBe(`credit card=${M}`);
    expect(maskCardData(`{"cardNumber":"${NOT_LUHN}"}`)).toBe(`{"cardNumber":"${M}"}`);
    expect(maskCardData(`cc_number: ${NOT_LUHN}`)).toBe(`cc_number: ${M}`);
    expect(maskCardData(`pan=${NOT_LUHN}`)).toBe(`pan=${M}`);
  });
  it('an unlabelled number that fails Luhn is left alone', () => {
    expect(maskCardData(`ref ${NOT_LUHN} ok`)).toBe(`ref ${NOT_LUHN} ok`);
    expect(maskCardData(`ref ${grouped(NOT_LUHN)} ok`)).toBe(`ref ${grouped(NOT_LUHN)} ok`);
  });
  it('a label that is part of another word is not a label', () => {
    expect(maskCardData(`panel ${NOT_LUHN}`)).toBe(`panel ${NOT_LUHN}`);
    expect(maskCardData(`cardio ${NOT_LUHN}`)).toBe(`cardio ${NOT_LUHN}`);
    expect(maskCardData(`accc ${NOT_LUHN}`)).toBe(`accc ${NOT_LUHN}`);
  });
  it('a label far from the number does not label it', () => {
    expect(maskCardData(`card holder Maria Souza, order ${NOT_LUHN}`)).toBe(`card holder Maria Souza, order ${NOT_LUHN}`);
  });
  it('a labelled 19-digit number grouped 4-4-4-4-3 is covered to its last digit', () => {
    const p19 = '4111111111111111113';
    expect(maskCardData(`card ${grouped(p19)}.`)).toBe(`card ${M}.`);
  });
});

describe('security code and expiry: only next to their label, only the value is replaced', () => {
  const CASES: [string, string][] = [
    ['CVC: 123', `CVC: ${M}`], ['cvv=4567', `cvv=${M}`], ['CVV2: 123', `CVV2: ${M}`], ['CVC2 123', `CVC2 ${M}`], ['security code 123', `security code ${M}`],
    ['Security Code: 4567', `Security Code: ${M}`], ['card verification value 123', `card verification value ${M}`], ['CID 1234', `CID ${M}`],
    ['código de segurança: 123', `código de segurança: ${M}`], ['codigo de seguranca 123', `codigo de seguranca ${M}`], ['cód. de segurança 123', `cód. de segurança ${M}`],
    ['validade 08/29', `validade ${M}`], ['vencimento 08/29', `vencimento ${M}`], ['venc.: 08/2029', `venc.: ${M}`], ['val.: 08/29', `val.: ${M}`],
    ['exp: 12/2030', `exp: ${M}`], ['expires 08/2029', `expires ${M}`], ['expiry 08/29', `expiry ${M}`], ['expiry date: 08/29', `expiry date: ${M}`], ['expiration date 08-29', `expiration date ${M}`],
    ['valid thru 08/29', `valid thru ${M}`], ['MM/YY 08/29', `MM/YY ${M}`], ['mm / yyyy 08/2029', `mm / yyyy ${M}`],
    ['exp_month=08 exp_year=2029', `exp_month=${M} exp_year=${M}`], ['{"expiry_month":"8","expiry_year":"29"}', `{"expiry_month":"${M}","expiry_year":"${M}"}`],
    ['{"card":"x","cvv":"123","exp":"08/29"}', `{"card":"x","cvv":"${M}","exp":"${M}"}`],
  ];
  for (const [input, expected] of CASES) it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => expect(maskCardData(input)).toBe(expected));

  it('a label with a malformed or missing value keeps the whole text', () => {
    for (const s of ['cvv: abc', 'cvc: 12', 'cvc: 12345', 'CVC', 'cvv:', 'expiry: soon', 'expires 13/29', 'expires 08', 'expiry date: 08/2', 'exp_month=13']) expect(maskCardData(s), s).toBe(s);
  });
  it('a value without its label, and a label inside another word, are not touched', () => {
    for (const s of ['the code 123 and the date 08/29', '08/29', 'cvcs 123', 'expression 08/29', 'valid 08/29', 'subcvc 123', 'x-exp-y 08/29']) expect(maskCardData(s), s).toBe(s);
  });
  it('a full payment message: everything else survives', () => {
    expect(maskCardData(`declined: card ${grouped(VISA)}, cvc 123, expires 08/29, amount 25.99, order-77`)).toBe(`declined: card ${M}, cvc ${M}, expires ${M}, amount 25.99, order-77`);
  });
});

describe('idempotence and partial masks', () => {
  const SAMPLES = [
    `card ${grouped(VISA)} cvc 123 expires 08/29`, `order-${VISA}-x`, `${M} ${VISA}`, `card ${M} 9999888877776666`, `{"card":"${VISA}","cvv":"123"}`, 'plain text', '', `${grouped(VISA, '\n')}`,
    `cartão ${M} ${M}`, `card [cartão ocultado] ${unknownIssuerNumbers(1)[0]}`,
  ];
  it('masking twice gives the same text as masking once', () => {
    for (const s of SAMPLES) expect(maskCardData(maskCardData(s)), JSON.stringify(s)).toBe(maskCardData(s));
  });
  it('the text of an earlier mask never triggers a label', () => {
    const t = `card ${M} ${unknownIssuerNumbers(1)[0]}`; // a label word inside the mask, then an unlabelled unknown-issuer number
    expect(maskCardData(t)).toBe(t);
  });
  it('partial masks and the last four digits alone are left as they are', () => {
    for (const s of ['4111 11** **** 1111', '**** **** **** 1111', 'ending in 1111', 'xxxx-xxxx-xxxx-1111', '4111-11XX-XXXX-1111']) expect(maskCardData(s), s).toBe(s);
  });
});

describe('inputs outside the contract and malformed input', () => {
  it('empty, non-string and undefined inputs come back as they are, without throwing', () => {
    expect(maskCardData('')).toBe('');
    expect(maskCardData(undefined as unknown as string)).toBeUndefined();
    expect(maskCardData(null as unknown as string)).toBeNull();
    expect(maskCardData(4111111111111111 as unknown as string)).toBe(4111111111111111);
    expect(maskCardData({} as unknown as string)).toEqual({});
  });
  it('digit runs that cannot be a card are untouched: 12 digits, 20+ digits, 30 digits', () => {
    for (const s of ['630495060000', `99${VISA}99`, '1'.repeat(30), '4'.repeat(12), '4'.repeat(25)]) expect(maskCardData(s), s).toBe(s);
  });
  it('is deterministic and linear on large and hostile inputs', () => {
    const big = `${'lorem ipsum '.repeat(40000)}${VISA}`;
    const t0 = performance.now();
    expect(maskCardData(big)).toBe(`${'lorem ipsum '.repeat(40000)}${M}`);
    for (const s of ['1'.repeat(200000), '1 '.repeat(100000), '1-'.repeat(100000), '1234 '.repeat(50000), `card ${M} `.repeat(20000)]) maskCardData(s);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('documented limits: what is NOT covered (these pin the contract so a change is noticed)', () => {
  it('encoded content, spelled-out numbers and numbers split across strings are not inspected', () => {
    for (const s of [Buffer.from(VISA).toString('base64'), 'four one one one one one one one one one one one one one one one', '4111 1111', '1111 1111']) expect(maskCardData(s), s).toBe(s);
  });
  it('an unlabelled, ungrouped number of an issuer that is not in the table is not masked (labelled or grouped it is)', () => {
    for (const p of unknownIssuerNumbers(5)) {
      expect(maskCardData(`error for ${p} declined`), p).toBe(`error for ${p} declined`);
      expect(maskCardData(`card number: ${p}`), p).toBe(`card number: ${M}`);
      expect(maskCardData(`error for ${grouped(p)} declined`), p).toBe(`error for ${M} declined`);
    }
  });
  it('a value after exp/cvv in another script, and 12-digit cards, are outside the rules', () => {
    expect(maskCardData(`cvv ${mapDigits('123', 0xff10)}`)).toBe(`cvv ${mapDigits('123', 0xff10)}`);
  });
  it('a card-LOOKING number that is something else IS masked: Luhn plus a known prefix cannot tell them apart', () => {
    const lookalike = '4000000000000002'; // Luhn-valid, Visa-shaped: could just as well be an order id
    expect(maskCardData(`order ${lookalike}`)).toBe(`order ${M}`);
  });
});

describe('strategy comparison on a documented synthetic corpus', () => {
  const POS = positiveNumbers(20); // 12 network specs x 20 = 240 Luhn-valid numbers
  const UNKNOWN = unknownIssuerNumbers(100);
  const NEG = negativeSets(2000); // 12 sets x 2000, each with its construction in `how`
  const A = (t: string) => maskCardData(t, { unlabeled: false }); // contextual only
  const B = (t: string) => maskCardData(t); // contextual + unlabelled (grouped, or contiguous with a known prefix)
  const form = {
    bare: (p: string) => `error for ${p} declined`,
    grouped: (p: string) => `error for ${p.length === 14 || p.length === 15 ? groupedAmex(p) : grouped(p)} declined`,
    hyphen: (p: string) => `order-${p} failed`,
    labelled: (p: string) => `card number: ${p} failed`,
    jsonNumber: (p: string) => `{"number":"${p}"}`,
  };
  const leaks = (fn: (t: string) => string, make: (p: string) => string, pans: string[]) => pans.filter((p) => !fn(make(p)).includes(M)).length;
  const pans = POS.map((p) => p.pan);
  const fpRate = (fn: (t: string) => string, set: { items: string[] }) => set.items.filter((it) => fn(`ref ${it} ok`) !== `ref ${it} ok`).length / set.items.length;
  const set = (name: string) => NEG.find((s) => s.name === name)!;

  it('the corpus is what it says it is', () => {
    expect(POS).toHaveLength(240);
    expect(new Set(POS.map((p) => p.name)).size).toBe(12);
    expect(UNKNOWN).toHaveLength(100);
    expect(NEG).toHaveLength(12);
    for (const s of NEG) expect(s.items, s.name).toHaveLength(2000);
    for (const p of pans) expect(legacyLuhnOnly(p), p).toBe(M); // every positive really is Luhn-valid
  });
  it('chosen strategy B: no leak on the known-network positives in any form, labelled or not, hyphen-adjacent or not', () => {
    for (const [name, make] of Object.entries(form)) expect(leaks(B, make, pans), name).toBe(0);
  });
  it('strategy A (contextual only) leaks every bare, grouped or hyphen-adjacent number that has no label; it masks the labelled ones', () => {
    expect(leaks(A, form.bare, pans)).toBe(240);
    expect(leaks(A, form.grouped, pans)).toBe(240);
    expect(leaks(A, form.hyphen, pans)).toBe(240);
    expect(leaks(A, form.jsonNumber, pans)).toBe(240); // "number" is not a card label
    expect(leaks(A, form.labelled, pans)).toBe(0);
  });
  it('the previous Luhn-only rule leaked every hyphen-adjacent number (the audit finding) and masked about 10% of unrelated numbers', () => {
    expect(leaks(legacyLuhnOnly, form.hyphen, pans)).toBe(240);
    for (const n of ['epoch-ms', 'br-mobile-+55', 'cnpj-unformatted', 'phone-formatted', 'order-16-random', 'order-19-random', 'decimal']) {
      const r = fpRate(legacyLuhnOnly, set(n));
      expect(r, n).toBeGreaterThan(0.07);
      expect(r, n).toBeLessThan(0.13);
    }
  });
  it('B keeps the unrelated formats intact: timestamps, phones, formatted CNPJ, UUIDs and ISO dates have no false positive in 2000 samples each', () => {
    for (const n of ['epoch-ms', 'br-mobile-+55', 'cnpj-formatted', 'phone-formatted', 'ts-13-LUHN-VALID', 'uuid-v4', 'iso-timestamp']) expect(fpRate(B, set(n)), n).toBe(0);
  });
  it('B: the residual false positives are small on random ids and are the card-lookalikes by construction', () => {
    expect(fpRate(B, set('cnpj-unformatted'))).toBeLessThan(0.01); // measured 7/2000
    expect(fpRate(B, set('decimal'))).toBeLessThan(0.01); // measured 10/2000
    expect(fpRate(B, set('order-16-random'))).toBeLessThan(0.05); // measured 59/2000
    expect(fpRate(B, set('order-19-random'))).toBeLessThan(0.05); // measured 41/2000
    const lookalike = fpRate(B, set('order-16-LUHN-VALID')); // measured 611/2000: Luhn-valid + a known prefix is what a card looks like
    expect(lookalike).toBeGreaterThan(0.2);
    expect(lookalike).toBeLessThan(0.4);
  });
  it('A has no false positive on any of the 12 negative sets (the price is the leaks above)', () => {
    for (const s of NEG) expect(fpRate(A, s), s.name).toBe(0);
  });
  it('a bare number of an issuer outside the table leaks under both strategies; it is masked when labelled', () => {
    expect(UNKNOWN.filter((p) => B(`error for ${p} declined`).includes(p))).toHaveLength(100);
    expect(UNKNOWN.filter((p) => B(`card number: ${p}`).includes(p))).toHaveLength(0);
  });
});

describe('redactSecrets: other secrets behave exactly as before the card rule', () => {
  // The three replacements redactSecrets applied before this rule existed (Phase 1.2), reproduced here as the reference.
  const before = (raw: string) =>
    raw
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
      .replace(/(refresh_token|access_token|client_secret|api[_-]?key|authorization|bearer)(["'\s:=]+)[^\s"',}]+/gi, '$1$2<redacted>')
      .replace(/\b1\/\/[A-Za-z0-9_-]{20,}/g, '<redacted>');
  const CORPUS = [
    'Authorization: Bearer abcdefghijkl', 'api_key=sk-ant-ABC123 and API-KEY: zzz', 'refresh_token: 1//abcdefghijklmnopqrstuvwxyz', 'client_secret="s3cr3t"', 'access_token=ya29.abcdef',
    'plain message', '', 'HTTP 503 at 2026-10-10 22:03:48 for project 123456789012', 'retry after 30 s', 'Bearer', 'bearer: x', '{"authorization":"Bearer abcdefgh12345678"}', 'line1\nAuthorization: Bearer abcdefghijkl\nline3',
  ];
  it('is identical to the earlier behaviour on every non-card input', () => {
    for (const s of CORPUS) expect(redactSecrets(s), JSON.stringify(s)).toBe(before(s));
  });
  it('still redacts the secret first and the card second, and returns a string for every input', () => {
    expect(redactSecrets(`Authorization: Bearer abcdefghijkl, card ${grouped(VISA)}`)).toBe(`Authorization: <redacted> <redacted>, card ${M}`);
    expect(redactSecrets(`token 1//abcdefghijklmnopqrstuvwxyz order-${VISA}`)).toBe(`token <redacted> order-${M}`);
  });
});

describe('destinations that really use the redactor (observed values, not the function in isolation)', () => {
  const PAN_TEXT = `declined: card ${grouped(VISA)}, cvc 123, expires 08/29, order-${MC}`;
  const CLEAN = `declined: card ${M}, cvc ${M}, expires ${M}, order-${M}`;

  it('loggableError (the agent console.error) carries the masked text, redacts before it clips, and keeps the name', () => {
    expect(loggableError(new Error(PAN_TEXT))).toBe(`Error: ${CLEAN}`);
    const cut = loggableError(new Error(`${'x'.repeat(385)} ${VISA} tail`)); // the card would straddle the 400-char limit if clipping came first
    expect(cut).not.toMatch(/4111/);
    expect(cut.length).toBeLessThanOrEqual(400);
    expect(loggableError(Object.assign(new TypeError('bad'), { name: 'TypeError' }))).toBe('TypeError: bad');
    expect(loggableError('not an error')).toBe('Error: not an error');
  });
  it('recordedError (what is stored in model_calls.error) carries the masked text and keeps the class prefix', () => {
    expect(recordedError(new Error(PAN_TEXT))).toBe(`Error: ${CLEAN}`);
    expect(recordedError(Object.assign(new Error(PAN_TEXT), { status: 503 }))).toBe(`TRANSIENT: Error: ${CLEAN}`);
    expect(recordedError(Object.assign(new Error(PAN_TEXT), { status: 401 }))).toBe(`AUTH: Error: ${CLEAN}`);
    expect(recordedError('Authorization: Bearer abcdefghijkl')).toBe('Authorization: <redacted> <redacted>'); // the earlier (unchanged) rules apply the key rule after the Bearer rule
  });
  it('the Claude client writes the masked text to model_calls.error: the value that reaches the database call is checked', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[]) => void calls.push({ sql, params })) } as unknown as Db;
    const client = { beta: { messages: { parse: async () => { throw new Error(PAN_TEXT); } } }, messages: {} } as never;
    const req = { purpose: 'test', principalId: '00000000-0000-4000-8000-000000000001', system: 's', user: 'u', schema: z.object({ a: z.string() }), effort: 'low' as const, evidenceRefs: [] };
    const err = await new ClaudeReasoningClient(db, { client, provider: 'anthropic', model: 'claude-test', retryDeps: { sleep: async () => {}, random: () => 0.5 } }).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const update = calls.find((c) => /^\s*UPDATE model_calls/.test(c.sql));
    expect(update, 'an UPDATE model_calls was issued').toBeTruthy();
    expect(update!.params[4]).toBe(`Error: ${CLEAN}`); // the error column
    expect(JSON.stringify(calls.map((c) => c.params[4]))).not.toMatch(/4111|5555/);
    // Phase 1.3.16: model_calls.input is masked before it is written (it was stored as sent before).
    const withCard = { ...req, user: `pay with ${VISA}` };
    const db2 = { query: vi.fn(async (sql: string, params: unknown[]) => void calls.push({ sql, params })) } as unknown as Db;
    await new ClaudeReasoningClient(db2, { client, provider: 'anthropic', model: 'claude-test', retryDeps: { sleep: async () => {}, random: () => 0.5 } }).generate(withCard).catch(() => undefined);
    const insert = calls.filter((c) => /^\s*INSERT INTO model_calls/.test(c.sql)).pop()!;
    expect(String(insert.params[5])).not.toContain(VISA);
    expect(String(insert.params[5])).toContain(`pay with ${M}`);
  });
  it('a provider failure that exhausted its retries reaches the skill run and the friendly message already masked', async () => {
    const http = Object.assign(new Error(`upstream rejected ${grouped(VISA)}`), { status: 503 });
    const raised = await withRetry(async () => { throw http; }, { ...DEFAULT_RETRY_POLICY, attempts: 2 }, { sleep: async () => {}, random: () => 0.5 }).catch((e) => e);
    expect(raised.message).toBe(`Model call failed (transient, 2 attempts): Error: upstream rejected ${M}`);
    const exec = toExecutionError(raised, 'step');
    expect(exec.code).toBe('MODEL_UNAVAILABLE');
    expect(exec.message).toBe(raised.message);
    expect(friendlyRunError(raised)).not.toMatch(/4111/);
  });
  it('toExecutionError masks the message of every error kind, including ones that did not come through the retry wrapper (Phase 1.3.16)', () => {
    const e = toExecutionError(new Error(`boom order-${VISA}`), 'step');
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toBe(`Error: boom order-${M}`);
  });
  it('model_calls.output is masked, keys are kept and non-string values are untouched (Phase 1.3.16)', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[]) => void calls.push({ sql, params })) } as unknown as Db;
    await finishModelCall(db, 'id1', { output: { text: `card ${grouped(VISA)}`, n: 7, ok: true, list: [`x ${MC}`, null] } });
    expect(calls[0]!.params[1]).toBe(JSON.stringify({ text: `card ${M}`, n: 7, ok: true, list: [`x ${M}`, null] }));
  });
  it('maskCardDeep catches a card split by a newline inside a JSON value, which masking the serialised text would miss', () => {
    const value = { t: `a ${grouped(VISA, '\n')} b` };
    expect(maskCardDeep(value)).toEqual({ t: `a ${M} b` });
    expect(maskCardData(JSON.stringify(value))).toContain('4111'); // why values are masked, not the serialised text
    expect(maskCardDeep(7)).toBe(7);
    expect(maskCardDeep(null)).toBeNull();
  });
  it('saveMessages stores the message content and tool-call arguments masked (Phase 1.3.16); ids and roles are kept', async () => {
    const calls: unknown[][] = [];
    const q = { query: vi.fn(async (_sql: string, params: unknown[]) => void calls.push(params)) } as unknown as Queryable;
    await saveMessages(q, 'p1', [
      { id: 'm1', role: 'user', content: `use card ${grouped(VISA)} cvc 123` },
      { id: 'm2', role: 'assistant', toolCalls: [{ id: 't1', type: 'function', function: { name: 'pay', arguments: JSON.stringify({ card: `${VISA}` }) } }] },
      { id: 'm3', role: 'tool', toolCallId: 't1', content: `ok ${MC}` },
      { id: 'm4', role: 'user', content: 'no card here' },
    ] as never, new Date(0));
    expect(calls.map((p) => [p[0], p[3], p[4]])).toEqual([['m1', 'user', `use card ${M} cvc ${M}`], ['m2', 'assistant', null], ['m3', 'tool', `ok ${M}`], ['m4', 'user', 'no card here']]);
    expect(calls[1]![5]).toBe(JSON.stringify([{ id: 't1', type: 'function', function: { name: 'pay', arguments: `{"card":"${M}"}` } }]));
    expect(JSON.stringify(calls)).not.toMatch(/4111|5555/);
  });
});
