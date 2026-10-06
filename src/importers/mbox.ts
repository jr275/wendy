/**
 * Minimal, dependency-free reader for Gmail Takeout mbox files (read-only).
 *
 * - streams the file line by line (exports can be several GB)
 * - parses RFC 5322 headers (unfolding, RFC 2047 encoded words, address lists)
 * - walks MIME multiparts, decodes base64 / quoted-printable and the declared charset
 * - prefers text/plain; falls back to text/html converted to plain text
 *
 * Bytes are carried as latin1 strings (1 char = 1 byte) until a charset is known.
 */
import fs from 'node:fs';
import readline from 'node:readline';

export interface ParsedMail {
  messageId: string | null;
  threadId: string | null; // X-GM-THRID when present (Gmail thread), else first References id
  from: { address: string; name: string | null } | null;
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string;
  date: Date | null;
  labels: string[]; // X-Gmail-Labels
  body: string;
}

/** Yields the raw (latin1) text of each message in an mbox file. */
export async function* readMbox(path: string): AsyncGenerator<string> {
  const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  let cur: string[] | null = null;
  let prevBlank = true;
  for await (const line of rl) {
    if (line.startsWith('From ') && prevBlank) {
      if (cur) yield cur.join('\n');
      cur = [];
    } else if (cur) {
      cur.push(/^>+From /.test(line) ? line.slice(1) : line); // mboxrd un-escaping
    }
    prevBlank = line === '';
  }
  if (cur) yield cur.join('\n');
}

// ---------- headers ----------

function splitHeadBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
}

export function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    out.set(k, [...(out.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  return out;
}

const first = (h: Map<string, string[]>, k: string) => h.get(k)?.[0] ?? null;

function decodeBytes(latin1: string, charset: string | null): string {
  const bytes = Buffer.from(latin1, 'latin1');
  const cs = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeQP(s: string, header = false): string {
  if (header) s = s.replace(/_/g, ' ');
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** RFC 2047: =?charset?B|Q?text?= ; whitespace between adjacent encoded words is dropped. */
export function decodeWords(value: string): string {
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  // Headers sent as raw 8-bit UTF-8 (common) arrive as latin1 bytes: decode them first, only if valid UTF-8.
  let raw = value;
  if (/[\u0080-\u00ff]/.test(raw)) {
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1'));
    } catch {
      /* not UTF-8: keep latin1 */
    }
  }
  const joined = raw.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(re, (_, cs: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('latin1') : decodeQP(text, true);
    return decodeBytes(bytes, cs.split('*')[0]!);
  });
}

/** Splits an address list on commas outside quotes, comments and angle brackets. */
export function parseAddressList(value: string | null): { address: string; name: string | null }[] {
  if (!value) return [];
  const parts: string[] = [];
  let buf = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (const ch of value) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && ch === '(') paren++;
    else if (!quoted && ch === ')') paren = Math.max(0, paren - 1);
    if (ch === ',' && !quoted && !angle && !paren) {
      parts.push(buf);
      buf = '';
    } else buf += ch;
  }
  parts.push(buf);
  const out: { address: string; name: string | null }[] = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    const m = /^(.*)<([^>]+)>\s*$/.exec(s);
    const address = (m ? m[2]! : s.replace(/\(.*?\)/g, '')).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const rawName = m ? m[1]!.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').trim() : (/\((.*)\)/.exec(s)?.[1] ?? '');
    const name = decodeWords(rawName).trim();
    out.push({ address, name: name && name.toLowerCase() !== address ? name : null });
  }
  return out;
}

function param(header: string | null, name: string): string | null {
  if (!header) return null;
  const m = new RegExp(`;\\s*${name}\\*?=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
  if (!m) return null;
  let v = m[2] ?? m[1]!;
  const ext = /^([^']*)'[^']*'(.*)$/.exec(v); // RFC 2231 charset''value
  if (ext) v = decodeBytes(ext[2]!.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), ext[1] || 'utf-8');
  return v;
}

// ---------- body ----------

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Part {
  type: string;
  text: string;
}

function collectParts(head: Map<string, string[]>, body: string, depth = 0): Part[] {
  const ct = first(head, 'content-type') ?? 'text/plain; charset=us-ascii';
  const type = ct.split(';')[0]!.trim().toLowerCase();
  const disposition = (first(head, 'content-disposition') ?? '').toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(ct, 'boundary');
    if (!boundary) return [];
    const out: Part[] = [];
    const chunks = body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*$`, 'm'));
    for (const chunk of chunks.slice(1)) {
      const c = chunk.replace(/^\r?\n/, '');
      if (!c.trim()) continue;
      const [h, b] = splitHeadBody(c);
      out.push(...collectParts(parseHeaders(h), b, depth + 1));
    }
    return out;
  }
  if (!type.startsWith('text/') || disposition.startsWith('attachment')) return [];
  const cte = (first(head, 'content-transfer-encoding') ?? '7bit').toLowerCase();
  const bytes = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('latin1') : cte === 'quoted-printable' ? decodeQP(body) : body;
  return [{ type, text: decodeBytes(bytes, param(ct, 'charset')) }];
}

const MAX_BODY_CHARS = 100_000;

export function parseMail(raw: string): ParsedMail {
  const [h, b] = splitHeadBody(raw);
  const head = parseHeaders(h);
  const parts = collectParts(head, b);
  const plain = parts.find((p) => p.type === 'text/plain');
  const html = parts.find((p) => p.type === 'text/html');
  const body = (plain ? plain.text : html ? htmlToText(html.text) : '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS);
  const dateRaw = first(head, 'date');
  const date = dateRaw ? new Date(dateRaw.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  const refs = (first(head, 'references') ?? '').match(/<[^>]+>/g);
  return {
    messageId: first(head, 'message-id')?.trim() ?? null,
    threadId: first(head, 'x-gm-thrid') ?? refs?.[0] ?? null,
    from: parseAddressList(first(head, 'from'))[0] ?? null,
    to: parseAddressList((head.get('to') ?? []).join(', ')),
    cc: parseAddressList((head.get('cc') ?? []).join(', ')),
    subject: decodeWords(first(head, 'subject') ?? '').trim(),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    labels: decodeWords(first(head, 'x-gmail-labels') ?? '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
    body,
  };
}
