/**
 * Payment-card data must never reach a log or a stored error. Adapted from Open Instinct's rule for single-use cards
 * ("never repeat the card number, expiry or CVC in a message, memory, journal or file"). Pure and deterministic.
 *
 * WHAT IT MASKS (the span is replaced by CARD_MASK; the rest of the text, hyphens and letters around it included, is kept)
 *  1. A card NUMBER, in three situations, strongest first:
 *     a. LABELLED: right after a card label (card, card number, cartão, número do cartão, credit/debit card, cc, pan, ...):
 *        13-19 digits, in any grouping, with NO Luhn or issuer check. The label is the evidence.
 *     b. UNLABELLED, GROUPED like a card (4-4-4-4, 4-4-4-4-3, 4-4-4-1..3, 4-6-5, 4-6-4) AND Luhn-valid.
 *     c. UNLABELLED, CONTIGUOUS (one run of 13-19 digits, or the same typed digit by digit) AND Luhn-valid AND a known
 *        issuer prefix with a length that network uses (NETWORKS below). Luhn alone is NOT evidence: it passes for about
 *        1 in 10 numbers.
 *  2. A SECURITY CODE (3-4 digits) right after a label: cvc, cvc2, cvv, cvv2, cid, csc, cvn, security code, card
 *     verification value/code/number, código de segurança, cód. seg.
 *  3. An EXPIRY right after a label (expires, expiry [date], exp, valid thru, validade, val., vencimento, MM/YY...): MM/YY or
 *     MM/YYYY; or a month / year value after exp_month, exp_year and similar field names.
 *
 * HOW A NUMBER IS RECOGNISED
 *  Digits are read from the ORIGINAL text, group by group. Groups joined by 1-3 separator characters (space, tab, newline, NBSP,
 *  zero-width characters, hyphens and dashes, dot, slash) form a candidate. Boundaries never depend on a space: `order-<PAN>`
 *  and `<PAN>-ABC` are found. ASCII, fullwidth and Arabic-Indic digits are accepted; each digit is converted ONE BY ONE for the
 *  checks only, so the text is never normalised as a whole and only the matched span is replaced.
 *
 * WHAT STAYS INTACT: anything that is not recognised by the rules above, in particular timestamps, phone numbers, CNPJ and
 * order ids that are not labelled as a card and do not look like one. Partial masks (4111 11** **** 1111), the last four digits
 * alone and the text of an earlier CARD_MASK are left alone, so the function is idempotent.
 *
 * NOT COVERED, on purpose or not inspected: Base64 or any other encoding, spelled-out numbers, a number split across separate
 * strings or messages, cards of 12 digits or fewer, grouped numbers whose grouping is not one of the shapes above and that
 * have no label, contiguous numbers of an issuer that is not in the table and that have no label, digits of other scripts,
 * and CVC/expiry values without their label. A card-like number that is really something else (a 16-digit order id that
 * starts with 4 and passes Luhn) is masked: see FALSE POSITIVES in docs/OPEN_INSTINCT_ADAPTATION.md. This is a log hygiene
 * measure, not a guarantee that no card data is left, and not a compliance control.
 */
export const CARD_MASK = '[cartão ocultado]';

// ── characters ───────────────────────────────────────────────────────────────────────────────────────────────
const DIGIT = '0-9\\uFF10-\\uFF19\\u0660-\\u0669\\u06F0-\\u06F9'; // ASCII, fullwidth, Arabic-Indic, extended Arabic-Indic
const SEP = '\\s\\u00A0\\u200B-\\u200D\\u2060\\uFEFF\\u2010-\\u2015\\-./'; // whitespace (tab, newline, NBSP), zero-width, dashes, dot, slash
const GROUP_RE = new RegExp(`[${DIGIT}]+`, 'gu');
const GAP_RE = new RegExp(`^[${SEP}]{1,3}$`, 'u');
const LB = '(?<![\\p{L}\\p{N}_])'; // a label is a whole word: not "panel", not "cardio"
const RB = '(?![\\p{L}\\p{N}_])';

function asciiDigit(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c >= 0xff10 && c <= 0xff19) return String.fromCharCode(48 + c - 0xff10);
  if (c >= 0x0660 && c <= 0x0669) return String.fromCharCode(48 + c - 0x0660);
  if (c >= 0x06f0 && c <= 0x06f9) return String.fromCharCode(48 + c - 0x06f0);
  return ch;
}
const toAscii = (s: string) => Array.from(s, asciiDigit).join('');

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Issuer prefixes with the lengths each network uses. A SIGNAL for unlabelled contiguous numbers, not a complete list of
 * the world's cards (a card outside it is still masked when it is labelled or grouped like a card).
 */
