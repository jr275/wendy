/**
 * Public-internet-only HTTP GET.
 *
 * Wendy's own services listen on 127.0.0.1 (agent, read API), so a page or a model must never be
 * able to make Wendy fetch them (SSRF). Every hop is checked:
 *   - http/https only, default ports only (80/443);
 *   - the host must resolve ONLY to public addresses, and the connection uses the address that was
 *     checked (the resolver is pinned through `lookup`, so DNS rebinding cannot swap it afterwards);
 *   - redirects are followed manually (max 5) and each target is checked again;
 *   - size, time and content type are bounded.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { ToolError } from './types.js';

export const FETCH_LIMITS = { maxBytes: 2_000_000, timeoutMs: 12_000, maxRedirects: 5 };
const TEXTUAL = /^(text\/(html|plain)|application\/xhtml\+xml)\b/i;

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && (b === 168 || b === 0)) return false; // private, IETF/documentation
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return false; // unique-local, link-local, multicast
    return true;
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Checks scheme, port and literal-IP hosts before any network activity. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError('INVALID_INPUT', `not a URL: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('BLOCKED', `scheme ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new ToolError('BLOCKED', 'URLs with credentials are not allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new ToolError('BLOCKED', `port ${u.port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicAddress(host)) throw new ToolError('BLOCKED', `address ${host} is not public`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new ToolError('BLOCKED', `host ${host} is not public`);
  return u;
}

/** A `lookup` for net.connect that resolves, refuses any non-public answer, and pins the result. */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (host: string, options: unknown, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    resolve(host).then(
      (addrs) => {
        if (!addrs.length) return cb(new ToolError('NOT_FOUND', `${host} did not resolve`), '', 4);
        const bad = addrs.find((a) => !isPublicAddress(a));
        if (bad) return cb(new ToolError('BLOCKED', `${host} resolves to non-public address ${bad}`), '', 4);
        const all = (options as { all?: boolean } | undefined)?.all;
        if (all) return cb(null, addrs.map((a) => ({ address: a, family: net.isIPv6(a) ? 6 : 4 })));
        cb(null, addrs[0]!, net.isIPv6(addrs[0]!) ? 6 : 4);
      },
      (e: Error) => cb(new ToolError('NOT_FOUND', `${host}: ${e.message}`, true), '', 4),
    );
  };
}

export interface Hop {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}
export type HopFn = (url: URL, lookup: ReturnType<typeof guardedLookup>) => Promise<Hop>;

/** One GET, no redirect following, bounded in size and time. */
export const httpHop: HopFn = (url, lookup) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      { method: 'GET', lookup: lookup as never, headers: { 'user-agent': 'Wendy/0.1 (+personal research assistant)', accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' }, timeout: FETCH_LIMITS.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > FETCH_LIMITS.maxBytes) {
            req.destroy(new ToolError('TOO_LARGE', `page larger than ${FETCH_LIMITS.maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new ToolError('TIMEOUT', `no response from ${url.hostname} in ${FETCH_LIMITS.timeoutMs} ms`, true)));
    req.on('error', (e) => reject(e instanceof ToolError ? e : new ToolError('NETWORK', `${url.hostname}: ${e.message}`, true)));
    req.end();
  });

export async function safeFetch(raw: string, deps: { hop?: HopFn; resolve?: Resolver } = {}): Promise<{ url: string; contentType: string; text: string }> {
  const hop = deps.hop ?? httpHop;
  const lookup = guardedLookup(deps.resolve);
  let url = checkUrl(raw);
  for (let i = 0; i <= FETCH_LIMITS.maxRedirects; i++) {
    const r = await hop(url, lookup);
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) throw new ToolError('UPSTREAM', `redirect without location from ${url.hostname}`);
      url = checkUrl(new URL(r.location, url).toString());
      continue;
    }
    if (r.status >= 500) throw new ToolError('UPSTREAM', `${url.hostname} answered ${r.status}`, true);
    if (r.status >= 400) throw new ToolError('NOT_FOUND', `${url.hostname} answered ${r.status}`);
    if (!TEXTUAL.test(r.contentType)) throw new ToolError('UNSUPPORTED', `content type "${r.contentType || 'unknown'}" is not a readable page`);
    const charset = /charset=([\w-]+)/i.exec(r.contentType)?.[1] ?? 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(charset).decode(r.body);
    } catch {
      text = new TextDecoder('utf-8').decode(r.body);
    }
    return { url: url.toString(), contentType: r.contentType, text };
  }
  throw new ToolError('UPSTREAM', `more than ${FETCH_LIMITS.maxRedirects} redirects`);
}
