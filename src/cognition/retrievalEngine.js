/**
 * LEGACY PROTOTYPE RETRIEVAL
 *
 * Lists persisted records related to the query. It does not reason and does not
 * recommend: the previous keyword-routed "cases" and canned recommendations were
 * removed. Every line returned is a persisted record, labeled with its id.
 */
export class RetrievalEngine {
  constructor({ entityRepo, relationshipRepo, memoryRepo, actionRepo, principalId = process.env.WENDY_PRINCIPAL_ID || 'person-exec-joao' }) {
    this.entityRepo = entityRepo;
    this.relationshipRepo = relationshipRepo;
    this.memoryRepo = memoryRepo;
    this.actionRepo = actionRepo;
    this.principalId = principalId;
  }

  async answerQuery(query) {
    const qLower = query.toLowerCase();
    const allPeople = await this.entityRepo.getAllPeople();
    const matchedPeople = allPeople.filter(p => p.id !== this.principalId && qLower.includes(p.fullName.toLowerCase().split(' ')[0]));
    const matchedPerson = matchedPeople.length === 1 ? matchedPeople[0] : null;

    const personMemories = matchedPerson ? await this.memoryRepo.queryEpisodic({ entityId: matchedPerson.id, limit: 15 }) : [];
    const queryMatches = await this.memoryRepo.queryEpisodic({ textQuery: query, limit: 10 });
    const records = Array.from(new Map([...personMemories, ...queryMatches].map(m => [m.id, m])).values());
    const relationship = matchedPerson ? await this.relationshipRepo.getRelationshipBetween(this.principalId, matchedPerson.id) : null;

    const facts = [];
    let reply = 'Legacy prototype: persisted records only, no reasoning.\n\n';
    if (matchedPerson) {
      reply += `- Entity: ${matchedPerson.fullName} (${matchedPerson.id})\n`;
      facts.push({ type: 'FACT', text: `Entity ${matchedPerson.id}: ${matchedPerson.fullName}`, recordId: matchedPerson.id });
    }
    for (const note of relationship?.historicalNotes || []) {
      reply += `- Relationship note (${relationship.id}): ${note}\n`;
      facts.push({ type: 'FACT', text: note, recordId: relationship.id });
    }
    for (const e of records) {
      reply += `- Episodic record (${e.id}): ${e.summary}\n`;
      facts.push({ type: 'FACT', text: e.summary, recordId: e.id });
    }
    if (facts.length === 0) reply += `- No persisted records found for "${query}".\n`;

    return { reply, epistemicBreakdown: facts, groundedInRecordIds: facts.map(f => f.recordId) };
  }
}
