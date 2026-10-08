/** document-analysis: read one file from the authorized folder → evidence-backed analysis by passage. */
import { z } from 'zod';
import { AnalysisSchema, analyzeSources } from '../analysis.js';
import type { SkillDefinition } from '../types.js';

const Input = z.object({
  path: z.string().min(1).max(500).describe('Path relative to the documents folder, copied from the documents list.'),
  question: z.string().min(3).max(1000).default('Resuma o documento e destaque prazos, valores, obrigações e riscos.'),
});
const Output = AnalysisSchema.extend({ path: z.string(), question: z.string(), pages: z.number().nullable(), truncated: z.boolean() });
export type DocumentAnalysisOutput = z.infer<typeof Output>;

export const documentAnalysis: SkillDefinition<z.infer<typeof Input>, DocumentAnalysisOutput> = {
  id: 'document-analysis',
  name: 'Análise de documento',
  description: "Read one document from the principal's documents folder (txt, md, pdf) and answer a question about it, citing passages.",
  version: '1.0.0',
  category: 'documents',
  triggers: [{ kind: 'intent', examples: ['Resuma o PDF que coloquei na pasta de documentos', 'Quais são os prazos e multas desse contrato?', 'O que diz a apólice do seguro?'] }],
  requiredTools: ['documents.read'],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: 'Cite the passages that support each point. Quote numbers and dates exactly as written. Say when the document was truncated.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'read',
      label: 'Lendo o documento',
      timeoutMs: 60_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const doc = (await ctx.read('documents.read', { path: i.path })) as { sourceId: string; path: string; pages: number | null; truncated: boolean };
        Object.assign(ctx.state, { sourceId: doc.sourceId, path: doc.path, pages: doc.pages, truncated: doc.truncated });
        return { kind: 'next' };
      },
    },
    {
      id: 'analyze',
      label: 'Analisando com citação de trechos',
      retry: { attempts: 2, backoffMs: 2000 },
      timeoutMs: 180_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const sources = await ctx.sources([ctx.state.sourceId as string]);
        const analysis = await analyzeSources(ctx, {
          purpose: 'analyze',
          request: `${i.question}${ctx.state.truncated ? '\n(The document was truncated; only its beginning is available.)' : ''}`,
          sources,
          instructions: documentAnalysis.instructions,
          principalLanguage: await ctx.language(),
        });
        return { kind: 'done', output: { ...analysis, path: ctx.state.path as string, question: i.question, pages: (ctx.state.pages as number | null) ?? null, truncated: !!ctx.state.truncated } };
      },
    },
  ],
};
