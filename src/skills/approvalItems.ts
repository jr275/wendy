/**
 * What the principal is asked to approve, in words. An approval card must show the CONTENT of the action (names, numbers, changes), never just a
 * label: approving something you cannot read is not approving it. Pure, so every tool's wording is tested.
 */
export interface ApprovalLookups {
  /** Title of the task the action points at. */
  taskTitle?: string | null;
  /** Name of the existing contact the action points at. */
  contactName?: string | null;
}

const PRIORITY: Record<string, string> = { LOW: 'baixa', NORMAL: 'normal', HIGH: 'alta', URGENT: 'urgente' };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function approvalItems(actionType: string, content: Record<string, unknown>, look: ApprovalLookups = {}): string[] {
  const c = content;
  switch (actionType) {
    case 'contacts.save': {
      const lines: string[] = [];
      if (str(c.personId)) lines.push(`Contato existente: ${look.contactName ?? '(não encontrado)'}`);
      if (str(c.fullName)) lines.push(`Nome: ${str(c.fullName)}`);
      if (str(c.phone)) lines.push(`Telefone: ${str(c.phone)}`);
      if (str(c.context)) lines.push(`Contexto: ${str(c.context)}`);
      if (str(c.note)) lines.push(`Nota: ${str(c.note)}`);
      if (c.allowDuplicateName === true) lines.push('Você confirmou que é outra pessoa com o mesmo nome');
      return lines;
    }
    case 'contacts.import': {
      const s = (c.summary ?? {}) as Record<string, unknown>;
      const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
      const lines: string[] = [];
      if (str(c.fileName)) lines.push(`Arquivo: ${str(c.fileName)}`);
      if (n('toCreate') !== null) lines.push(`${n('toCreate')} contatos novos serão criados`);
      if (n('alreadyKnown')) lines.push(`${n('alreadyKnown')} já existem (mesmo telefone) e não serão duplicados`);
      if (n('duplicatesInFile')) lines.push(`${n('duplicatesInFile')} repetidos dentro do arquivo serão unidos`);
      if (n('noPhone')) lines.push(`${n('noPhone')} sem telefone ficam de fora`);
      if (n('invalidPhone')) lines.push(`${n('invalidPhone')} com telefone incompleto ficam de fora (listados no relatório)`);
      if (n('noName')) lines.push(`${n('noName')} sem nome ficam de fora`);
      lines.push('Nada é enviado a ninguém; só são guardados nome e telefone');
      return lines;
    }
    case 'tasks.update': {
      const lines: string[] = [];
      if (look.taskTitle) lines.push(look.taskTitle);
      if ('priority' in c) lines.push(c.priority ? `Prioridade: ${PRIORITY[String(c.priority)] ?? c.priority}` : 'Remover a prioridade');
      if ('category' in c) lines.push(c.category ? `Categoria: ${String(c.category)}` : 'Remover a categoria');
      if ('snoozedUntil' in c) lines.push(c.snoozedUntil ? `Adiar até ${when(String(c.snoozedUntil))}` : 'Trazer de volta (sem adiamento)');
      if (c.archived === true) lines.push('Arquivar');
      if (c.archived === false) lines.push('Desarquivar');
      return lines;
    }
    default:
      return [];
  }
}
