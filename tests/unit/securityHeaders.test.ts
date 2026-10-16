import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// A source check on purpose: next.config.ts belongs to the web package and is not resolvable from the root TypeScript project.
describe('web response headers (web/next.config.ts)', () => {
  const src = fs.readFileSync('web/next.config.ts', 'utf8');
  it('sets the baseline security headers on every route', () => {
    expect(src).toMatch(/source:\s*"\/:path\*"/);
    expect(src).toContain('{ key: "X-Content-Type-Options", value: "nosniff" }');
    expect(src).toContain('{ key: "X-Frame-Options", value: "DENY" }');
    expect(src).toContain('{ key: "Referrer-Policy", value: "same-origin" }'); // login relies on Origin/Sec-Fetch-Site, never no-referrer
  });
  it('keeps the microphone for this origin only (voice), and nothing else sensitive', () => {
    expect(src).toContain('{ key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" }');
  });
});