const NETWORKS: { name: string; prefix: RegExp; lengths: readonly number[] }[] = [
  { name: 'visa', prefix: /^4/, lengths: [13, 16, 19] },
  { name: 'mastercard', prefix: /^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/, lengths: [16] },
  { name: 'amex', prefix: /^3[47]/, lengths: [15] },
  { name: 'diners', prefix: /^(30[0-5]|3[689])/, lengths: [14, 15, 16, 17, 18, 19] },
  { name: 'discover', prefix: /^(6011|64[4-9]|65)/, lengths: [16, 17, 18, 19] },
  { name: 'jcb', prefix: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
  { name: 'unionpay', prefix: /^62/, lengths: [16, 17, 18, 19] },
  { name: 'elo', prefix: /^(636|5067|4011|4312|4389|4514|4576|5041|509)/, lengths: [16] },
  { name: 'hipercard', prefix: /^(606282|3841)/, lengths: [16, 19] },
  { name: 'maestro', prefix: /^(5018|5020|5038|5893|6304|6759|676[1-3])/, lengths: [13, 14, 15, 16, 17, 18, 19] },
];
function knownNetwork(digits: string): boolean {
  return NETWORKS.some((n) => n.prefix.test(digits) && n.lengths.includes(digits.length));
}

/** Groupings people use for a card, as sizes of consecutive digit groups. */
function cardShape(sizes: number[]): boolean {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total < 13 || total > 19 || sizes.length < 3) return false;
  if (sizes.length === 3) return sizes[0] === 4 && sizes[1] === 6 && (sizes[2] === 5 || sizes[2] === 4); // amex 4-6-5, diners 4-6-4
  if (sizes[0] !== 4) return false;
  const last = sizes[sizes.length - 1]!;
  for (let i = 1; i < sizes.length - 1; i++) if (sizes[i] !== 4) return false;
  return last >= 1 && last <= 4 && (sizes.length === 4 || (sizes.length === 5 && last <= 3));
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────────────
const AFTER = '[^\\p{L}\\p{N}]{0,8}'; // the quote, colon, equals, space or # between a label and its value
const CARD_LABEL = new RegExp(
  `${LB}(?:card(?:[\\s_-]*(?:number|num|no|nº|n°|#))?|cart[aã]o(?:\\s+de\\s+(?:cr[eé]dito|d[eé]bito))?(?:\\s*(?:n[uú]mero|num|nº|n°|#))?|n[uú]mero\\s+do\\s+cart[aã]o|(?:credit|debit)\\s+card(?:\\s+number)?|cc(?:[_\\s-]*(?:number|num|no))?|pan)${RB}(${AFTER})`,
  'giu',
);
const CVC_LABEL = `${LB}(?:cvc2?|cvv2?|cid|csc|cvn|security\\s+code|card\\s+verification\\s+(?:value|code|number)|c[oó]d(?:igo)?\\.?\\s*(?:de\\s*)?seguran[cç]a|cod\\.?\\s*seg\\.?)${RB}`;
const CVC = new RegExp(`(${CVC_LABEL})(${AFTER})(?<![\\d])(\\d{3,4})(?!\\d)`, 'giu');
const EXPIRY_LABEL = `${LB}(?:expir(?:es|y|ation)(?:\\s+date)?|exp\\.?(?:\\s+date)?|valid\\s+(?:thru|through|until|to)|validade|val\\.|vencimento|venc\\.|mm\\s*\\/\\s*(?:yy|yyyy|aa|aaaa))(?![\\p{L}\\p{N}_])`;
const EXPIRY = new RegExp(`(${EXPIRY_LABEL})(${AFTER})(?<!\\d)((?:0[1-9]|1[0-2])\\s*[/\\-.]\\s*(?:\\d{4}|\\d{2}))(?!\\d)`, 'giu');
const EXP_MONTH = new RegExp(`(${LB}exp(?:iry|iration)?[_\\s-]*(?:month|mm|m[eê]s)${RB})(${AFTER})(?<!\\d)((?:0?[1-9]|1[0-2]))(?!\\d)`, 'giu');
const EXP_YEAR = new RegExp(`(${LB}exp(?:iry|iration)?[_\\s-]*(?:year|yy|yyyy|ano)${RB})(${AFTER})(?<!\\d)(\\d{4}|\\d{2})(?!\\d)`, 'giu');

interface Span {
  start: number;
  end: number;
}
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** True when `s` overlaps any span of `sorted` (sorted by start, not overlapping each other): O(log n). */
function hitsSorted(sorted: Span[], s: Span): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.end <= s.start) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && overlaps(sorted[lo]!, s);
}

export interface MaskOptions {
  /**
   * Also recognise numbers that carry no label (rules 1b and 1c). Default true. Turning it off is the "contextual only"
   * strategy: fewer false positives, but a card pasted bare is no longer masked.
   */
  unlabeled?: boolean;
}

interface Group extends Span {
  digits: string;
  linked: boolean; // joined to the next group by 1-3 separator characters
}

