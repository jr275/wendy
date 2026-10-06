/**
 * Retrieval evaluation set (SYNTHETIC — labeled as such in every report).
 *
 * Records are written in the mix the principal really has (Portuguese and English). Each case
 * lists the records that SHOULD come back for a question, and two term sets:
 *   - literal: the words as the person would phrase them (worst case for lexical search)
 *   - instructed: what the understanding prompt asks Claude to produce — inflected variants,
 *     synonyms and both languages. These are authored by hand following that instruction; the
 *     terms Claude really produces can only be measured with live calls (BLOCKED without credit).
 */
export type RecordKind = 'message' | 'meeting' | 'commitment' | 'memory';

export interface EvalRecord {
  key: string;
  kind: RecordKind;
  person: 'carlos' | 'ana' | 'ingrid' | 'beatriz' | 'vendor' | 'hr' | 'noise' | null;
  title: string; // subject / meeting title / commitment / memory content
  body?: string;
}

export const EVAL_PEOPLE = {
  carlos: { name: 'Carlos Drummond', email: 'carlos@horizoncap.com' },
  ana: { name: 'Ana Lima', email: 'ana@clienteco.com.br' },
  ingrid: { name: 'Ingrid Sá', email: 'ingrid@nordbank.com.br' },
  beatriz: { name: 'Beatriz Lemos', email: 'beatriz@mendes-partners.com' },
  vendor: { name: 'Financeiro Fornecedor', email: 'financeiro@fornecedor.com.br' },
  hr: { name: 'People Team', email: 'people@mendes-partners.com' },
  noise: { name: 'Marketing Externo', email: 'contato@eventos.com' },
} as const;

export const EVAL_RECORDS: EvalRecord[] = [
  { key: 'M1', kind: 'message', person: 'carlos', title: 'Pricing for the 2027 renewal', body: 'We would like a tiered pricing structure with a volume discount above 500 seats.' },
  { key: 'M2', kind: 'message', person: 'carlos', title: 'Board feedback', body: 'The board wants a cap on the volume discount before signing the renewal.' },
  { key: 'M3', kind: 'message', person: 'ana', title: 'Proposta comercial revisada', body: 'Segue a proposta revisada com os novos preços por usuário e o desconto progressivo.' },
  { key: 'M4', kind: 'message', person: 'ana', title: 'Contrato de licenciamento', body: 'O jurídico revisou as cláusulas do contrato; falta a assinatura do diretor.' },
  { key: 'M5', kind: 'message', person: 'ingrid', title: 'Residência de dados', body: 'Precisamos garantir que os dados dos clientes fiquem armazenados no Brasil, conforme a LGPD.' },
  { key: 'M6', kind: 'message', person: 'ingrid', title: 'Auditoria de segurança', body: 'A auditoria apontou três vulnerabilidades no servidor de arquivos.' },
  { key: 'M7', kind: 'message', person: 'beatriz', title: 'Mudança de escritório', body: 'A mudança para o novo escritório está confirmada para novembro.' },
  { key: 'M8', kind: 'message', person: 'beatriz', title: 'Office move logistics', body: 'Movers arrive on the 14th; please pack personal items.' },
  { key: 'M9', kind: 'message', person: 'vendor', title: 'Fatura em atraso', body: 'A fatura de setembro está vencida há 15 dias; por favor regularizem o pagamento.' },
  { key: 'M10', kind: 'message', person: 'carlos', title: 'Investment committee', body: 'Our investment committee meets on Thursday to discuss the follow-on round.' },
  { key: 'M11', kind: 'message', person: 'ana', title: 'Orçamento 2027', body: 'O orçamento de marketing para 2027 foi aprovado com corte de 10%.' },
  { key: 'M12', kind: 'message', person: 'hr', title: 'Hiring plan', body: 'We are opening two engineering positions in Q1.' },
  { key: 'M13', kind: 'message', person: 'ingrid', title: 'Reuniao com o conselho', body: 'Podemos marcar a reuniao do conselho para a próxima semana?' },
  { key: 'M14', kind: 'message', person: 'beatriz', title: 'Almoço sexta', body: 'Vamos almoçar na sexta?' },
  { key: 'M15', kind: 'message', person: 'carlos', title: 'Term sheet', body: 'Attached is the revised term sheet with the new valuation.' },
  { key: 'M16', kind: 'message', person: 'vendor', title: 'Invoice overdue', body: 'Your August invoice is 30 days past due.' },
  { key: 'M17', kind: 'message', person: 'ana', title: 'Renovação do contrato', body: 'A renovação do contrato com a Horizon precisa sair até dezembro.' },
  { key: 'M18', kind: 'message', person: 'noise', title: 'Convite webinar', body: 'Participe do nosso webinar sobre vendas e preços dinâmicos.' },
  { key: 'MT1', kind: 'meeting', person: 'carlos', title: 'Pricing review with Horizon' },
  { key: 'MT2', kind: 'meeting', person: 'ingrid', title: 'Reunião do conselho' },
  { key: 'MT3', kind: 'meeting', person: 'ingrid', title: 'Revisão de segurança' },
  { key: 'C1', kind: 'commitment', person: 'carlos', title: 'Send Carlos the revised pricing schedule' },
  { key: 'C2', kind: 'commitment', person: 'ana', title: 'Enviar a proposta assinada para a Ana' },
  { key: 'C3', kind: 'commitment', person: 'ingrid', title: 'Responder à auditoria de segurança' },
  { key: 'MEM1', kind: 'memory', person: 'carlos', title: 'Carlos prefere mensagens curtas e objetivas' },
  { key: 'MEM2', kind: 'memory', person: 'ingrid', title: 'Ingrid é sensível a temas de privacidade e LGPD' },
];

