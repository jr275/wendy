/**
 * Tool contracts. A READ tool has `run`; a tool with an effect has `effect`, and is only ever reached
 * through an approved action (src/actions) — never called directly by a skill.
 */
import type { z } from 'zod';
import type { Db } from '../db/db.js';
import type { ToolSpec } from './specs.js';

export interface ToolContext {
  db: Db;
  principalId: string;
  now: Date;
  /** The skill run on whose behalf the tool runs (for provenance). */
  executionId?: string;
}

export type ToolErrorCode = 'INVALID_INPUT' | 'BLOCKED' | 'NOT_FOUND' | 'TIMEOUT' | 'NETWORK' | 'UPSTREAM' | 'TOO_LARGE' | 'UNSUPPORTED' | 'NOT_ALLOWED';

/** Structured tool failure. `retryable` says whether trying again can help. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ReadTool<I, O> {
  spec: ToolSpec;
  input: z.ZodType<I>;
  run(ctx: ToolContext, input: I): Promise<O>;
}

/** Same shape the action executor uses for built-in effects: perform once, read back, compare. */
export interface ToolEffect<I> {
  spec: ToolSpec;
  input: z.ZodType<I>;
  perform(ctx: ToolContext & { actionId: string }, input: I): Promise<{ providerRef: string }>;
  readBack(ctx: ToolContext & { actionId: string }, input: I): Promise<{ providerRef: string; observed: Record<string, unknown> } | null>;
  expected(input: I): Record<string, unknown>;
  /**
   * Long-running effects only (e.g. a phone call): after perform, the effect keeps going. The executor
   * calls settle until it says 'done', and only then verifies. Effects without settle are unchanged.
   */
  settle?(ctx: ToolContext & { actionId: string }, input: I): Promise<'done' | 'pending'>;
}

export type AnyReadTool = ReadTool<any, unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type AnyToolEffect = ToolEffect<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
