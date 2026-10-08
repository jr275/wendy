/**
 * learn-about-me (S3): Wendy gets to know the principal from a source they shared (their own writing,
 * an interview, a profile). The model proposes what is worth remembering; CODE keeps only items whose
 * quote occurs verbatim in the cited passage, drops sensitive topics, and stores the rest as memory
 * PROPOSALS. Nothing becomes active memory until the principal confirms it, one by one.
 */
import { z } from 'zod';
import { EvidenceRegistry, renderEvidence } from '../../cognition/context.js';
import { quoteInSource } from '../../cognition/validator.js';
import { PROFILE_SYSTEM } from '../prompts.js';
import { passages } from '../analysis.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z
  .object({
    path: z.string().min(1).max(500).optional().describe('Document path relative to the documents folder, copied from the documents list.'),
    url: z.string().url().max(2000).optional().describe('A public web page about the principal that the principal gave.'),
    sourceDate: z.string().max(40).optional().describe('When the source was written, if known (e.g. from the file name).'),
  })
  .refine((i) => !!i.path !== !!i.url, 'give exactly one of path or url');

const CATEGORIES = ['work_style', 'preferences', 'values', 'routines', 'background', 'people', 'projects'] as const;
const Extraction = z.object({
  items: z.array(
    z.object({
      statement: z.string(),
      kind: z.enum(['PREFERENCE', 'FACT']),
      category: z.enum(CATEGORIES),
      quote: z.string(),
      passage: z.string().describe('handle of the passage the quote comes from, e.g. D3'),
      sensitive: z.boolean(),
    }),
  ),
});

const Output = z.object({
  source: z.object({ title: z.string().nullable(), uri: z.string(), date: z.string().nullable() }),
  proposed: z.array(z.object({ memoryId: z.string().nullable(), statement: z.string(), quote: z.string(), category: z.string(), kind: z.string() })),
  actionId: z.string().nullable(),
  droppedSensitive: z.number().int(),
  droppedUnquoted: z.number().int(),
  model: z.string(),
});
export type LearnAboutMeOutput = z.infer<typeof Output>;

const MAX_ITEMS = 15;

