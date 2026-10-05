/**
 * CONTEXT RETRIEVER & GRAPH TRAVERSAL ENGINE
 * Selectively traverses the multi-tier memory strata without dumping unnecessary tokens.
 */
export class ContextRetriever {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  /**
   * Retrieves a focused dossier for an upcoming meeting or interaction
   */
  retrieveMeetingDossier(personId) {
    const person = this.memory.getPerson(personId);
    if (!person) return null;

    const relationship = this.memory.getRelationship('person-exec-joao', personId);
    const recentInteractions = this.memory.getRecentInteractionsForEntity(personId, 3);
    const voicePreference = this.memory.state.preferences.find(p => p.domain === 'DRAFTING_STYLE');

    return {
      person,
      relationship,
      recentInteractions,
      relevantPreferences: voicePreference ? [voicePreference] : [],
      strategicObjectives: [
        'Resolve Clause 4 pricing model before Thursday committee meeting.',
        'Preserve long-term partnership trust with Horizon Capital.'
      ],
      provenanceHash: person.provenance?.sourceHash || 'manual-entry'
    };
  }

  /**
   * Retrieves context for approaching birthday milestone
   */
  retrieveMilestoneContext(personId) {
    const person = this.memory.getPerson(personId);
    if (!person) return null;

    const relationship = this.memory.getRelationship('person-exec-joao', personId);
    const recentInteractions = this.memory.getRecentInteractionsForEntity(personId, 3);
    const pastBirthdayInteractions = this.memory.state.episodicMemory.filter(
      m => m.entityIds.includes(personId) && m.summary.toLowerCase().includes('birthday')
    );

    return {
      person,
      relationship,
      pastBirthdayInteractions,
      recommendedTone: 'Personal, warm, acknowledging past shared milestones (European expansion).',
      preferredDeliveryTime: 'Tomorrow morning at 08:30 (recipient time zone)'
    };
  }

  /**
   * Retrieves pending commitments
   */
  retrievePendingCommitments() {
    return Object.values(this.memory.state.commitments).filter(
      c => c.status === 'PENDING'
    );
  }
}
