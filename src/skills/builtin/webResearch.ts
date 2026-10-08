/** web-research: search → read pages → evidence-backed synthesis. Read-only end to end. */
import { z } from 'zod';
import { ToolError } from '../../tools/types.js';
import type { WebSearchResult } from '../../tools/web.js';
import { AnalysisSchema, analyzeSources } from '../analysis.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z.object({ query: z.string().min(3).max(300), maxSources: z.number().int().min(1).max(5).default(3) });
const Output = AnalysisSchema.extend({ query: z.string(), skipped: z.array(z.object({ uri: z.string(), reason: z.string() })) });
export type WebResearchOutput = z.infer<typeof Output>;

export const webResearch: SkillDefinition<z.infer<typeof Input>, WebResearchOutput> = {
  id: 'web-research',
  name: 'Pesquisa na web',
  description: 'Research a topic on the public web: find pages, read them, and report what they say with every claim tied to a page.',
  version: '1.0.0',
  category: 'research',
  triggers: [{ kind: 'intent', examples: ['Pesquise voos diretos para Lisboa em novembro', 'O que mudou na declaração do imposto de renda este ano?', 'Procure avaliações recentes de restaurantes japoneses perto de mim'] }],
  requiredTools: ['web.search', 'web.fetch'],
  composable: true,
  autonomous: true,
  riskLevel: 'LOW',
  instructions: 'Summarise what the pages say about the request. Mention the date of a page when it has one. Do not generalise beyond the pages.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'search',
      label: 'Buscando fontes na web',
      retry: { attempts: 2, backoffMs: 1500 },
      timeoutMs: 60_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const results = (await ctx.read('web.search', { query: i.query, max: Math.min(8, i.maxSources + 3) })) as WebSearchResult[];
        if (!results.length) throw new SkillError('NOTHING_FOUND', 'the search returned no pages');
        ctx.state.results = results;
        return { kind: 'next' };
      },
    },
    {
      id: 'read',
      label: 'Lendo as páginas',
      timeoutMs: 120_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const sourceIds: string[] = [];
        const skipped: { uri: string; reason: string }[] = [];
        for (const r of ctx.state.results as WebSearchResult[]) {
          if (sourceIds.length >= i.maxSources) break;
          try {
            const page = (await ctx.read('web.fetch', { url: r.uri })) as { sourceId: string };
            if (!sourceIds.includes(page.sourceId)) sourceIds.push(page.sourceId);
          } catch (e) {
            if (!(e instanceof ToolError)) throw e;
            skipped.push({ uri: r.uri, reason: `${e.code}: ${e.message}` });
          }
        }
        if (!sourceIds.length) throw new SkillError('NOTHING_FOUND', `no page could be read (${skipped.map((s) => s.reason).join('; ')})`);
        ctx.state.sourceIds = sourceIds;
        ctx.state.skipped = skipped;
        return { kind: 'next' };
      },
    },
    {
      id: 'synthesize',
      label: 'Conferindo o que as páginas dizem',
      retry: { attempts: 2, backoffMs: 2000 },
      timeoutMs: 180_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const sources = await ctx.sources(ctx.state.sourceIds as string[]);
        const analysis = await analyzeSources(ctx, { purpose: 'synthesize', request: i.query, sources, instructions: webResearch.instructions, principalLanguage: await ctx.language() });
        return { kind: 'done', output: { ...analysis, query: i.query, skipped: ctx.state.skipped as { uri: string; reason: string }[] } };
      },
    },
  ],
};
