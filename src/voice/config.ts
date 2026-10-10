/**
 * Voice configuration. Development defaults only — not product decisions. Environment overrides:
 * VOICE_MAX_CALL_SECONDS, VOICE_MAX_CALLS_PER_TASK, VOICE_MAX_CALLS_PER_DAY, VOICE_ALLOWED_COUNTRIES,
 * VOICE_LISTING_DOMAINS, VOICE_COST_CURRENCY, VOICE_COST_PER_MINUTE, VOICE_MAX_COST_PER_CALL,
 * VOICE_MAX_COST_PER_DAY, VOICE_MAX_COST_PER_MONTH, VOICE_PREAUTHORIZE_FROM_REQUEST.
 *
 * Cost figures are placeholders until a real provider (and its price list) is chosen: calls are
 * costed as an ESTIMATE (billed minutes × rate) and labeled so.
 */
import type { VoiceLimits } from './types.js';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export interface VoiceConfig {
  limits: VoiceLimits;
  /** E.164 country codes Wendy may call. */
  allowedCountries: string[];
  /** Brazil: national numbers by prefix that are never called (premium, donation lines). */
  blockedNationalPrefixes: string[];
  /** Short and emergency services are blocked by length; listed too, so the reason is explicit. */
  emergencyNumbers: string[];
  /** Business directories / listings: a number found there ranks below the place's own site. */
  listingDomains: string[];
  costs: VoiceCostLimits;
  /**
   * When the principal's own request says to call ("liga para…"), the call needs no second
   * approval — only with a high-confidence number and nothing sensitive asked. false = always ask.
   */
  preauthorizeFromRequest: boolean;
}

export interface VoiceCostLimits {
  currency: string;
  /** Estimated price of one billed minute (from answer to hang-up, rounded up per minute). */
  perMinute: number;
  maxPerCall: number;
  maxPerDay: number;
  maxPerMonth: number;
}

const LISTING_DOMAINS = ['google.com', 'tripadvisor.com', 'tripadvisor.com.br', 'yelp.com', 'foursquare.com', 'guiamais.com.br', 'apontador.com.br', 'telelistas.net', 'ifood.com.br', 'booking.com', 'doctoralia.com.br', 'facebook.com', 'instagram.com'];

export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  return {
    limits: {
      maxCallDurationSeconds: num(env.VOICE_MAX_CALL_SECONDS, 300),
      maxCallsPerTask: num(env.VOICE_MAX_CALLS_PER_TASK, 3),
      maxCallsPerUserPerDay: num(env.VOICE_MAX_CALLS_PER_DAY, 10),
    },
    allowedCountries: (env.VOICE_ALLOWED_COUNTRIES ?? '55').split(',').map((s) => s.trim()).filter(Boolean),
    blockedNationalPrefixes: ['900', '500'],
    costs: {
      currency: env.VOICE_COST_CURRENCY ?? 'USD',
      perMinute: num(env.VOICE_COST_PER_MINUTE, 0.1),
      maxPerCall: num(env.VOICE_MAX_COST_PER_CALL, 1),
      maxPerDay: num(env.VOICE_MAX_COST_PER_DAY, 3),
      maxPerMonth: num(env.VOICE_MAX_COST_PER_MONTH, 30),
    },
    preauthorizeFromRequest: env.VOICE_PREAUTHORIZE_FROM_REQUEST !== 'false',
    listingDomains: env.VOICE_LISTING_DOMAINS ? env.VOICE_LISTING_DOMAINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : LISTING_DOMAINS,
    emergencyNumbers: ['100', '128', '153', '180', '181', '185', '188', '190', '191', '192', '193', '194', '197', '198', '199'],
  };
}
