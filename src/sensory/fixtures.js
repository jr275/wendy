import crypto from 'node:crypto';
import { ActionState } from '../repositories/fileStorage.js';

/**
 * CONTROLLED DEVELOPMENT FIXTURES
 * Used strictly when database is brand new. Never silently overwrites existing records.
 */
export async function initializeDatabaseWithFixtures({
  entityRepo,
  relationshipRepo,
  memoryRepo,
  actionRepo,
  forceSeed = false
}) {
  const peopleCount = await entityRepo.countPeople();
  
  if (peopleCount > 0 && !forceSeed) {
    console.log(`[BOOT] Existing state detected (${peopleCount} entities). Skipping fixture seeding.`);
    return { seeded: false, reason: 'EXISTING_STATE_LOADED' };
  }

  console.log('[BOOT] Database is empty. Seeding controlled development fixtures (clearly labeled)...');

  // 1. Executive Principal
  const executive = {
    id: 'person-exec-joao',
    fullName: 'João Mendes',
    title: 'Executive Managing Partner',
    emailAddresses: ['joao@firm.com'],
    tier: 1,
    timeZone: 'America/Los_Angeles',
    provenance: {
      sourceType: 'DEVELOPMENT_FIXTURE',
      derivationTimestamp: new Date().toISOString()
    }
  };
  await entityRepo.savePerson(executive);

  // 2. Carlos Drummond
  const carlos = {
    id: 'person-carlos',
    fullName: 'Carlos Drummond',
    title: 'General Partner',
    organizationId: 'org-horizon-capital',
    emailAddresses: ['carlos@horizoncap.com'],
    tier: 1,
    timeZone: 'America/Los_Angeles',
    notesSummary: 'General Partner at Horizon Capital. Co-sits on 2 mutual portfolio company boards. Investment committee meets Thursdays.',
    provenance: {
      sourceType: 'DEVELOPMENT_FIXTURE',
      derivationTimestamp: new Date().toISOString()
    }
  };
  await entityRepo.savePerson(carlos);

  // Organization: Horizon Capital
  await entityRepo.saveOrganization({
    id: 'org-horizon-capital',
    name: 'Horizon Capital',
    strategicImportance: 'CRITICAL',
    provenance: { sourceType: 'DEVELOPMENT_FIXTURE' }
  });

  // Relationship: João <-> Carlos
  await relationshipRepo.saveRelationship({
    id: 'rel-joao-carlos',
    personAId: executive.id,
    personBId: carlos.id,
    relationshipType: 'INVESTOR',
    closenessScore: 0.92,
    velocity: 'ACCELERATING',
    lastInteractionAt: new Date(Date.now() - 14 * 86400000).toISOString(),
    interactionCadenceDays: 14,
    reciprocityBalance: -1,
    historicalNotes: [
      'Met 14 days ago for dinner. Agreed in principle on strategic partnership.',
      'Carlos stressed that his investment committee meets this Thursday.',
      'João promised to revisit the pricing escalation model in Clause 4.'
    ],
    provenance: { sourceType: 'DEVELOPMENT_FIXTURE' }
  });

  // 3. Mariana Vance
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
    notesSummary: 'Managing Director at Apex Bio. European expansion partner.',
    provenance: {
      sourceType: 'DEVELOPMENT_FIXTURE',
      derivationTimestamp: new Date().toISOString()
    }
  };
  await entityRepo.savePerson(mariana);

  // Relationship: João <-> Mariana
  await relationshipRepo.saveRelationship({
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
    ],
    provenance: { sourceType: 'DEVELOPMENT_FIXTURE' }
  });

  // Executive Preferences
  await memoryRepo.savePreference({
    id: 'pref-drafting-voice',
    domain: 'DRAFTING_STYLE',
    rule: 'Concise, direct, authentic, and warm. Avoid corporate boilerplate such as "Hope this email finds you well".',
    strength: 'STRICT_CONSTRAINT',
    createdAt: new Date().toISOString()
  });

  await memoryRepo.savePreference({
    id: 'pref-calendar-friday',
    domain: 'CALENDAR',
    rule: 'Protect Friday afternoons after 14:00 for deep strategic reflection.',
    strength: 'STRONG_PREFERENCE',
    createdAt: new Date().toISOString()
  });

  // Seed initial episodic memory
  await memoryRepo.appendEpisodic({
    interactionType: 'EMAIL_SENT',
    entityIds: [executive.id, mariana.id],
    summary: 'Sent personal birthday note to Mariana Vance.',
    verbatimSnippet: 'Mariana — wishing you a wonderful birthday. Still reflecting on your bold moves in the European market.',
    provenanceSource: 'DEVELOPMENT_FIXTURE'
  });

  await memoryRepo.appendEpisodic({
    interactionType: 'MEETING',
    entityIds: [executive.id, carlos.id],
    summary: 'Dinner discussion on Horizon partnership. Carlos expressed timeline urgency before Thursday board.',
    verbatimSnippet: 'Carlos: "If we can resolve Clause 4 pricing before Thursday, the committee will greenlight."',
    provenanceSource: 'DEVELOPMENT_FIXTURE'
  });

  // Seed default staged action into the ActionRepository so it is persistent!
  await actionRepo.saveAction({
    actionId: 'act-mariana-birthday',
    actionType: 'SEND_EMAIL',
    authorizationLevel: 3,
    state: ActionState.AWAITING_APPROVAL,
    targetEntityId: mariana.id,
    targetEntityName: mariana.fullName,
    headline: 'Send Birthday Greeting to Mariana Vance (Tier 1)',
    justification: [
      'Birthday is tomorrow (Fact: Verified in Contact profile)',
      'Crucial European alliance partner (Fact: Tier 1 Closeness 0.88)',
      'Sent personal message last year acknowledging expansion (Fact: Episodic log)',
      'Calibrated in executive voice: Direct, personal, warm, unhurried (Rule: Preference #1)'
    ],
    preview: {
      recipient: 'mariana@apexbio.com',
      scheduledFor: 'Tomorrow at 08:30 (BST)',
      subject: 'Happy Birthday, Mariana',
      body: `Mariana,

Wishing you a wonderful birthday tomorrow. 

I was reflecting on our discussion last month regarding the European market expansion—the pace of execution at Apex continues to impress me. I hope you take time away from the pipeline to celebrate with family.

Warmly,
João`
    },
    consequences: {
      reversibility: 'IRREVERSIBLE ON SEND',
      impact: 'Reinforces critical European strategic alliance; zero commercial push.'
    },
    epistemicState: 'RECOMMENDATION',
    provenance: {
      sourceType: 'DEVELOPMENT_FIXTURE'
    }
  });

  console.log('✅ Controlled development fixture initialization complete.');
  return { seeded: true, reason: 'FIRST_BOOT_FIXTURE_INITIALIZED' };
}
