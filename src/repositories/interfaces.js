/**
 * WENDY REPOSITORY CONTRACTS & DOMAIN PERSISTENCE INTERFACES
 * Decouples the cognitive core from the underlying storage mechanism.
 * Target Production Implementation: PostgreSQL + pgvector
 * Development Implementation: Atomic JSON File Adapter
 */

export class EntityRepository {
  async savePerson(person) { throw new Error('Not implemented'); }
  async getPerson(id) { throw new Error('Not implemented'); }
  async findPersonByEmail(email) { throw new Error('Not implemented'); }
  async searchPeople(query) { throw new Error('Not implemented'); }
  async getAllPeople() { throw new Error('Not implemented'); }
  async countPeople() { throw new Error('Not implemented'); }

  async saveOrganization(org) { throw new Error('Not implemented'); }
  async getOrganization(id) { throw new Error('Not implemented'); }
}

export class RelationshipRepository {
  async saveRelationship(relationship) { throw new Error('Not implemented'); }
  async getRelationship(id) { throw new Error('Not implemented'); }
  async getRelationshipBetween(personAId, personBId) { throw new Error('Not implemented'); }
  async listRelationshipsFor(personId) { throw new Error('Not implemented'); }
}

export class EventRepository {
  async saveEvent(eventEnvelope) { throw new Error('Not implemented'); }
  async getEvent(eventId) { throw new Error('Not implemented'); }
  async hasEvent(eventId) { throw new Error('Not implemented'); }
  async listEvents({ eventType, entityId, limit }) { throw new Error('Not implemented'); }
}

export class ActionRepository {
  async saveAction(action) { throw new Error('Not implemented'); }
  async getAction(actionId) { throw new Error('Not implemented'); }
  async updateActionState(actionId, state, metadata) { throw new Error('Not implemented'); }
  async listActions({ state, limit }) { throw new Error('Not implemented'); }
  async deleteAction(actionId) { throw new Error('Not implemented'); }
}

export class IdempotencyRepository {
  async recordAttempt(key, actionId, operation, requestHash) { throw new Error('Not implemented'); }
  async completeAttempt(key, result) { throw new Error('Not implemented'); }
  async failAttempt(key, error) { throw new Error('Not implemented'); }
  async getRecord(key) { throw new Error('Not implemented'); }
}

export class AuditRepository {
  async appendBlock(entry) { throw new Error('Not implemented'); }
  async getBlocks(limit) { throw new Error('Not implemented'); }
  async verifyLedgerIntegrity() { throw new Error('Not implemented'); }
}

export class MemoryRepository {
  async appendEpisodic(record) { throw new Error('Not implemented'); }
  async queryEpisodic({ entityId, textQuery, limit }) { throw new Error('Not implemented'); }
  async savePreference(pref) { throw new Error('Not implemented'); }
  async getPreferences(domain) { throw new Error('Not implemented'); }
  async getAllPreferences() { throw new Error('Not implemented'); }
  async recordOutcome(outcome) { throw new Error('Not implemented'); }
  async getOutcomesForAction(actionId) { throw new Error('Not implemented'); }
}
