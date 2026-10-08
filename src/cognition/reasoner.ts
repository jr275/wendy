/**
 * Which model reasons for Wendy. Claude is the product's reasoner and the default.
 * WENDY_REASONER=gemini is an MVP-only override (principal's decision, 2026-10-07): it is labeled as
 * "not Claude" everywhere and never counts for the Phase 1 gate, which always uses Claude directly.
 */
import type { Db } from '../db/db.js';
import { GeminiReasoningClient } from './gemini.js';
import { ClaudeReasoningClient, type ReasoningClient } from './llm.js';

export type ReasonerKind = 'claude' | 'gemini';

export function reasonerKind(): ReasonerKind {
  const k = (process.env.WENDY_REASONER ?? 'claude').toLowerCase();
  if (k !== 'claude' && k !== 'gemini') throw new Error(`WENDY_REASONER must be "claude" or "gemini" (got "${k}")`);
  return k;
}

export function createReasoner(db: Db, kind: ReasonerKind = reasonerKind()): ReasoningClient {
  return kind === 'gemini' ? new GeminiReasoningClient(db) : new ClaudeReasoningClient(db);
}
