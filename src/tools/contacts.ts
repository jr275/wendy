/** contacts.find (READ) and contacts.save (WRITE, always approved): the principal's address book. Reading and writing only; nothing here contacts anyone. */
import { z } from 'zod';
import { ContactError, findContacts, getContact, normalizePhone, saveContact, type ContactView } from '../people/contacts.js';
import { applyImport, ImportError, planImport, readContacts, resolveImportFile, sha256File, writeReport, type ImportSummary } from '../people/contactImport.js';
import fs from 'node:fs';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool, type ToolEffect } from './types.js';

export const SaveContactSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional().describe('The name exactly as the person gave it. Required to create a new contact.'),
    personId: z.uuid().optional().describe('An existing contact to update (from contacts.find).'),
    phone: z.string().trim().min(8).max(30).optional().describe("With country code, e.g. '+55 21 90000-0000'."),
    context: z.string().trim().min(1).max(300).optional().describe("What the person is to the principal, in the principal's words."),
    note: z.string().trim().min(1).max(1000).optional().describe('A note to add, in the principal\'s words.'),
    allowDuplicateName: z.boolean().optional().describe('Only after the principal confirmed it is a different person with the same name.'),
  })
  .strict()
  .refine((i) => i.personId || i.fullName || i.phone, 'give a name, a phone or an existing contact')
  .refine((i) => i.fullName || i.personId || i.phone, 'nothing to save');

export function contactTools() {
  const find: ReadTool<{ text?: string; phone?: string; personId?: string }, ContactView[]> = {
    spec: TOOL_SPECS['contacts.find'],
    input: z.object({ text: z.string().max(200).optional(), phone: z.string().max(30).optional(), personId: z.uuid().optional() }).strict(),
    run: async (ctx, input) => {
      try {
        if (input.personId) {
          const c = await getContact(ctx.db, ctx.principalId, input.personId);
          return c ? [c] : [];
        }
        return await findContacts(ctx.db, ctx.principalId, input);
      } catch (e) {
        if (e instanceof ContactError) throw new ToolError('INVALID_INPUT', e.message);
        throw e;
      }
    },
  };

  const save: ToolEffect<z.infer<typeof SaveContactSchema>> = {
    spec: TOOL_SPECS['contacts.save'],
    input: SaveContactSchema,
    perform: async (ctx, i) => {
      try {
        const r = await saveContact(ctx.db, ctx.principalId, ctx.actionId, i, ctx.now);
        return { providerRef: `contact:${r.contact.id}` };
      } catch (e) {
        if (e instanceof ContactError) throw new ToolError('INVALID_INPUT', e.message);
        throw e;
      }
    },
    // Reads the stored contact back and reports only whether each thing the principal asked to save is there.
    readBack: async (ctx, i) => {
      const phone = i.phone ? normalizePhone(i.phone) : null;
      let c: ContactView | null = null;
      if (i.personId) c = await getContact(ctx.db, ctx.principalId, i.personId);
      else if (phone) c = (await findContacts(ctx.db, ctx.principalId, { phone }))[0] ?? null;
      else if (i.fullName) c = (await findContacts(ctx.db, ctx.principalId, { text: i.fullName })).find((x) => x.origin === 'PRINCIPAL') ?? null;
      if (!c) return null;
      const observed: Record<string, unknown> = {};
      if (phone) observed.phoneStored = c.phones.includes(phone);
      if (i.context) observed.contextStored = c.context !== null;
      if (i.note) observed.noteStored = c.notes.some((n) => n.includes(i.note!));
      if (i.fullName && !i.personId && !phone) observed.nameStored = true;
      return { providerRef: `contact:${c.id}`, observed };
    },
    expected: (i) => {
      const e: Record<string, unknown> = {};
      if (i.phone) e.phoneStored = true;
      if (i.context) e.contextStored = true;
      if (i.note) e.noteStored = true;
      if (i.fullName && !i.personId && !i.phone) e.nameStored = true;
      return e;
    },
  };
  const ImportInput = z.object({ file: z.string().min(1).max(200), defaultCountry: z.string().regex(/^\d{1,3}$/).optional(), defaultArea: z.string().regex(/^\d{2}$/).optional() }).strict();
  const wrapImport = <T,>(fn: () => Promise<T>) => fn().catch((e) => { if (e instanceof ImportError) throw new ToolError('INVALID_INPUT', e.message); throw e; });

  // READ: what an import would do. Counts only; the rows that would be left out go to a private report file next to the CSV.
  const importPlan: ReadTool<z.infer<typeof ImportInput>, { fileName: string; sha256: string; summary: ImportSummary; report: string | null }> = {
    spec: TOOL_SPECS['contacts.import_plan'],
    input: ImportInput,
    run: (ctx, i) => wrapImport(async () => {
      const file = resolveImportFile(i.file);
      const plan = await planImport(ctx.db, ctx.principalId, readContacts(fs.readFileSync(file, 'utf8')), { country: i.defaultCountry, area: i.defaultArea });
      return { fileName: i.file, sha256: sha256File(file), summary: plan.summary, report: plan.skipped.length ? writeReport(file, plan.skipped) : null };
    }),
  };

  // WRITE (approved): re-reads the file, refuses if it is not the one that was approved, recomputes the plan and applies it.
  const ImportEffect = ImportInput.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/), fileName: z.string().max(200).optional(), summary: z.record(z.string(), z.unknown()).optional() }).strict();
  const importSave: ToolEffect<z.infer<typeof ImportEffect>> = {
    spec: TOOL_SPECS['contacts.import'],
    input: ImportEffect,
    perform: (ctx, i) => wrapImport(async () => {
      const file = resolveImportFile(i.file);
      if (sha256File(file) !== i.sha256) throw new ToolError('INVALID_INPUT', 'o arquivo mudou depois da aprovação; planeje a importação de novo');
      const plan = await planImport(ctx.db, ctx.principalId, readContacts(fs.readFileSync(file, 'utf8')), { country: i.defaultCountry, area: i.defaultArea });
      await applyImport(ctx.db, ctx.principalId, plan, i.sha256, ctx.now);
      return { providerRef: `import:${i.sha256.slice(0, 12)}` };
    }),
    readBack: async (ctx, i) => {
      const r = await ctx.db.query(`SELECT 1 FROM audit_blocks WHERE principal_id = $1 AND event_type = 'CONTACTS_IMPORTED' AND payload->>'sha' = $2`, [ctx.principalId, i.sha256.slice(0, 12)]);
      return r.rowCount ? { providerRef: `import:${i.sha256.slice(0, 12)}`, observed: { recorded: true } } : null;
    },
    expected: () => ({ recorded: true }),
  };
  return { 'contacts.find': find, 'contacts.save': save, 'contacts.import_plan': importPlan, 'contacts.import': importSave };
}