export type Category = 'exato' | 'flexão' | 'acento' | 'sinônimo' | 'tradução' | 'paráfrase';

export interface EvalCase {
  question: string;
  category: Category;
  literal: string[];
  instructed: string[];
  expected: string[];
}

export const EVAL_CASES: EvalCase[] = [
  { question: 'Qual o status do pricing com o Carlos?', category: 'exato', literal: ['pricing'], instructed: ['pricing', 'preço', 'preços', 'precificação', 'price'], expected: ['M1', 'MT1', 'C1'] },
  { question: 'O que mudou no term sheet?', category: 'exato', literal: ['term sheet'], instructed: ['term sheet', 'valuation', 'avaliação', 'termo de compromisso'], expected: ['M15'] },
  { question: 'Como está a auditoria?', category: 'exato', literal: ['auditoria'], instructed: ['auditoria', 'auditorias', 'segurança', 'audit', 'security'], expected: ['M6', 'MT3', 'C3'] },
  { question: 'Como o Carlos gosta de receber mensagens?', category: 'exato', literal: ['mensagens'], instructed: ['mensagem', 'mensagens', 'comunicação', 'message', 'messages'], expected: ['MEM1'] },
  { question: 'Quais propostas estão abertas?', category: 'flexão', literal: ['propostas'], instructed: ['proposta', 'propostas', 'proposal', 'proposals'], expected: ['M3', 'C2'] },
  { question: 'O que temos de renovações?', category: 'flexão', literal: ['renovações'], instructed: ['renovação', 'renovações', 'renewal', 'renewals'], expected: ['M1', 'M2', 'M17'] },
  { question: 'Which discounts did we offer?', category: 'flexão', literal: ['discounts'], instructed: ['discount', 'discounts', 'desconto', 'descontos'], expected: ['M1', 'M2', 'M3'] },
  { question: 'Novidades sobre investimentos?', category: 'flexão', literal: ['investimentos'], instructed: ['investimento', 'investimentos', 'investment', 'follow-on'], expected: ['M10'] },
  { question: 'Quais os precos combinados?', category: 'acento', literal: ['precos'], instructed: ['preço', 'preços', 'pricing', 'price', 'prices'], expected: ['M1', 'M3', 'MT1', 'C1'] },
  { question: 'Quando é a reunião do conselho?', category: 'acento', literal: ['reunião conselho'], instructed: ['reunião', 'conselho', 'board meeting', 'board'], expected: ['M13', 'MT2'] },
  { question: 'Como está o acordo com a Horizon?', category: 'sinônimo', literal: ['acordo'], instructed: ['acordo', 'contrato', 'contratos', 'agreement', 'contract'], expected: ['M4', 'M17'] },
  { question: 'Tem algum boleto atrasado?', category: 'sinônimo', literal: ['boleto atrasado'], instructed: ['boleto', 'fatura', 'atraso', 'pagamento', 'invoice', 'overdue'], expected: ['M9', 'M16'] },
  { question: 'Qual o valuation atual?', category: 'sinônimo', literal: ['valor da empresa'], instructed: ['valuation', 'avaliação', 'valor', 'term sheet'], expected: ['M15'] },
  { question: 'What is the budget for next year?', category: 'tradução', literal: ['budget'], instructed: ['budget', 'orçamento', 'orçamentos', 'budgets'], expected: ['M11'] },
  { question: 'Any news on data residency?', category: 'tradução', literal: ['data residency'], instructed: ['data residency', 'residência de dados', 'LGPD', 'privacidade', 'privacy'], expected: ['M5', 'MEM2'] },
  { question: 'Quais vagas vamos abrir?', category: 'tradução', literal: ['vagas'], instructed: ['vaga', 'vagas', 'contratação', 'hiring', 'positions'], expected: ['M12'] },
  { question: 'Alguém está cobrando um pagamento?', category: 'paráfrase', literal: ['cobrando pagamento'], instructed: ['cobrança', 'pagamento', 'fatura', 'invoice', 'payment', 'past due'], expected: ['M9', 'M16'] },
  { question: 'Quando vamos para a nova sede?', category: 'paráfrase', literal: ['nova sede'], instructed: ['sede', 'escritório', 'mudança', 'office', 'move'], expected: ['M7', 'M8'] },
  { question: 'Quem cuida da proteção de dados dos clientes?', category: 'paráfrase', literal: ['proteção de dados'], instructed: ['proteção de dados', 'privacidade', 'LGPD', 'dados', 'privacy'], expected: ['M5', 'MEM2'] },
];
