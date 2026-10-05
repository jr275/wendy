/**
 * WENDY DOMAIN MODEL & CONTRACT DEFINITIONS
 * Strict ontological schemas for people, relationships, commitments, events, and actions.
 */

export const EpistemicState = {
  FACT: 'FACT',
  INFERENCE: 'INFERENCE',
  HYPOTHESIS: 'HYPOTHESIS',
  RECOMMENDATION: 'RECOMMENDATION'
};

export const AuthorizationLevel = {
  LEVEL_0_OBSERVE: 0,
  LEVEL_1_PREPARE: 1,
  LEVEL_2_INTERNAL_MUTATION: 2,
  LEVEL_3_EXTERNAL_MUTATION: 3,
  LEVEL_4_HIGH_IMPACT: 4
};

export const SalienceCategory = {
  URGENT: 'URGENT',
  RELATIONSHIP: 'RELATIONSHIP',
  COMMITMENT: 'COMMITMENT',
  CAN_WAIT: 'CAN_WAIT'
};

/**
 * Creates a standardized BaseEntity envelope
 */
export function createBaseEntity({
  id,
  source = 'SYSTEM',
  epistemicState = EpistemicState.FACT,
  confidence = 1.0,
  provenance = {},
  lifecycleState = 'ACTIVE',
  tags = []
}) {
  const now = new Date().toISOString();
  return {
    id: id || `urn:wendy:${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    source,
    epistemicState,
    confidence,
    provenance: {
      sourceType: provenance.sourceType || 'API_READ',
      sourceId: provenance.sourceId || null,
      sourceHash: provenance.sourceHash || null,
      derivationTimestamp: provenance.derivationTimestamp || now,
      evidenceSnippets: provenance.evidenceSnippets || []
    },
    lifecycleState,
    tags
  };
}
