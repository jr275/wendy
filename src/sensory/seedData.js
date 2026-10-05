/**
 * WENDY SEED DATA & REALISTIC SENSORY ENVIRONMENT
 * Recreates the exact high-fidelity executive scenario described in the Wendy specification.
 */

export function seedExecutiveEnvironment(memoryStore) {
  // 1. Executive
  const executive = {
    id: 'person-exec-joao',
    fullName: 'João Mendes',
    title: 'Executive Managing Partner',
    emailAddresses: ['joao@firm.com'],
    tier: 1,
    timeZone: 'America/Los_Angeles'
  };
  memoryStore.upsertPerson(executive);

  // 2. Carlos (Tier 1 Partner)
  const carlos = {
    id: 'person-carlos',
    fullName: 'Carlos Drummond',
    title: 'General Partner',
    organizationId: 'org-horizon-capital',
    emailAddresses: ['carlos@horizoncap.com'],
    tier: 1,
    timeZone: 'America/Los_Angeles',
    notesSummary: 'High-leverage co-investor. Board member on 2 mutual portfolio assets. Direct, data-oriented.'
  };
  memoryStore.upsertPerson(carlos);

  // Relationship: João <-> Carlos
  memoryStore.upsertRelationship({
    id: 'rel-joao-carlos',
    personAId: executive.id,
    personBId: carlos.id,
    relationshipType: 'INVESTOR',
    closenessScore: 0.92,
    velocity: 'ACCELERATING',
    lastInteractionAt: new Date(Date.now() - 14 * 86400000).toISOString(),
    interactionCadenceDays: 14,
    reciprocityBalance: -1, // João owes Carlos revised terms
    historicalNotes: [
      'Met 14 days ago for dinner. Agreed in principle on strategic partnership.',
      'Carlos stressed that his investment committee meets this Thursday.',
      'João promised to revisit the pricing escalation model in Clause 4.'
    ]
  });

  // 3. Mariana Vance (Tier 1 Strategic Partner)
  // Birthday is TOMORROW
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowMonth = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const tomorrowDay = String(tomorrow.getDate()).padStart(2, '0');

  const mariana = {
    id: 'person-mariana',
    fullName: 'Mariana Vance',
    title: 'Managing Director & Founder',
    organizationId: 'org-apex-bio',
    emailAddresses: ['mariana@apexbio.com'],
    tier: 1,
    birthday: `1984-${tomorrowMonth}-${tomorrowDay}`,
    timeZone: 'Europe/London',
    notesSummary: 'Crucial European alliance partner. Deeply values authentic personal rapport.'
  };
  memoryStore.upsertPerson(mariana);

  // Relationship: João <-> Mariana
  memoryStore.upsertRelationship({
    id: 'rel-joao-mariana',
    personAId: executive.id,
    personBId: mariana.id,
    relationshipType: 'KEY_CLIENT',
    closenessScore: 0.88,
    velocity: 'STABLE',
    lastInteractionAt: new Date(Date.now() - 32 * 86400000).toISOString(),
    interactionCadenceDays: 45,
    reciprocityBalance: 0,
    historicalNotes: [
      'Sent personal birthday message last year reflecting on her European expansion.',
      'Mariana replied with high warmth, mentioning it made her day.',
      'Preferred communication: Direct personal email, warm and unhurried tone.'
    ]
  });

  // 4. Commitment: Revised numbers promised to João (Partner) due TODAY
  memoryStore.upsertCommitment({
    id: 'comm-numbers-today',
    title: 'Send revised financial model & valuation sensitivities',
    description: 'Promised Mariana and Carlos revised numbers by Friday end-of-week.',
    promisorId: executive.id,
    promiseeId: carlos.id,
    dueDate: new Date().toISOString().split('T')[0] + 'T17:00:00Z',
    isExecutivePromise: true,
    status: 'PENDING',
    sourceInteractionId: 'email-tuesday-commitment',
    urgencyLevel: 'HIGH'
  });

  // Historical Episodic Log
  memoryStore.appendEpisodicRecord({
    interactionType: 'EMAIL_SENT',
    entityIds: [executive.id, mariana.id],
    summary: 'Sent personal birthday note to Mariana Vance.',
    verbatimSnippet: 'Mariana — wishing you a wonderful birthday. Still reflecting on your bold moves in the European market.',
    provenanceSource: 'GMAIL_HISTORICAL'
  });

  memoryStore.appendEpisodicRecord({
    interactionType: 'MEETING',
    entityIds: [executive.id, carlos.id],
    summary: 'Dinner discussion on Horizon partnership. Carlos expressed timeline urgency before Thursday board.',
    verbatimSnippet: 'Carlos: "If we can resolve Clause 4 pricing before Thursday, the committee will greenlight."',
    provenanceSource: 'CALENDAR_HISTORICAL'
  });

  console.log('✅ Wendy executive environment successfully seeded with realistic entities.');
}
