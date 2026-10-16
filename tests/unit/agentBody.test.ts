import fs from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readLimited, safeJson } from '../../src/agent/body.js';

describe('agent request bodies', () => {
  it('a malformed body is a value the server can answer with 400, never a throw', () => {
    for (const bad of ['{not json', '{', 'undefined', '<html>']) expect(safeJson(bad)).toEqual({ ok: false });
    expect(safeJson('')).toEqual({ ok: true, value: {} });
    expect(safeJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('stops reading at the limit instead of buffering without bound', async () => {
    expect(await readLimited(Readable.from(['ab', 'cd']), 10)).toBe('abcd');
    expect(await readLimited(Readable.from(['x'.repeat(6), 'y'.repeat(6)]), 10)).toBeNull();
    expect(MAX_BODY_BYTES).toBe(2_000_000);
  });
  // Regression guard for the crash found in the 3.0 audit: a valid token plus a malformed body used to kill the process.
  it('server.ts never parses a request body with a bare JSON.parse', () => {
    const src = fs.readFileSync('src/agent/server.ts', 'utf8');
    expect(src).not.toMatch(/JSON\.parse\(/);
    expect(src).not.toMatch(/for await \(const chunk of req\)/);
  });
});

describe('web dev server exposure', () => {
  it('the dev script binds the loopback only (the dev server has no login)', () => {
    const dev = (JSON.parse(fs.readFileSync('web/package.json', 'utf8')) as { scripts: { dev: string } }).scripts.dev;
    expect(dev).toMatch(/-H 127\.0\.0\.1/);
  });
});