/** Cost: one pass over the text for the regexes, then O(groups x 19) for the windows and O(n log n) for the overlaps. */
export function maskCardData(text: string, opts: MaskOptions = {}): string {
  if (typeof text !== 'string' || !text) return text;
  const unlabeled = opts.unlabeled !== false;

  // Text of an earlier mask is never read again (a label word inside it must not trigger anything): idempotence.
  const masks: Span[] = [];
  for (let i = text.indexOf(CARD_MASK); i !== -1; i = text.indexOf(CARD_MASK, i + CARD_MASK.length)) masks.push({ start: i, end: i + CARD_MASK.length });
  const inMask = (i: number) => hitsSorted(masks, { start: i, end: i + 1 });

  const groups: Group[] = [];
  for (const m of text.matchAll(GROUP_RE)) groups.push({ start: m.index, end: m.index + m[0].length, digits: toAscii(m[0]), linked: false });
  for (let i = 0; i + 1 < groups.length; i++) groups[i]!.linked = GAP_RE.test(text.slice(groups[i]!.end, groups[i + 1]!.start));
  const byStart = new Map(groups.map((g, i) => [g.start, i] as const));
  const windowSpan = (from: number, to: number): Span => ({ start: groups[from]!.start, end: groups[to]!.end });

  // Strong evidence first: labelled numbers, security codes and expiries. They are sorted and kept apart from each other.
  const strong: Span[] = [];

  // 1a. labelled numbers: the label is the evidence, no Luhn, no issuer.
  for (const m of text.matchAll(CARD_LABEL)) {
    if (inMask(m.index)) continue;
    const gi = byStart.get(m.index + m[0].length);
    if (gi === undefined) continue;
    let end = gi;
    let total = groups[gi]!.digits.length;
    while (total < 13 && groups[end]!.linked && end + 1 < groups.length && total + groups[end + 1]!.digits.length <= 19) total += groups[++end]!.digits.length;
    while (total >= 13 && total < 19 && groups[end]!.linked && end + 1 < groups.length && groups[end + 1]!.digits.length <= 3 && total + groups[end + 1]!.digits.length <= 19) total += groups[++end]!.digits.length;
    if (total >= 13 && total <= 19) strong.push(windowSpan(gi, end));
  }

  // 2 and 3. security code and expiry, only next to their label: only the value is replaced.
  for (const re of [CVC, EXPIRY, EXP_MONTH, EXP_YEAR]) {
    for (const m of text.matchAll(re)) {
      if (inMask(m.index)) continue;
      const valueStart = m.index + m[1]!.length + m[2]!.length;
      strong.push({ start: valueStart, end: valueStart + m[3]!.length });
    }
  }
  strong.sort((a, b) => a.start - b.start || b.end - a.end);
  const fixed: Span[] = [];
  for (const s of strong) if (!fixed.length || s.start >= fixed[fixed.length - 1]!.end) fixed.push(s);

  // 1b / 1c. unlabelled numbers, found in increasing order of position, so only the last accepted one can overlap.
  const found: Span[] = [];
  const addFound = (s: Span) => {
    if (hitsSorted(masks, s) || hitsSorted(fixed, s)) return;
    if (found.length && s.start < found[found.length - 1]!.end) return;
    found.push(s);
  };
  if (unlabeled) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      // grouped like a card + Luhn: the longest valid window that starts here
      if (g.digits.length === 4 && g.linked) {
        const sizes = [4];
        let digits = g.digits;
        let best = -1;
        for (let j = i + 1; j < groups.length && groups[j - 1]!.linked && digits.length + groups[j]!.digits.length <= 19; j++) {
          sizes.push(groups[j]!.digits.length);
          digits += groups[j]!.digits;
          if (cardShape(sizes) && luhnValid(digits)) best = j;
        }
        if (best !== -1) {
          addFound(windowSpan(i, best));
          continue;
        }
      }
      // a number typed digit by digit ("4 1 1 1 ..."): 13-19 one-digit groups, with the same evidence as a contiguous number
      if (g.digits.length === 1 && g.linked) {
        let digits = '';
        let best = -1;
        for (let j = i; j < groups.length && groups[j]!.digits.length === 1 && digits.length < 19; j++) {
          digits += groups[j]!.digits;
          if (digits.length >= 13 && luhnValid(digits) && knownNetwork(digits)) best = j;
          if (!groups[j]!.linked) break;
        }
        if (best !== -1) {
          addFound(windowSpan(i, best));
          continue;
        }
      }
      // contiguous + Luhn + a known issuer prefix and length
      const d = g.digits;
      if (d.length >= 13 && d.length <= 19 && luhnValid(d) && knownNetwork(d)) addFound({ start: g.start, end: g.end });
    }
  }

  const spans = [...fixed, ...found].sort((a, b) => a.start - b.start);
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + CARD_MASK;
    at = s.end;
  }
  return out + text.slice(at);
}

/**
 * maskCardData over every string VALUE of a JSON-like structure (keys are left alone). Masking the values rather than the
 * serialised text matters: JSON.stringify turns a newline inside a number into backslash + n, which is no longer a separator.
 * Same best-effort limits as maskCardData. Only plain objects and arrays are walked; anything else is returned as it is.
 */
export function maskCardDeep<T>(value: T): T {
  if (typeof value === 'string') return maskCardData(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskCardDeep(v)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskCardDeep(v)])) as T;
  }
  return value;
}
