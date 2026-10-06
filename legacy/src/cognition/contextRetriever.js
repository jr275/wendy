/**
 * DYNAMIC CONTEXT RETRIEVER
 * Gathers relevant history, preferences, and commitments for resolved entities without dumping unnecessary tokens.
 */
export class ContextRetriever {
  constructor({ entityRepo, relationshipRepo, memoryRepo }) {
    this.entityRepo = entityRepo;
    this.relationshipRepo = relationshipRepo;
    this.memoryRepo = memoryRepo;
  }

  /**
   * Retrieves context package for an event and its resolved entities
   */
  async retrieveContext({ event, resolvedEntities }) {
    const { primaryPerson, organization, relationship } = resolvedEntities;
    
    let recentInteractions = [];
    if (primaryPerson) {
      recentInteractions = await this.memoryRepo.queryEpisodic({
        entityId: primaryPerson.id,
        limit: 5
      });
    }

    const preferences = await this.memoryRepo.getAllPreferences();

    return {
      event,
      person: primaryPerson,
      organization,
      relationship,
      recentInteractions,
      preferences,
      retrievedAt: new Date().toISOString()
    };
  }
}
