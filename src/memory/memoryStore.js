import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EpistemicState } from '../types/domain.js';

const DATA_DIR = path.resolve('data');
const MEMORY_FILE = path.join(DATA_DIR, 'wendy_memory.json');

/**
 * Multi-Tier Persistent Memory Store for Wendy
 */
export class MemoryStore {
  constructor() {
    this.ensureDataDirectory();
    this.state = this.loadFromDisk() || this.getInitialState();
  }

  ensureDataDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  getInitialState() {
    return {
      people: {},
      organizations: {},
      relationships: {},
      calendarEvents: {},
      emails: {},
      commitments: {},
      episodicMemory: [],
      preferences: [
        {
          id: 'pref-drafting-voice',
          domain: 'DRAFTING_STYLE',
          rule: 'Concise, direct, authentic, and warm. Avoid corporate boilerplate such as "Hope this email finds you well".',
          strength: 'STRICT_CONSTRAINT',
          createdAt: new Date().toISOString()
        },
        {
          id: 'pref-calendar-friday',
          domain: 'CALENDAR',
          rule: 'Protect Friday afternoons after 14:00 for deep strategic reflection.',
          strength: 'STRONG_PREFERENCE',
          createdAt: new Date().toISOString()
        },
        {
          id: 'pref-relationship-tier1',
          domain: 'RELATIONSHIP',
          rule: 'Always prepare personal birthday greetings for Tier 1 contacts 24 hours in advance.',
          strength: 'STRICT_CONSTRAINT',
          createdAt: new Date().toISOString()
        }
      ],
      historicalOutcomes: []
    };
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('Could not read memory file, initializing fresh memory state:', err.message);
    }
    return null;
  }

  saveToDisk() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save memory to disk:', err);
    }
  }

  // --- Entity Operations ---
  upsertPerson(person) {
    this.state.people[person.id] = {
      ...this.state.people[person.id],
      ...person,
      updatedAt: new Date().toISOString()
    };
    this.saveToDisk();
    return this.state.people[person.id];
  }

  getPerson(id) {
    return this.state.people[id] || null;
  }

  findPersonByNameOrEmail(query) {
    const q = query.toLowerCase();
    return Object.values(this.state.people).find(p => 
      p.fullName.toLowerCase().includes(q) ||
      (p.emailAddresses && p.emailAddresses.some(e => e.toLowerCase().includes(q)))
    );
  }

  upsertRelationship(rel) {
    this.state.relationships[rel.id] = {
      ...this.state.relationships[rel.id],
      ...rel,
      updatedAt: new Date().toISOString()
    };
    this.saveToDisk();
    return this.state.relationships[rel.id];
  }

  getRelationship(personAId, personBId) {
    return Object.values(this.state.relationships).find(
      r => (r.personAId === personAId && r.personBId === personBId) ||
           (r.personAId === personBId && r.personBId === personAId)
    );
  }

  upsertCommitment(comm) {
    this.state.commitments[comm.id] = {
      ...this.state.commitments[comm.id],
      ...comm,
      updatedAt: new Date().toISOString()
    };
    this.saveToDisk();
    return this.state.commitments[comm.id];
  }

  // --- Episodic Memory ---
  appendEpisodicRecord({
    interactionType,
    entityIds,
    summary,
    verbatimSnippet = null,
    provenanceSource = 'SYSTEM'
  }) {
    const entry = {
      id: `ep-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      interactionType,
      entityIds: entityIds || [],
      summary,
      verbatimSnippet,
      provenanceHash: crypto.createHash('sha256').update(summary + (verbatimSnippet || '')).digest('hex'),
      provenanceSource
    };
    this.state.episodicMemory.unshift(entry); // newest first
    this.saveToDisk();
    return entry;
  }

  getRecentInteractionsForEntity(entityId, limit = 5) {
    return this.state.episodicMemory
      .filter(m => m.entityIds.includes(entityId))
      .slice(0, limit);
  }

  // --- Historical Outcomes ---
  recordOutcome({
    actionId,
    actionType,
    decision, // APPROVED, MODIFIED, REJECTED
    executiveFeedback = null,
    wasSuccessful = true,
    verificationDetails = {}
  }) {
    const outcome = {
      id: `out-${crypto.randomUUID()}`,
      recordedAt: new Date().toISOString(),
      actionId,
      actionType,
      decision,
      executiveFeedback,
      wasSuccessful,
      verificationDetails
    };
    this.state.historicalOutcomes.unshift(outcome);
    this.saveToDisk();
    return outcome;
  }

  // Full state snapshot
  getSnapshot() {
    return {
      people: this.state.people,
      relationships: this.state.relationships,
      commitments: this.state.commitments,
      preferences: this.state.preferences,
      episodicMemoryCount: this.state.episodicMemory.length,
      recentEpisodic: this.state.episodicMemory.slice(0, 8),
      historicalOutcomes: this.state.historicalOutcomes.slice(0, 5)
    };
  }
}

export const globalMemory = new MemoryStore();
