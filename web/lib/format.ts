export const stripRefs = (s: string | null | undefined) => (s ?? "").replace(/\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\](?:\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\])*/g, "").trim();
export const intPt = (n: number) => Math.round(n).toLocaleString("pt-BR");
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
export function dateLong(d: Date, tz: string) {
  const s = d.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function greeting(d: Date, tz: string) {
  const h = Number(d.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}
export const firstName = (n: string) => n.split(" ")[0] ?? n;
export const EVENT_LABEL: Record<string, string> = {
  EMAIL_RECEIVED: "e-mail",
  COMMITMENT_DUE: "compromisso",
  PERSON_DATE_APPROACHING: "data pessoal",
  PRINCIPAL_NOTE: "nota sua",
  PRINCIPAL_QUESTION: "pergunta",
  SEARCH_PERFORMANCE_CHANGE: "site · Google",
};
export const ACTION_LABEL: Record<string, string> = {
  SEND_EMAIL: "E-mail",
  PREPARE_BRIEFING: "Briefing",
  "contacts.save": "Salvar contato",
  "tasks.create": "Criar tarefas",
  "tasks.update": "Atualizar tarefa",
  "tasks.complete": "Concluir tarefa",
  "tasks.delete": "Apagar tarefa",
  "memory.propose": "Propor memórias",
  "voice.call": "Fazer uma ligação",
};
