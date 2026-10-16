/**
 * contact-import: bring an address book (a CSV in the import folder) into the principal's contacts, in ONE approved batch.
 * Names and phone numbers only. The plan is computed first (counts, no personal data); the approval card shows those counts; the approved
 * action re-checks that the file is the same one. Nothing is sent to anyone.
 */
import { z } from 'zod';
import type { ImportSummary } from '../../people/contactImport.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z.object({
  file: z.string().min(1).max(200).describe('The file name inside the import folder (not a path).'),
  defaultCountry: z.string().regex(/^\d{1,3}$/).optional().describe("Country code for numbers that have none (default 55). Only if the principal said it."),
  defaultArea: z.string().regex(/^\d{2}$/).optional().describe('Area code to complete numbers that have none. ONLY if the principal told you which one; never guess it.'),
});
const Output = z.object({
  status: z.enum(['done', 'declined', 'nothing_to_import']),
  summary: z.object({ total: z.number(), toCreate: z.number(), alreadyKnown: z.number(), duplicatesInFile: z.number(), noName: z.number(), noPhone: z.number(), invalidPhone: z.number(), sharedNames: z.number(), invalidReasons: z.record(z.string(), z.number()) }),
  report: z.string().nullable(),
  actionId: z.string().nullable(),
});
export type ContactImportOutput = z.infer<typeof Output>;

export const contactImport: SkillDefinition<z.infer<typeof Input>, ContactImportOutput> = {
  id: 'contact-import',
  name: 'Importar contatos',
  description: "Import the principal's contacts from a CSV file placed in the import folder: names and phone numbers only, in one approved batch. Reports what will be created and what is left out (and why) before asking.",
  version: '1.0.0',
  category: 'people',
  triggers: [{ kind: 'intent', examples: ['Importe os contatos do arquivo contatos.csv', 'Quero subir minha agenda de contatos de um CSV'] }],
  requiredTools: ['contacts.import_plan', 'contacts.import'],
  composable: false,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: 'Never guess an area code or a country code. Report the counts exactly as computed, including what is left out and the report file name. Never contact anyone.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'import',
      label: 'Importando contatos',
      timeoutMs: 120_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const plan = (await ctx.read('contacts.import_plan', i)) as { fileName: string; sha256: string; summary: ImportSummary; report: string | null };
        if (plan.summary.toCreate === 0) return { kind: 'done', output: { status: 'nothing_to_import', summary: plan.summary, report: plan.report, actionId: null } };
        const r = await ctx.effect('import', 'contacts.import', { ...i, sha256: plan.sha256, fileName: plan.fileName, summary: plan.summary });
        if (r.status === 'pending') return { kind: 'wait_action', actionId: r.actionId };
        if (r.status === 'refused') {
          if (r.state === 'FAILED') throw new SkillError('TOOL_FAILED', `contacts.import failed: ${r.reason ?? 'unknown'}`);
          return { kind: 'done', output: { status: 'declined', summary: plan.summary, report: plan.report, actionId: r.actionId } };
        }
        return { kind: 'done', output: { status: 'done', summary: plan.summary, report: plan.report, actionId: r.actionId } };
      },
    },
  ],
};
