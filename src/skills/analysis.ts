/**
 * Evidence-backed analysis of captured sources (web pages, documents), shared by skills.
 * Same epistemics as answers: every source becomes a handle in an EvidenceRegistry, the model's
 * claims are validated against it, and only valid claims leave this function.
 */
import { z } from 'zod';
import { EvidenceRegistry, renderEvidence } from '../cognition/context.js';
import { AnswerSchema } from '../cognition/schemas.js';
import { validateAnswer } from '../cognition/validator.js';
import type { CapturedSource } from '../tools/sources.js';
import { SOURCE_ANALYSIS_SYSTEM } from './prompts.js';
import type { StepContext } from './types.js';

export const SourceRefSchema = z.object({ handle: z.string(), sourceId: z.string(), uri: z.string(), title: z.string().nullable() });

export const AnalysisSchema = z.object({
  answer: z.string(),
  answerValid: z.boolean(),
  claims: z.array(z.object({ label: z.string(), kind: z.string(), statement: z.string(), confidence: z.number(), evidence: z.array(z.string()) })),
  rejectedClaims: z.number().int(),
  conflicts: z.array(z.object({ description: z.string(), evidence: z.array(z.string()) })),
  gaps: z.array(z.string()),
  sources: z.array(SourceRefSchema),
  model: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const PASSAGE_CHARS = 1500;
const MAX_PASSAGES = 40;

/** Splits a document into passages at paragraph boundaries, so claims can cite a specific part. */
export function passages(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > PASSAGE_CHARS) {
      out.push(cur);
      cur = '';
    }
    if (para.length > PASSAGE_CHARS) {
      for (let i = 0; i < para.length; i += PASSAGE_CHARS) out.push(para.slice(i, i + PASSAGE_CHARS));
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out.slice(0, MAX_PASSAGES);
}

/** Wraps outside text so it reads as data; a source cannot close the wrapper early. */
function untrusted(meta: string, content: string): string {
  return `<untrusted_source ${meta}>\n${content.replace(/<\/?\s*untrusted_source/gi, '‹untrusted_source')}\n</untrusted_source>`;
}

export async function analyzeSources(ctx: StepContext, opts: { purpose: string; request: string; sources: CapturedSource[]; instructions: string; principalLanguage: string }): Promise<Analysis> {
  const registry = new EvidenceRegistry();
  const refs: Analysis['sources'] = [];
  for (const s of opts.sources) {
    if (s.kind === 'web_page') {
      const handle = registry.add({ kind: 'web_page', id: s.id }, s.fetched_at, untrusted(`url="${s.uri}" title="${(s.title ?? '').replace(/"/g, "'")}"`, s.content));
      refs.push({ handle, sourceId: s.id, uri: s.uri, title: s.title });
    } else {
      passages(s.content).forEach((p, i) => {
        const handle = registry.add({ kind: 'document', id: `${s.id}:${i + 1}` }, s.fetched_at, untrusted(`document="${(s.title ?? '').replace(/"/g, "'")}" passage="${i + 1}"`, p));
        refs.push({ handle, sourceId: s.id, uri: s.uri, title: s.title });
      });
    }
  }
  const r = await ctx.reason({
    purpose: opts.purpose,
    system: SOURCE_ANALYSIS_SYSTEM,
    user: [`Principal's language: ${opts.principalLanguage}.`, `Current time: ${ctx.now.toISOString()}`, `Skill notes: ${opts.instructions}`, `Request: ${opts.request}`, '', 'Sources:', renderEvidence(registry)].join('\n'),
    schema: AnswerSchema,
    effort: 'medium',
    evidenceRefs: registry.refs(),
  });
  const v = validateAnswer(r.output, registry, ctx.now);
  // Code-produced FACT entries restate the sources; only the model's claims are reported.
  const modelClaims = v.claims.filter((c) => c.producedBy !== 'CODE');
  const valid = modelClaims.filter((c) => c.valid);
  const used = new Set(valid.flatMap((c) => c.evidence.map((e) => e.handle)));
  return {
    answer: r.output.answer,
    answerValid: v.narrative.valid,
    claims: valid.map((c) => ({ label: c.label, kind: c.kind, statement: c.statement, confidence: c.confidence, evidence: c.evidence.map((e) => e.handle) })),
    rejectedClaims: modelClaims.length - valid.length,
    conflicts: v.conflicts,
    gaps: v.gaps,
    // Keep cited sources first; a document's passages collapse to one entry per handle actually used.
    sources: refs.filter((s) => used.has(s.handle) || s.handle.startsWith('W')),
    model: r.model,
  };
}
