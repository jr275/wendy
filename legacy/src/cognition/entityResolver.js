/**
 * ENTITY RESOLUTION ENGINE
 * Resolves inbound signals (emails, phone numbers, names) to known ontological entities.
 */
export class EntityResolver {
  constructor(entityRepo, relationshipRepo, principalId) {
    this.entityRepo = entityRepo;
    this.principalId = principalId;
    this.relationshipRepo = relationshipRepo;
  }

  /**
   * Resolves entities referenced in an event envelope
   * @param {Object} eventEnvelope
   * @returns {Promise<{ primaryPerson: Object|null, organization: Object|null, relationship: Object|null, allEntityIds: string[] }>}
   */
  async resolveEntities(eventEnvelope) {
    const payload = eventEnvelope.payload || {};
    const candidates = [];

    // 1. Check direct entityIds if provided
    if (eventEnvelope.primaryEntity?.entityId) {
      const p = await this.entityRepo.getPerson(eventEnvelope.primaryEntity.entityId);
      if (p) candidates.push(p);
    }

    // 2. Check actor identifier or email
    const emailToTest = payload.from || payload.email || eventEnvelope.actor?.identifier;
    if (emailToTest) {
      const match = await this.entityRepo.findPersonByEmail(emailToTest);
      if (match) candidates.push(match);
    }

    // 3. Check name mentions in text or payload
    const nameToTest = payload.person || payload.name || payload.contact;
    if (nameToTest && candidates.length === 0) {
      const target = nameToTest.toLowerCase().trim();
      const matches = (await this.entityRepo.searchPeople(nameToTest))
        .filter(p => p.fullName.toLowerCase() === target);
      if (matches.length === 1) candidates.push(matches[0]);
    }

    // If still no candidate, search in subject or body
    if (candidates.length === 0 && (payload.subject || payload.body || payload.text)) {
      const fullText = `${payload.subject || ''} ${payload.body || ''} ${payload.text || ''}`;
      const allPeople = await this.entityRepo.getAllPeople();
      for (const person of allPeople) {
        if (person.id !== this.principalId) {
          const firstName = person.fullName.split(' ')[0].toLowerCase();
          if (fullText.toLowerCase().includes(firstName)) {
            candidates.push(person);
            break;
          }
        }
      }
    }

    const primaryPerson = candidates[0] || null;
    let organization = null;
    let relationship = null;

    if (primaryPerson) {
      if (primaryPerson.organizationId) {
        organization = await this.entityRepo.getOrganization(primaryPerson.organizationId);
      }
      relationship = await this.relationshipRepo.getRelationshipBetween(this.principalId, primaryPerson.id);
    }

    const allEntityIds = [];
    if (primaryPerson) allEntityIds.push(primaryPerson.id);
    if (organization) allEntityIds.push(organization.id);
    if (relationship) allEntityIds.push(relationship.id);

    return {
      primaryPerson,
      organization,
      relationship,
      allEntityIds
    };
  }
}
