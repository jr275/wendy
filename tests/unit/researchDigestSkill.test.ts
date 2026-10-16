import { describe, expect, it } from 'vitest';
import { builtinRegistry } from '../../src/skills/index.js';
import { researchDigestSkill } from '../../src/skills/builtin/researchDigest.js';
import { Toolbox } from '../../src/tools/index.js';
import { isToolName } from '../../src/tools/specs.js';
import type { StepContext } from '../../src/skills/types.js';

const item = (n: number, read: boolean) => ({ id: `i${n}`, title: `T${n}`, url: `https://example.test/${n}`, source: 'Fonte', publishedAt: null, summary: 'resumo da fonte', why: 'porquê', read });
const run = (r: { refresh: string; items: ReturnType<typeof item>[] }, input: object = {}) => {
  const calls: unknown[] = [];
  const ctx = { input, read: async (tool: string, i: unknown) => { calls.push([tool, i]); return r; } } as unknown as StepContext;
  return researchDigestSkill.steps[0]!.run(ctx).then((out) => ({ out, calls }));
};

describe('research-digest skill', () => {
  it('is registered, needs only the read tool, is not autonomous and writes nothing', () => {
    expect(builtinRegistry().get('research-digest')).toBeTruthy();
    expect(researchDigestSkill.requiredTools).toEqual(['research.digest']);
    expect(isToolName('research.digest')).toBe(true);
    expect(researchDigestSkill.autonomous).toBe(false);
    expect(new Toolbox({ search: () => { throw new Error('no search expected'); } }).read('research.digest')).toBeTruthy();
  });
  it('asks for a refresh by default, answers with unread items first and does not expose internal ids', async () => {
    const { out, calls } = await run({ refresh: 'done', items: [item(1, true), item(2, false)] });
    expect(calls).toEqual([['research.digest', { refresh: true }]]);
    const o = (out as { kind: 'done'; output: { items: Record<string, unknown>[]; note: string } }).output;
    expect(o.items.map((x) => x.title)).toEqual(['T2']);
    expect(o.items[0]).not.toHaveProperty('id');
    expect(o.note).toBe('');
  });
  it('says what it could not do instead of pretending: no routine, a failed refresh, already fetched today', async () => {
    for (const [refresh, re] of [['no_routine', /ainda não está ativada/], ['failed', /Não consegui buscar/], ['skipped', /já tinham sido buscadas/]] as const) {
      const { out } = await run({ refresh, items: [item(1, true)] });
      const o = (out as { output: { items: unknown[]; note: string } }).output;
      expect(o.note).toMatch(re);
      expect(o.items).toHaveLength(1); // falls back to what is stored
    }
  });
});
