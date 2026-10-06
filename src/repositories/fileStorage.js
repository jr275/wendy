import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  EntityRepository,
  RelationshipRepository,
  EventRepository,
  ActionRepository,
  IdempotencyRepository,
  AuditRepository,
  MemoryRepository
} from './interfaces.js';

const DATA_DIR = path.resolve('data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function atomicWrite(filepath, data) {
  ensureDir();
  const tmp = `${filepath}.tmp.${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

function readJsonSafe(filepath, defaultValue) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (err) {
    console.error(`Error reading ${filepath}:`, err);
  }
  return defaultValue;
}

// -------------------------------------------------------------
// 1. ENTITY REPOSITORY
// -------------------------------------------------------------
export class FileEntityRepository extends EntityRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'entities.json');
    this.data = readJsonSafe(this.file, { people: {}, organizations: {} });
  }

  save() {
    atomicWrite(this.file, this.data);
  }

  async savePerson(person) {
    this.data.people[person.id] = {
      ...this.data.people[person.id],
      ...person,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.people[person.id];
  }

  async getPerson(id) {
    return this.data.people[id] || null;
  }

  async findPersonByEmail(email) {
    const target = email.toLowerCase().trim();
    return Object.values(this.data.people).find(p => 
      p.emailAddresses && p.emailAddresses.some(e => e.toLowerCase().trim() === target)
    ) || null;
  }

  async searchPeople(query) {
    const q = query.toLowerCase().trim();
    return Object.values(this.data.people).filter(p =>
      p.fullName.toLowerCase().includes(q) ||
      (p.emailAddresses && p.emailAddresses.some(e => e.toLowerCase().includes(q))) ||
      (p.notesSummary && p.notesSummary.toLowerCase().includes(q))
    );
  }

  async getAllPeople() {
    return Object.values(this.data.people);
  }

  async countPeople() {
    return Object.keys(this.data.people).length;
  }

  async saveOrganization(org) {
    this.data.organizations[org.id] = {
      ...this.data.organizations[org.id],
      ...org,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.organizations[org.id];
  }

  async getOrganization(id) {
    return this.data.organizations[id] || null;
  }
}

// -------------------------------------------------------------
// 2. RELATIONSHIP REPOSITORY
// -------------------------------------------------------------
export class FileRelationshipRepository extends RelationshipRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'relationships.json');
    this.data = readJsonSafe(this.file, { relationships: {} });
  }

  save() {
    atomicWrite(this.file, this.data);
  }

  async saveRelationship(relationship) {
    this.data.relationships[relationship.id] = {
      ...this.data.relationships[relationship.id],
      ...relationship,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.relationships[relationship.id];
  }

  async getRelationship(id) {
    return this.data.relationships[id] || null;
  }

  async getRelationshipBetween(personAId, personBId) {
    return Object.values(this.data.relationships).find(
      r => (r.personAId === personAId && r.personBId === personBId) ||
           (r.personAId === personBId && r.personBId === personAId)
    ) || null;
  }

  async listRelationshipsFor(personId) {
    return Object.values(this.data.relationships).filter(
      r => r.personAId === personId || r.personBId === personId
    );
  }
}

// -------------------------------------------------------------
// 3. EVENT REPOSITORY (Persisted Event Ledger)
// -------------------------------------------------------------
export class FileEventRepository extends EventRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'events.json');
    this.events = readJsonSafe(this.file, []);
  }

  save() {
    atomicWrite(this.file, this.events);
  }

  async saveEvent(eventEnvelope) {
    // Check if event already exists (idempotent event storage)
    const existingIndex = this.events.findIndex(e => e.eventId === eventEnvelope.eventId);
    if (existingIndex >= 0) {
      return this.events[existingIndex];
    }
    this.events.push(eventEnvelope);
    this.save();
    return eventEnvelope;
  }

  async getEvent(eventId) {
    return this.events.find(e => e.eventId === eventId) || null;
  }

  async hasEvent(eventId) {
    return this.events.some(e => e.eventId === eventId);
  }

  async listEvents({ eventType, entityId, limit = 50 } = {}) {
    let filtered = this.events;
    if (eventType) {
      filtered = filtered.filter(e => e.eventType === eventType);
    }
    if (entityId) {
      filtered = filtered.filter(e => 
        (e.primaryEntity && e.primaryEntity.entityId === entityId) ||
        (e.secondaryEntityIds && e.secondaryEntityIds.includes(entityId))
      );
    }
    return filtered.slice(-limit).reverse();
  }
}

// -------------------------------------------------------------
// 4. ACTION REPOSITORY (Persistent Staged Actions & Lifecycle)
// -------------------------------------------------------------
export const ActionState = {
  PROPOSED: 'PROPOSED',
  STAGED: 'STAGED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
};

export class FileActionRepository extends ActionRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'actions.json');
    this.actions = readJsonSafe(this.file, {});
  }

  save() {
    atomicWrite(this.file, this.actions);
  }

  async saveAction(action) {
    const now = new Date().toISOString();
    const existing = this.actions[action.actionId];
    this.actions[action.actionId] = {
      createdAt: now,
      ...existing,
      ...action,
      updatedAt: now
    };
    this.save();
    return this.actions[action.actionId];
  }

  async getAction(actionId) {
    return this.actions[actionId] || null;
  }

  async updateActionState(actionId, state, metadata = {}) {
    const action = this.actions[actionId];
    if (!action) throw new Error(`Action not found: ${actionId}`);

    const now = new Date().toISOString();
    action.state = state;
    action.updatedAt = now;
    if (state === ActionState.APPROVED) action.approvedAt = now;
    if (state === ActionState.EXECUTED) action.executedAt = now;
    if (state === ActionState.VERIFIED) action.verifiedAt = now;

    Object.assign(action, metadata);
    this.save();
    return action;
  }

  async listActions({ state, limit = 50 } = {}) {
    let list = Object.values(this.actions);
    if (state) {
      list = list.filter(a => a.state === state);
    }
    return list.slice(0, limit);
  }

  async deleteAction(actionId) {
    delete this.actions[actionId];
    this.save();
  }
}

// -------------------------------------------------------------
// 5. IDEMPOTENCY REPOSITORY (Durable Mutation Tokens)
// -------------------------------------------------------------
export class FileIdempotencyRepository extends IdempotencyRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'idempotency.json');
    this.records = readJsonSafe(this.file, {});
  }

  save() {
    atomicWrite(this.file, this.records);
  }

  async recordAttempt(key, actionId, operation, requestHash) {
    const existing = this.records[key];
    if (existing && existing.status === 'COMPLETED') {
      return { alreadyCompleted: true, record: existing };
    }

    const record = {
      idempotencyKey: key,
      actionId,
      operation,
      requestHash,
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null
    };

    this.records[key] = record;
    this.save();
    return { alreadyCompleted: false, record };
  }

  async completeAttempt(key, result) {
    const record = this.records[key];
    if (!record) throw new Error(`Idempotency record not found: ${key}`);
    record.status = 'COMPLETED';
    record.completedAt = new Date().toISOString();
    record.result = result;
    this.save();
    return record;
  }

  async failAttempt(key, error) {
    const record = this.records[key];
    if (!record) return null;
    record.status = 'FAILED';
    record.completedAt = new Date().toISOString();
    record.error = error;
    this.save();
    return record;
  }

  async getRecord(key) {
    return this.records[key] || null;
  }
}

// -------------------------------------------------------------
// 6. AUDIT REPOSITORY (Cryptographic Ledger with Integrity Verification)
// -------------------------------------------------------------
export class FileAuditRepository extends AuditRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'audit_ledger.json');
    this.blocks = readJsonSafe(this.file, []);
  }

  save() {
    atomicWrite(this.file, this.blocks);
  }

  computeBlockHash({ prevHash, timestamp, eventType, actionId, payload }) {
    const payloadString = JSON.stringify(payload);
    return crypto.createHash('sha256')
      .update(prevHash + timestamp + eventType + actionId + payloadString)
      .digest('hex');
  }

  async appendBlock({ eventType, actionId, actorId, authorizationLevel, payload, verificationStatus = 'RECORDED' }) {
    const timestamp = new Date().toISOString();
    const previousBlock = this.blocks[this.blocks.length - 1];
    const prevHash = previousBlock ? previousBlock.entryHash : 'GENESIS_BLOCK_00000000000000000';

    const entryHash = this.computeBlockHash({
      prevHash,
      timestamp,
      eventType,
      actionId,
      payload
    });

    const block = {
      sequenceNumber: this.blocks.length + 1,
      timestamp,
      eventType,
      actionId,
      actorId,
      authorizationLevel,
      payload,
      verificationStatus,
      prevHash,
      entryHash
    };

    this.blocks.push(block);
    this.save();
    return block;
  }

  async getBlocks(limit = 50) {
    return this.blocks.slice(-limit).reverse();
  }

  /**
   * Cryptographically validates every block in the chain from genesis to head
   */
  async verifyLedgerIntegrity() {
    if (this.blocks.length === 0) {
      return { valid: true, blockCount: 0 };
    }

    for (let i = 0; i < this.blocks.length; i++) {
      const current = this.blocks[i];
      const expectedPrevHash = (i === 0) ? 'GENESIS_BLOCK_00000000000000000' : this.blocks[i - 1].entryHash;

      // 1. Verify sequence order
      if (current.sequenceNumber !== i + 1) {
        return {
          valid: false,
          error: `Sequence violation at block index ${i}: expected #${i + 1}, got #${current.sequenceNumber}`,
          blockIndex: i
        };
      }

      // 2. Verify previous hash chaining
      if (current.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          error: `Chain broken at block #${current.sequenceNumber}: prevHash mismatch. Expected ${expectedPrevHash}, found ${current.prevHash}`,
          blockIndex: i
        };
      }

      // 3. Recompute and verify block hash
      const computedHash = this.computeBlockHash({
        prevHash: current.prevHash,
        timestamp: current.timestamp,
        eventType: current.eventType,
        actionId: current.actionId,
        payload: current.payload
      });

      if (computedHash !== current.entryHash) {
        return {
          valid: false,
          error: `Tampering detected at block #${current.sequenceNumber}: hash mismatch. Computed ${computedHash}, stored ${current.entryHash}`,
          blockIndex: i
        };
      }
    }

    return { valid: true, blockCount: this.blocks.length };
  }
}

