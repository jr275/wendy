/**
 * Tool catalog — data only (no implementations), so actions, policy and UI can read it without
 * importing any I/O. Implementations live next to it (web.ts, documents.ts, tasks.ts) and are wired
 * in tools/index.ts.
 *
 * A tool is one capability with a fixed category and risk. It holds no business logic of a skill:
 * skills decide *what* to do, tools only *do* it.
 */
import type { ActionCategory, RiskLevel } from '../permissions/policy.js';

export interface ToolSpec {
  name: string;
  description: string;
  category: ActionCategory;
  risk: RiskLevel;
  /** WRITE only: what happens when the principal has not set a policy. */
  defaultMode?: 'AUTO' | 'REQUIRE_APPROVAL';
  /** Shown to the principal on approval cards (pt-BR). */
  label: string;
}

export const TOOL_SPECS = {
  'web.search': { name: 'web.search', description: 'Find public web pages about a query (Google Search via Gemini on Vertex).', category: 'READ', risk: 'LOW', label: 'Buscar na web' },
  'web.fetch': { name: 'web.fetch', description: 'Read one public web page as text (public internet only).', category: 'READ', risk: 'LOW', label: 'Ler página da web' },
  'documents.list': { name: 'documents.list', description: "List readable files in the principal's authorized documents folder.", category: 'READ', risk: 'LOW', label: 'Listar documentos' },
  'documents.read': { name: 'documents.read', description: 'Read one file from the authorized documents folder as text.', category: 'READ', risk: 'LOW', label: 'Ler documento' },
  'tasks.list': { name: 'tasks.list', description: "List the principal's open tasks.", category: 'READ', risk: 'LOW', label: 'Ver tarefas' },
  'tasks.create': { name: 'tasks.create', description: 'Create tasks for the principal.', category: 'WRITE', risk: 'LOW', defaultMode: 'REQUIRE_APPROVAL', label: 'Criar tarefas' },
  'tasks.complete': { name: 'tasks.complete', description: 'Mark one task as done.', category: 'WRITE', risk: 'LOW', defaultMode: 'AUTO', label: 'Concluir tarefa' },
  'tasks.delete': { name: 'tasks.delete', description: 'Delete one task (kept in history as DELETED).', category: 'DESTRUCTIVE', risk: 'MEDIUM', label: 'Apagar tarefa' },
  'memory.proposals': { name: 'memory.proposals', description: 'List the memory proposals created by one action (id, content, status).', category: 'READ', risk: 'LOW', label: 'Ver propostas de memória' },
  // Proposals are inert until the principal confirms each one, so writing them runs by default.
  'memory.propose': { name: 'memory.propose', description: 'Record memory PROPOSALS about the principal (inactive until the principal confirms each).', category: 'WRITE', risk: 'LOW', defaultMode: 'AUTO', label: 'Propor memórias' },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_SPECS;

export const isToolName = (s: string): s is ToolName => Object.hasOwn(TOOL_SPECS, s);

export function toolSpec(name: string): ToolSpec | undefined {
  return isToolName(name) ? TOOL_SPECS[name] : undefined;
}