export const learnAboutMe: SkillDefinition<z.infer<typeof Input>, LearnAboutMeOutput> = {
  id: 'learn-about-me',
  name: 'Conhecer você',
  description:
    "Get to know the principal from a source about them that they shared (their article, an interview, a profile): propose memories about how they work, their preferences, values and background, each tied to a verbatim quote, for the principal to confirm.",
  version: '1.0.0',
  category: 'memory',
  triggers: [{ kind: 'intent', examples: ['Leia meu artigo na pasta sobre-mim para me conhecer melhor', 'Aprenda sobre mim com esta entrevista', 'Use esta matéria sobre mim para me conhecer'] }],
  requiredTools: ['documents.read', 'web.fetch', 'memory.propose', 'memory.proposals'],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: 'Only what the source says about the principal; dated; sensitive topics are left out.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'read',
      label: 'Lendo a fonte',
      timeoutMs: 60_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const r = (i.path ? await ctx.read('documents.read', { path: i.path }) : await ctx.read('web.fetch', { url: i.url })) as { sourceId: string };
        ctx.state.sourceId = r.sourceId;
        return { kind: 'next' };
      },
    },
    {
      id: 'extract',
      label: 'Separando o que vale lembrar sobre você',
      retry: { attempts: 2, backoffMs: 2000 },
      timeoutMs: 180_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const [source] = await ctx.sources([ctx.state.sourceId as string]);
        if (!source) throw new SkillError('NOTHING_FOUND', 'source not found');
        const me = await ctx.principal();

        // Passages as evidence; keep each passage's raw text to check quotes against it.
        const registry = new EvidenceRegistry();
        const raw = new Map<string, string>();
        const chunks = source.kind === 'document' ? passages(source.content) : [source.content];
        chunks.forEach((p, n) => {
          const ref = source.kind === 'document' ? { kind: 'document' as const, id: `${source.id}:${n + 1}` } : { kind: 'web_page' as const, id: source.id };
          const h = registry.add(ref, source.fetched_at, `<untrusted_source passage="${n + 1}">\n${p.replace(/<\/?\s*untrusted_source/gi, '‹untrusted_source')}\n</untrusted_source>`);
          raw.set(h, p);
        });

        const r = await ctx.reason({
          purpose: 'extract',
          system: PROFILE_SYSTEM,
          user: [`Principal: ${me.displayName}. Principal's language: ${me.locale}.`, `Source: ${source.title ?? source.uri}${i.sourceDate ? ` (written ${i.sourceDate})` : ''}`, '', 'Passages:', renderEvidence(registry)].join('\n'),
          schema: Extraction,
          effort: 'medium',
          evidenceRefs: registry.refs(),
        });

        const kept: { statement: string; quote: string; category: string; kind: 'PREFERENCE' | 'FACT'; evidence: { kind: 'document' | 'web_page'; id: string }[] }[] = [];
        let droppedSensitive = 0;
        let droppedUnquoted = 0;
        for (const it of r.output.items) {
          if (it.sensitive) {
            droppedSensitive++;
            continue;
          }
          const item = registry.get(it.passage);
          if (!item || !quoteInSource(it.quote, raw.get(item.handle) ?? null) || it.quote.trim().length < 12) {
            droppedUnquoted++;
            continue;
          }
          if (kept.length >= MAX_ITEMS || kept.some((k) => k.statement === it.statement.trim())) continue;
          kept.push({ statement: it.statement.trim(), quote: it.quote.trim(), category: it.category, kind: it.kind, evidence: [item.ref as { kind: 'document' | 'web_page'; id: string }] });
        }
        Object.assign(ctx.state, { kept, droppedSensitive, droppedUnquoted, model: r.model, title: source.title, uri: source.uri });
        return { kind: 'next' };
      },
    },
    {
      id: 'propose',
      label: 'Guardando como propostas para você confirmar',
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const kept = ctx.state.kept as { statement: string; quote: string; category: string; kind: 'PREFERENCE' | 'FACT'; evidence: { kind: 'document' | 'web_page'; id: string }[] }[];
        const base = {
          source: { title: (ctx.state.title as string | null) ?? null, uri: ctx.state.uri as string, date: i.sourceDate ?? null },
          droppedSensitive: ctx.state.droppedSensitive as number,
          droppedUnquoted: ctx.state.droppedUnquoted as number,
          model: ctx.state.model as string,
        };
        if (!kept.length) return { kind: 'done', output: { ...base, proposed: [], actionId: null } };
        const where = `${base.source.title ?? 'fonte'}${i.sourceDate ? `, ${i.sourceDate}` : ''}`;
        const content = (k: (typeof kept)[number]) => `${k.statement} — "${k.quote}" (${where})`;
        const r = await ctx.effect('propose', 'memory.propose', { memories: kept.map((k) => ({ kind: k.kind, content: content(k), evidence: k.evidence })) });
        if (r.status === 'pending') return { kind: 'wait_action', actionId: r.actionId };
        if (r.status === 'refused') {
          if (r.state === 'FAILED') throw new SkillError('TOOL_FAILED', `memory.propose failed: ${r.reason ?? 'unknown'}`);
          return { kind: 'done', output: { ...base, proposed: kept.map((k) => ({ memoryId: null, statement: k.statement, quote: k.quote, category: k.category, kind: k.kind })), actionId: r.actionId } };
        }
        const ids = (await ctx.read('memory.proposals', { actionId: r.actionId })) as { id: string; content: string }[];
        return {
          kind: 'done',
          output: { ...base, actionId: r.actionId, proposed: kept.map((k) => ({ memoryId: ids.find((m) => m.content === content(k))?.id ?? null, statement: k.statement, quote: k.quote, category: k.category, kind: k.kind })) },
        };
      },
    },
  ],
};