// -------------------------------------------------------------
// 7. MEMORY REPOSITORY (Episodic Logs, Preferences, Query Search)
// -------------------------------------------------------------
export class FileMemoryRepository extends MemoryRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'memories.json');
    this.data = readJsonSafe(this.file, {
      episodic: [],
      preferences: [],
      outcomes: []
    });
  }

  save() {
    atomicWrite(this.file, this.data);
  }

  async appendEpisodic({ interactionType, entityIds = [], summary, verbatimSnippet = null, provenanceSource = 'SYSTEM' }) {
    const rawContent = (summary || '') + (verbatimSnippet || '');
    const entry = {
      id: `ep-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      interactionType,
      entityIds,
      summary,
      verbatimSnippet,
      provenanceHash: crypto.createHash('sha256').update(rawContent).digest('hex'),
      provenanceSource
    };
    this.data.episodic.unshift(entry);
    this.save();
    return entry;
  }

  async queryEpisodic({ entityId, textQuery, limit = 10 } = {}) {
    let results = this.data.episodic;
    if (entityId) {
      results = results.filter(e => e.entityIds.includes(entityId));
    }
    if (textQuery) {
      const terms = textQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      // Generate stems (first 5 chars or full word)
      const stems = terms.map(t => t.length > 5 ? t.slice(0, 5) : t);
      results = results.filter(e => {
        const text = `${e.summary || ''} ${e.verbatimSnippet || ''}`.toLowerCase();
        return stems.some(stem => text.includes(stem)) || terms.some(t => text.includes(t));
      });
    }
    return results.slice(0, limit);
  }

  async savePreference(pref) {
    const existingIdx = this.data.preferences.findIndex(p => p.id === pref.id);
    if (existingIdx >= 0) {
      this.data.preferences[existingIdx] = { ...this.data.preferences[existingIdx], ...pref };
    } else {
      this.data.preferences.push(pref);
    }
    this.save();
    return pref;
  }

  async getPreferences(domain) {
    if (!domain) return this.data.preferences;
    return this.data.preferences.filter(p => p.domain === domain);
  }

  async getAllPreferences() {
    return this.data.preferences;
  }

  async recordOutcome(outcome) {
    const entry = {
      id: `out-${crypto.randomUUID()}`,
      recordedAt: new Date().toISOString(),
      ...outcome
    };
    this.data.outcomes.unshift(entry);
    this.save();
    return entry;
  }

  async getOutcomesForAction(actionId) {
    return this.data.outcomes.filter(o => o.actionId === actionId);
  }
}
