/**
 * ANTI-HARDCODING (static). The Cognitive Core must not know any scenario: no fixture names,
 * emails, companies, meeting titles or topics anywhere in src/, and no literal keyword routing
 * over message text. (The behavioral half — swapping people/topics/meetings — runs live.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioTokens } from '../../fixtures/world.js';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? sourceFiles(p) : /\.(ts|sql)$/.test(d.name) ? [p] : [];
  });
}

const files = sourceFiles(path.resolve('src')).map((f) => ({ f, text: fs.readFileSync(f, 'utf-8') }));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('no scenario knowledge in src/', () => {
  it('scans a non-trivial amount of code', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const token of scenarioTokens()) {
    it(`does not mention "${token}"`, () => {
      const re = new RegExp(`(^|[^\\p{L}])${escape(token)}([^\\p{L}]|$)`, 'iu');
      const hits = files.filter(({ text }) => re.test(text)).map(({ f }) => path.relative(process.cwd(), f));
      expect(hits).toEqual([]);
    });
  }

  it('does no literal keyword matching over text content in the cognition layer', () => {
    // e.g. text.includes('urgent'), /pricing/i.test(body), subject.toLowerCase().includes('...')
    const pattern = /\.(includes|startsWith|endsWith|indexOf)\(\s*['"][^'"]{3,}['"]\s*\)|\/[a-z]{4,}\/i\.test\(/;
    const offenders = files
      .filter(({ f }) => f.includes(`${path.sep}cognition${path.sep}`))
      .flatMap(({ f, text }) => text.split('\n').map((line, i) => ({ f, i, line })))
      .filter(({ line }) => pattern.test(line))
      .map(({ f, i, line }) => `${path.relative(process.cwd(), f)}:${i + 1}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
