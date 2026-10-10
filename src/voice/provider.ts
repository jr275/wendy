/**
 * VoiceProvider — the telephony boundary. Deliberately small: only what the runtime needs.
 * Status and transcript are not separate calls: both are the provider's event stream (`getCall`),
 * folded by the state machine. The provider transports; Wendy's agent (behind VoicePolicy) decides.
 */
import type { InCallAgent } from './agent.js';
import type { VoiceEvent, VoiceMandate } from './types.js';

export interface VoiceProvider {
  readonly name: string;
  /** True for simulations: everything they produce is labeled "simulated", never shown as a real call. */
  readonly simulated: boolean;
  /** Starts a call. MUST be idempotent on idempotencyKey (a retried execution never dials twice). */
  createCall(input: { idempotencyKey: string; to: string; mandate: VoiceMandate; agent: InCallAgent }): Promise<{ providerCallId: string }>;
  /** Everything that has happened on the call so far, in order. */
  getCall(providerCallId: string): Promise<{ to: string; events: VoiceEvent[] }>;
  endCall(providerCallId: string, reason: 'cancelled' | 'duration_limit'): Promise<void>;
  findCall(idempotencyKey: string): Promise<{ providerCallId: string } | null>;
}

export class VoiceProviderUnavailable extends Error {}

/** No real provider exists yet (Phase 7). VOICE_PROVIDER=mock selects the simulation. */
export async function createVoiceProvider(env: NodeJS.ProcessEnv = process.env): Promise<VoiceProvider> {
  if (env.VOICE_PROVIDER === 'mock') {
    const { MockVoiceProvider, FileMockStore } = await import('./mock.js');
    return new MockVoiceProvider({ store: new FileMockStore() });
  }
  throw new VoiceProviderUnavailable('no voice provider configured (set VOICE_PROVIDER=mock for the simulation)');
}
