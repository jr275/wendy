/**
 * contact-management: find a contact, save a new one the principal described, or add a note to one.
 * It stores ONLY what the principal said (no surname, e-mail, company or relationship is ever added), asks the principal to approve every save,
 * looks for an existing person first (same phone, or same name) so nothing is duplicated, and never messages or calls anyone.
 */
import { z } from 'zod';
import { normalizeName, normalizePhone, type ContactView } from '../../people/contacts.js';
import { SaveContactSchema } from '../../tools/contacts.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('find'), text: z.string().max(200).optional().describe('A name, or words from what the person is to the principal.'), phone: z.string().max(30).optional().describe('A phone number or its last digits.') }),
  z.object({ operation: z.literal('save') }).extend(SaveContactSchema.shape),
  z.object({ operation: z.literal('note'), personId: z.uuid(), note: z.string().trim().min(1).max(1000) }),
]);

const Contact = z.object({ id: z.string(), fullName: z.string(), phones: z.array(z.string()), emails: z.array(z.string()), context: z.string().nullable(), notes: z.array(z.string()), origin: z.enum(['PRINCIPAL', 'MAILBOX']) });
const Output = z.object({
  operation: z.enum(['find', 'save', 'note']),
  status: z.enum(['done', 'declined', 'needs_confirmation']),
  contacts: z.array(Contact),
  actionId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ContactManagementOutput = z.infer<typeof Output>;

export const contactManagement: SkillDefinition<z.infer<typeof Input>, ContactManagementOutput> = {
  id: 'contact-management',
  name: 'Contatos',
  description:
    "The principal's contacts: find one by name, phone number or what the person is to them; save a new contact the principal described (name, phone, context); or add a note. Only what the principal said is stored. Never messages or calls anyone.",
  version: '1.0.0',
  category: 'people',
  triggers: [
    {
      kind: 'intent',
      examples: [
        'Cadastre o contato Fulano, telefone +55 11 90000-0000, ele é o dentista',
        'Quem é o Fulano que trabalha com ingressos?',
        'Qual é o telefone do Fulano?',
        'Anote que o Fulano prefere falar de manhã',
        'Tenho algum contato com final 0000?',
      ],
    },
  ],
  requiredTools: ['contacts.find', 'contacts.save'],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions:
    'Use only what the principal said: never invent a surname, e-mail, company or relationship, and never fill a field they did not give. Answer "who is X" with the stored contact and its context, and say plainly when nothing is stored. A phone number needs its country code; if it has none, leave it out and ask. This skill never sends a message or places a call.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'apply',
      label: 'Cuidando do contato',
      timeoutMs: 30_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const find = async (q: { text?: string; phone?: string; personId?: string }) => (await ctx.read('contacts.find', q)) as ContactView[];
        const done = (operation: 'find' | 'save' | 'note', status: 'done' | 'declined' | 'needs_confirmation', contacts: ContactView[], actionId: string | null, reason: string | null) => ({ kind: 'done' as const, output: { operation, status, contacts, actionId, reason } });

        if (i.operation === 'find') return done('find', 'done', await find({ text: i.text, phone: i.phone }), null, null);

        // Before asking for approval: is this person already in the address book?
        let personId: string | null = i.personId ?? null;
        const phone = 'phone' in i && i.phone ? normalizePhone(i.phone) : null;
        if ('phone' in i && i.phone && !phone) throw new SkillError('INVALID_INPUT', 'o telefone precisa do código do país (por exemplo +55 21 90000-0000); peça o número completo');
        if (!personId && phone) personId = (await find({ phone })).find((c) => c.phones.includes(phone))?.id ?? null;
        if (i.operation === 'save' && !personId && i.fullName && !i.allowDuplicateName) {
          const same = (await find({ text: i.fullName })).filter((c) => normalizeName(c.fullName) === normalizeName(i.fullName!));
          if (same.length) return done('save', 'needs_confirmation', same, null, 'já existe um contato com esse nome; pergunte se é outra pessoa ou se é para atualizar o existente');
        }
        if (i.operation === 'save' && !personId && !i.fullName) throw new SkillError('INVALID_INPUT', 'para cadastrar um contato novo é preciso o nome');

        const content: Record<string, unknown> = i.operation === 'note' ? { personId: i.personId, note: i.note } : { personId: personId ?? undefined, fullName: personId ? undefined : i.fullName, phone: i.phone, context: i.context, note: i.note, allowDuplicateName: i.allowDuplicateName };
        for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k];
        const r = await ctx.effect(i.operation, 'contacts.save', content);
        if (r.status === 'pending') return { kind: 'wait_action', actionId: r.actionId };
        if (r.status === 'refused') {
          if (r.state === 'FAILED') throw new SkillError('TOOL_FAILED', `contacts.save failed: ${r.reason ?? 'unknown'}`);
          return done(i.operation, 'declined', [], r.actionId, r.reason ?? r.state);
        }
        const after = personId ? await find({ personId }) : await find(phone ? { phone } : { text: i.operation === 'save' ? i.fullName : undefined });
        return done(i.operation, 'done', after.slice(0, 3), r.actionId, null);
      },
    },
  ],
};
