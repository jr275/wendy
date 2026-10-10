/**
 * Apparent conversational mood — a PRESENTATION signal, never a fact about the person and never an
 * input to any decision. The model reads only the principal's request and proposes a draft with the
 * words it is based on; CODE decides whether it counts:
 *   - the evidence quote must be verbatim in the request, else there is no mood;
 *   - the category is a closed enum (anything else is ignored);
 *   - an inferred mood (not stated by the principal) is capped below the strong-evidence band, so a
 *     single message can never produce a confident reading; weak evidence → neutral (null);
 *   - it expires; it is transient (shown for this conversation moment only, not stored in memory —
 *     it travels as agent state for the run and is not written to any table).
 * Mood never changes permissions, approvals, budgets, skills or what Wendy does.
 */
import { z } from 'zod';
import { quoteInSource } from '../cognition/validator.js';

export const MOOD_CATEGORIES = ['positive_energy', 'calm', 'curious', 'concerned', 'frustrated', 'sad'] as const;
export type MoodCategory = (typeof MOOD_CATEGORIES)[number];

export const MOOD_EVIDENCE_SOURCES = ['explicit_user_statement', 'current_conversation', 'user_selected', 'default'] as const;
export type MoodEvidenceSource = (typeof MOOD_EVIDENCE_SOURCES)[number];

export const RESPONSE_TONES = ['warm', 'calm', 'concise', 'encouraging', 'analytical', 'neutral'] as const;
export type ResponseTone = (typeof RESPONSE_TONES)[number];

/** What the model may propose (null = neutral / not enough evidence). */
export const MoodDraftSchema = z.object({
  category: z.enum(MOOD_CATEGORIES),
  confidence: z.number().min(0).max(1),
  /** explicit = the principal said how they feel; current_conversation = apparent from the request itself. */
  evidence_source: z.enum(['explicit_user_statement', 'current_conversation']),
  evidence_quote: z.string().describe('copied verbatim from the request'),
  response_tone: z.enum(RESPONSE_TONES),
  /** A second, different reading, only when clearly also present. */
  secondary: z.object({ category: z.enum(MOOD_CATEGORIES), confidence: z.number().min(0).max(1) }).nullable().optional(),
});
export type MoodDraft = z.infer<typeof MoodDraftSchema>;

/** What travels to the interface (validated again there). Identifiers only — never asset paths or CSS. */
export interface MoodPresentation {
  category: MoodCategory;
  confidence: number;
  evidenceSource: MoodEvidenceSource;
  responseTone: ResponseTone;
  secondary?: { category: MoodCategory; confidence: number };
  updatedAt: string;
  expiresAt: string;
}

/** Below this, the presentation stays neutral. */
export const MIN_CONFIDENCE = 0.6;
/** A mood inferred from the request alone is never stronger than this. */
export const INFERRED_CAP = 0.65;
export const MOOD_TTL_MS = 10 * 60_000;

export function validateMood(draft: MoodDraft | null | undefined, request: string, now: Date): MoodPresentation | null {
  const parsed = MoodDraftSchema.safeParse(draft);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (!d.evidence_quote.trim() || !quoteInSource(d.evidence_quote, request)) return null;
  const confidence = d.evidence_source === 'explicit_user_statement' ? d.confidence : Math.min(d.confidence, INFERRED_CAP);
  if (confidence < MIN_CONFIDENCE) return null;
  const second = d.secondary && d.secondary.category !== d.category && Math.min(d.secondary.confidence, INFERRED_CAP) >= MIN_CONFIDENCE ? { category: d.secondary.category, confidence: Math.min(d.secondary.confidence, INFERRED_CAP) } : undefined;
  return {
    category: d.category,
    confidence,
    evidenceSource: d.evidence_source,
    responseTone: d.response_tone,
    ...(second ? { secondary: second } : {}),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MOOD_TTL_MS).toISOString(),
  };
}
