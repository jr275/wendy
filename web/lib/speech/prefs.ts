/**
 * Voice preferences: what the person chose, per device (localStorage, this browser only). Pure parsing here; the storage is touched by the hook.
 * Anything that is not exactly valid falls back to the defaults, field by field — a bad value never turns a setting ON by accident.
 */
import { z } from "zod";
import type { VoicePreferences } from "./types";

export const DEFAULT_VOICE_PREFS: VoicePreferences = { version: 1, consented: false, speakReplies: true, autoSend: false, voiceId: null, rate: 1, volume: 1, lang: "pt-BR" };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function parseVoicePrefs(raw: unknown): VoicePreferences {
  const base = DEFAULT_VOICE_PREFS;
  const r = z.object({}).passthrough().safeParse(raw);
  if (!r.success) return base;
  const o = r.data as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  return {
    version: 1,
    consented: o.consented === true, // only an explicit true counts
    speakReplies: bool(o.speakReplies, base.speakReplies),
    autoSend: o.autoSend === true, // only an explicit true counts
    voiceId: typeof o.voiceId === "string" && o.voiceId.length <= 300 ? o.voiceId : null,
    rate: num(o.rate, base.rate, 0.5, 2),
    volume: num(o.volume, base.volume, 0, 1),
    lang: "pt-BR",
  };
}
