/**
 * Synthetic corpus for the card-redaction tests. Deterministic (seeded) and made only of invented numbers: nothing here is a
 * real card, phone, company or order. Every set states its size and how it is built, because a false-positive rate is only
 * meaningful together with the sample it was measured on.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randDigits = (r: () => number, n: number, first?: [number, number]) => {
  let s = '';
  for (let i = 0; i < n; i++) s += i === 0 && first ? String(first[0] + Math.floor(r() * (first[1] - first[0] + 1))) : String(Math.floor(r() * 10));
  return s;
};

export function luhnCheckDigit(body: string): string {
  let sum = 0;
  let dbl = true; // the check digit will sit at the right, so the body's last digit is the first one doubled
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}
/** A Luhn-valid number of `length` digits that starts with `prefix`, the rest drawn from `r`. */
export function luhnNumber(prefix: string, length: number, r: () => number): string {
  const body = prefix + randDigits(r, length - prefix.length - 1);
  return body + luhnCheckDigit(body);
}

export interface NetworkSpec {
  name: string;
  prefixes: string[];
  length: number;
}
/** What the positives are built from: one entry per issuer prefix family and length the redactor claims to know. */
export const POSITIVE_NETWORKS: NetworkSpec[] = [
  { name: 'visa16', prefixes: ['4'], length: 16 }, { name: 'visa13', prefixes: ['4'], length: 13 }, { name: 'visa19', prefixes: ['4'], length: 19 },
  { name: 'mastercard', prefixes: ['51', '55', '2221', '2500', '2720'], length: 16 },
  { name: 'amex', prefixes: ['34', '37'], length: 15 },
  { name: 'diners14', prefixes: ['300', '305', '36', '38'], length: 14 },
  { name: 'discover', prefixes: ['6011', '645', '65'], length: 16 },
  { name: 'jcb', prefixes: ['3528', '3589', '3530'], length: 16 },
  { name: 'unionpay', prefixes: ['62'], length: 16 },
  { name: 'elo', prefixes: ['636', '5067', '4011'], length: 16 },
  { name: 'hipercard', prefixes: ['606282', '3841'], length: 16 },
  { name: 'maestro', prefixes: ['5018', '6759'], length: 16 },
];

/** `perSpec` numbers for every network spec (prefixes rotate): the positive corpus. */
export function positiveNumbers(perSpec = 20, seed = 11): { name: string; pan: string }[] {
  const r = rng(seed);
  const out: { name: string; pan: string }[] = [];
  for (const n of POSITIVE_NETWORKS) for (let i = 0; i < perSpec; i++) out.push({ name: n.name, pan: luhnNumber(n.prefixes[i % n.prefixes.length]!, n.length, r) });
  return out;
}
/** Luhn-valid 16-digit numbers of an issuer that is NOT in the table (first digit 7, 8 or 9). */
export function unknownIssuerNumbers(n = 100, seed = 12): string[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => luhnNumber(String(7 + Math.floor(r() * 3)), 16, r));
}

/** Pretty-prints digits in groups of 4 (the last group may be shorter), joined by `sep`. */
export const grouped = (pan: string, sep = ' ') => (pan.match(/\d{1,4}/g) ?? []).join(sep);
export const groupedAmex = (pan: string, sep = ' ') => `${pan.slice(0, 4)}${sep}${pan.slice(4, 10)}${sep}${pan.slice(10)}`;

export interface NegativeSet {
  name: string;
  size: number;
  how: string;
  items: string[];
}
const mk = (name: string, size: number, how: string, f: (r: () => number, i: number) => string, seed: number): NegativeSet => {
  const r = rng(seed);
  return { name, size, how, items: Array.from({ length: size }, (_, i) => f(r, i)) };
};

/** Legitimate data that is NOT a card. The sets marked "Luhn-valid" are the hard ones. */
export function negativeSets(size = 2000): NegativeSet[] {
  const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  return [
    mk('epoch-ms', size, '13 digits, 1.6e12 to 1.9e12', (r) => String(1_600_000_000_000 + Math.floor(r() * 300_000_000_000)), 21),
    mk('br-mobile-+55', size, '13 digits: 55 + DDD 11-99 + 9 + 8 digits', (r) => `55${11 + Math.floor(r() * 89)}9${randDigits(r, 8)}`, 22),
    mk('cnpj-unformatted', size, '14 random digits', (r) => randDigits(r, 14), 23),
    mk('cnpj-formatted', size, 'NN.NNN.NNN/NNNN-NN', (r) => { const d = randDigits(r, 14); return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`; }, 24),
    mk('phone-formatted', size, '+55 DD 9NNNN-NNNN', (r) => `+55 ${11 + Math.floor(r() * 89)} 9${randDigits(r, 4)}-${randDigits(r, 4)}`, 25),
    mk('order-16-random', size, '16 digits, uniform first digit 1-9', (r) => randDigits(r, 16, [1, 9]), 26),
    mk('order-19-random', size, '19 digits, uniform first digit 1-9', (r) => randDigits(r, 19, [1, 9]), 27),
    mk('order-16-LUHN-VALID', size, '16 digits, uniform first digit 1-9, check digit fixed so Luhn passes (HARD: looks like a card)', (r) => luhnNumber(String(1 + Math.floor(r() * 9)), 16, r), 28),
    mk('ts-13-LUHN-VALID', size, '13 digits starting 17, Luhn-valid (a timestamp-shaped number that passes Luhn)', (r) => luhnNumber('17', 13, r), 29),
    mk('uuid-v4', size, 'random hex 8-4-4-4-12', (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`, 30),
    mk('iso-timestamp', size, 'ISO-8601 UTC with milliseconds', (r) => new Date(1_790_000_000_000 + Math.floor(r() * 90_000_000_000)).toISOString(), 31),
    mk('decimal', size, '13 digits . 2 digits', (r) => `${randDigits(r, 13, [1, 9])}.${randDigits(r, 2)}`, 32),
  ];
}

/**
 * The previous implementation (Luhn only, 13-19 digits, single space or hyphen between digits), kept ONLY to measure the old
 * behaviour in the strategy comparison. Never used by production code.
 */
export function legacyLuhnOnly(text: string): string {
  const luhn = (d: string) => {
    let s = 0;
    let dbl = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let x = d.charCodeAt(i) - 48;
      if (dbl) { x *= 2; if (x > 9) x -= 9; }
      s += x;
      dbl = !dbl;
    }
    return s % 10 === 0;
  };
  return text.replace(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[cartão ocultado]' : m));
}
