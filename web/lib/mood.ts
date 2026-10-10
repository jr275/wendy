/**
 * Mood presentation on the interface side: strict validation of what the server sent, the user's
 * preferences, and the deterministic, stabilized choice of one or two characters. Pure functions.
 *
 * Mood is TRANSIENT and presentation-only: it never gates or changes approvals, permissions, budgets
 * or actions; it is not stored (only the user's own preferences are, in this browser).
 */
import { z } from "zod";
import { characterFor, type CharacterId } from "./characters";

export const MOOD_CATEGORIES = ["positive_energy", "calm", "curious", "concerned", "frustrated", "sad"] as const;
export type MoodCategory = (typeof MOOD_CATEGORIES)[number];
export const MOOD_EVIDENCE_SOURCES = ["explicit_user_statement", "current_conversation", "user_selected", "default"] as const;
export const RESPONSE_TONES = ["warm", "calm", "concise", "encouraging", "analytical", "neutral"] as const;

const Category = z.enum(MOOD_CATEGORIES);
const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a date");
const MoodSchema = z.object({
  category: Category,
  confidence: z.number().min(0).max(1),
  evidenceSource: z.enum(MOOD_EVIDENCE_SOURCES),
  responseTone: z.enum(RESPONSE_TONES),
  secondary: z.object({ category: Category, confidence: z.number().min(0).max(1) }).optional(),
  updatedAt: Iso,
  expiresAt: Iso,
});
export type MoodPresentation = z.infer<typeof MoodSchema>;

/** Anything that is not exactly a valid mood is "no mood" (never partially trusted). */
export function parseMood(raw: unknown): MoodPresentation | null {
  const r = MoodSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export const MIN_CONFIDENCE = 0.6;
/** A different category replaces the shown one at once only with this much confidence… */
export const SWITCH_CONFIDENCE = 0.75;
/** …otherwise it must be read twice in a row. */
export const SWITCH_CONFIRMATIONS = 2;

export const isExpired = (m: MoodPresentation, now: Date) => Date.parse(m.expiresAt) <= now.getTime();

// ── user preferences (the user's own control; stored per browser) ────────────────────────
export interface MoodPrefs {
  /** false = no characters at all. */
  enabled: boolean;
  /** A category the user picked, or "neutral"; wins over any inference. null = follow the reading. */
  selected: MoodCategory | "neutral" | null;
}
export const DEFAULT_PREFS: MoodPrefs = { enabled: true, selected: null };

export function parsePrefs(raw: unknown): MoodPrefs {
  const r = z.object({ enabled: z.boolean(), selected: z.union([Category, z.literal("neutral"), z.null()]) }).safeParse(raw);
  return r.success ? r.data : DEFAULT_PREFS;
}

// ── stabilized selection ─────────────────────────────────────────────────────────────────
export interface SelectorState {
  shown: { category: MoodCategory; secondary?: MoodCategory; expiresAt: string } | null;
  candidate: { category: MoodCategory; count: number } | null;
  /** Readings at or before this time were corrected by the user and are ignored. */
  correctedAt: string | null;
}
export const INITIAL_SELECTOR: SelectorState = { shown: null, candidate: null, correctedAt: null };

const NEGATIVE: readonly MoodCategory[] = ["concerned", "frustrated", "sad"];
/** A second character only when it adds context and does not contradict the first. */
export function compatible(primary: MoodCategory, secondary: MoodCategory): boolean {
  if (primary === secondary) return false;
  const pos = (c: MoodCategory) => c === "positive_energy";
  return !((pos(primary) && NEGATIVE.includes(secondary)) || (pos(secondary) && NEGATIVE.includes(primary)));
}

/**
 * One reading in (or none), the new state out. Hysteresis: the same category refreshes; a different
 * one replaces it only when strong or confirmed twice; no reading keeps what is shown until it expires.
 * The result is deterministic — no randomness anywhere.
 */
export function stepSelector(state: SelectorState, mood: MoodPresentation | null, now: Date): SelectorState {
  const s = state.shown && Date.parse(state.shown.expiresAt) <= now.getTime() ? { ...state, shown: null, candidate: null } : state;
  if (!mood || isExpired(mood, now) || mood.confidence < MIN_CONFIDENCE) return s;
  if (s.correctedAt && Date.parse(mood.updatedAt) <= Date.parse(s.correctedAt)) return s;
  const secondary = mood.secondary && compatible(mood.category, mood.secondary.category) ? mood.secondary.category : undefined;
  if (!s.shown) return { ...s, shown: { category: mood.category, secondary, expiresAt: mood.expiresAt }, candidate: null };
  if (s.shown.category === mood.category) return { ...s, shown: { category: mood.category, secondary, expiresAt: mood.expiresAt }, candidate: null };
  const count = s.candidate?.category === mood.category ? s.candidate.count + 1 : 1;
  if (mood.confidence >= SWITCH_CONFIDENCE || count >= SWITCH_CONFIRMATIONS) return { ...s, shown: { category: mood.category, secondary, expiresAt: mood.expiresAt }, candidate: null };
  return { ...s, candidate: { category: mood.category, count } };
}

/** The user said "this is not it": back to neutral now, and readings up to now are ignored. */
export const correct = (now: Date): SelectorState => ({ shown: null, candidate: null, correctedAt: now.toISOString() });

export interface Selection {
  category: MoodCategory | "neutral";
  primary: CharacterId | null;
  secondary: CharacterId | null;
  /** Why: lets the control say it honestly. */
  basis: "disabled" | "user_selected" | "reading" | "neutral";
}
const NEUTRAL: Selection = { category: "neutral", primary: null, secondary: null, basis: "neutral" };

export function selectPresentation(state: SelectorState, prefs: MoodPrefs, now: Date): Selection {
  if (!prefs.enabled) return { ...NEUTRAL, basis: "disabled" };
  if (prefs.selected === "neutral") return { ...NEUTRAL, basis: "user_selected" };
  if (prefs.selected) return { category: prefs.selected, primary: characterFor(prefs.selected), secondary: null, basis: "user_selected" };
  const shown = state.shown && Date.parse(state.shown.expiresAt) > now.getTime() ? state.shown : null;
  if (!shown) return NEUTRAL;
  const primary = characterFor(shown.category);
  if (!primary) return NEUTRAL; // a reading with no character yet (e.g. calm): the neutral halo
  const secondary = shown.secondary ? characterFor(shown.secondary) : null;
  return { category: shown.category, primary, secondary: secondary && secondary !== primary ? secondary : null, basis: "reading" };
}

export const MOOD_LABEL: Record<MoodCategory, string> = { positive_energy: "animada", calm: "calma", curious: "curiosa", concerned: "preocupada", frustrated: "frustrada", sad: "abatida" };
export const MOOD_CHOICE_LABEL: Record<MoodCategory, string> = { positive_energy: "Alegria", calm: "Calma", curious: "Curiosidade", concerned: "Preocupação", frustrated: "Frustração", sad: "Tristeza" };
