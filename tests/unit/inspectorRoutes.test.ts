/**
 * Inspector GET routes (inspector/server.ts): the order of the "id" guard. Pure: it reads the source, it starts no server and touches no database.
 *
 * Why it exists: `/api/executions` (a LIST, which takes the principal and never an id) sat after `if (!UUID_RE.test(id)) return 400`, so every call
 * answered "invalid id" and the web showed no tasks, no "Em andamento" and no pending approvals. The rule that would have caught it:
 *   - a route whose handler does not use `id` must come BEFORE the guard;
 *   - a route whose handler uses `id` must come AFTER it (so a bad id never reaches a query).
 * This is a structural check on the source text, not a request to a running server (which needs a database).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../../inspector/server.ts', import.meta.url), 'utf8').split('\n');
const GUARD = SRC.findIndex((l) => l.includes('if (!UUID_RE.test(id))'));
// Lines like: if (url.pathname === '/api/foo') return send(res, 200, await foo(db, principal));   (or the start of a block: `... {`)
const ROUTES = SRC.map((text, i) => ({ text, i })).filter(({ text }) => /url\.pathname === '\/api\//.test(text) || /if \(url\.pathname === '\/api\/[^']+'\)/.test(text));
const path = (l: string) => /'(\/api\/[^']+)'/.exec(l)![1]!;

describe('inspector GET routes and the id guard', () => {
  it('finds the guard and the routes it is about (the check is not vacuous)', () => {
    expect(GUARD).toBeGreaterThan(0);
    const paths = ROUTES.map((r) => path(r.text));
    expect(paths).toEqual(expect.arrayContaining(['/api/tasks', '/api/history', '/api/executions', '/api/execution', '/api/event']));
    expect(ROUTES.length).toBeGreaterThan(15);
  });

  it('every route that takes an id comes after the guard; every route that does not, comes before it', () => {
    const wrong: string[] = [];
    for (const r of ROUTES) {
      // The handler text: this line, plus the next two for a multi-line block.
      const body = [SRC[r.i], SRC[r.i + 1], SRC[r.i + 2]].join(' ');
      const usesId = /\b(await \w+\([^)]*\bid\b[^)]*\))/.test(SRC[r.i]!) || (/\{\s*$/.test(SRC[r.i]!) && /\bexecution\(db, principal, id\)|\bid\)/.test(body));
      if (usesId && r.i < GUARD) wrong.push(`${path(r.text)} uses an id but is before the guard`);
      if (!usesId && r.i > GUARD) wrong.push(`${path(r.text)} takes no id but is after the guard (every call would answer "invalid id")`);
    }
    expect(wrong).toEqual([]);
  });

  it('the list of executions is served before the guard (the defect that hid every task and approval from the Home)', () => {
    const list = ROUTES.find((r) => path(r.text) === '/api/executions')!;
    expect(list.i).toBeLessThan(GUARD);
    const one = ROUTES.find((r) => path(r.text) === '/api/execution')!;
    expect(one.i).toBeGreaterThan(GUARD);
  });
});
