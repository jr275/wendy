import fs from 'node:fs';

/** Loads .env (gitignored) once, without overriding variables already set. */
export function loadEnv(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export const MODELS = {
  /** All reasoning runs on the current Opus; never silently downgraded. */
  reasoning: 'claude-opus-5-5',
} as const;

export const PROMPT_VERSION = 'core-v2'; // v2: every principal-facing field in the principal's language

/**
 * Salience weights. These are policy constants (how much each factor counts), not per-item scores.
 * Every item's factor values are computed from data or validated model assessments.
 */
export const SALIENCE_WEIGHTS = {
  importance: 0.14,
  urgency: 0.14,
  relationship_relevance: 0.1,
  business_impact: 0.14,
  novelty: 0.06,
  confidence: 0.1,
  time_sensitivity: 0.16,
  actionability: 0.1,
  executive_preference: 0.06,
  reply_pressure: 0.08, // applies only when the principal owes a reply (see salience.ts)
} as const;

/** Insights scoring at or above this are surfaced proactively; below are persisted as SUPPRESSED. */
export const SURFACE_THRESHOLD = 0.5;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres:///wendy';
}
