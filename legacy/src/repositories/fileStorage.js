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

// Overridable so tests never touch the project's data/ directory.
const DATA_DIR = path.resolve(process.env.WENDY_DATA_DIR || 'data');

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

// Missing file => default. Unreadable/corrupt file => throw (fail closed): silently
// starting from an empty store would lose idempotency records and approvals.
function readJsonSafe(filepath, defaultValue) {
  if (!fs.existsSync(filepath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (err) {
    throw new Error(`Corrupt state file ${filepath}: ${err.message}`);
  }
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

const TERMINAL = [];
export const ALLOWED_TRANSITIONS = {
  PROPOSED: ['STAGED', 'AWAITING_APPROVAL', 'CANCELLED', 'EXPIRED'],
  STAGED: ['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'EXPIRED'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['EXECUTED', 'FAILED'],
  EXECUTED: ['VERIFIED', 'FAILED'],
  VERIFIED: TERMINAL,
  REJECTED: TERMINAL,
  FAILED: TERMINAL,
  CANCELLED: TERMINAL,
  EXPIRED: TERMINAL
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
    if (existing && action.state && existing.state !== action.state) {
      throw new Error(`saveAction cannot change state of ${action.actionId}; use updateActionState`);
    }
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
    const allowed = ALLOWED_TRANSITIONS[action.state] || [];
    if (action.state !== state && !allowed.includes(state)) {
      throw new Error(`Illegal action transition ${action.state} -> ${state} for ${actionId}`);
    }

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
    if (existing && existing.status === 'IN_PROGRESS') {
      // A previous attempt started and never recorded an outcome (crash/restart).
      // The external effect may or may not have happened: refuse to re-run blindly.
      return { alreadyCompleted: false, inDoubt: true, record: existing };
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
    return { alreadyCompleted: false, inDoubt: false, record };
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
// 6. AUDIT REPOSITORY (Hash-chained ledger, FAIL CLOSED)
// -------------------------------------------------------------
const GENESIS_HASH = 'GENESIS';

// Deterministic JSON: object keys sorted recursively, so the hash covers every field unambiguously.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export class FileAuditRepository extends AuditRepository {
  constructor() {
    super();
    this.file = path.join(DATA_DIR, 'audit_ledger.json');
    this.headFile = path.join(DATA_DIR, 'audit_head.json');
    this.loadError = null;
    this.blocks = [];
    this.head = null;
    try {
      if (fs.existsSync(this.file)) this.blocks = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (fs.existsSync(this.headFile)) this.head = JSON.parse(fs.readFileSync(this.headFile, 'utf-8'));
      if (!Array.isArray(this.blocks)) throw new Error('ledger file is not an array');
    } catch (err) {
      // Never fall back to an empty ledger: remember the failure and refuse to verify.
      this.loadError = `Ledger unreadable: ${err.message}`;
      this.blocks = [];
    }
  }

  save() {
    atomicWrite(this.file, this.blocks);
    const last = this.blocks[this.blocks.length - 1];
    this.head = { sequenceNumber: last.sequenceNumber, entryHash: last.entryHash };
    atomicWrite(this.headFile, this.head);
  }

  computeBlockHash(block) {
    const { entryHash, ...hashed } = block;
    return crypto.createHash('sha256').update(canonicalJson(hashed)).digest('hex');
  }

  async appendBlock({ eventType, actionId, actorId, authorizationLevel, payload, verificationStatus = 'RECORDED' }) {
    const integrity = await this.verifyLedgerIntegrity();
    if (!integrity.valid) throw new Error(`Refusing to append to compromised ledger: ${integrity.error}`);

    const previousBlock = this.blocks[this.blocks.length - 1];
    const block = {
      sequenceNumber: this.blocks.length + 1,
      timestamp: new Date().toISOString(),
      eventType,
      actionId,
      actorId,
      authorizationLevel,
      payload,
      verificationStatus,
      prevHash: previousBlock ? previousBlock.entryHash : GENESIS_HASH
    };
    block.entryHash = this.computeBlockHash(block);

    this.blocks.push(block);
    this.save();
    return block;
  }

  async getBlocks(limit = 50) {
    return this.blocks.slice(-limit).reverse();
  }

  /**
   * Verifies every block from genesis to head. Detects altered fields/hash/prevHash,
   * removed, duplicated or reordered blocks, truncation (via the head anchor) and
   * unreadable files. Any failure returns valid:false — callers must fail closed.
   */
  async verifyLedgerIntegrity() {
    if (this.loadError) return { valid: false, error: this.loadError };

    if (this.blocks.length === 0) {
      if (this.head) return { valid: false, error: `Ledger empty but head anchor records block #${this.head.sequenceNumber}` };
      return { valid: true, blockCount: 0 };
    }

    for (let i = 0; i < this.blocks.length; i++) {
      const current = this.blocks[i];
      const expectedPrevHash = i === 0 ? GENESIS_HASH : this.blocks[i - 1].entryHash;
      if (current.sequenceNumber !== i + 1) {
        return { valid: false, error: `Sequence violation at index ${i}: expected #${i + 1}, got #${current.sequenceNumber}`, blockIndex: i };
      }
      if (current.prevHash !== expectedPrevHash) {
        return { valid: false, error: `Chain broken at block #${current.sequenceNumber}: prevHash mismatch`, blockIndex: i };
      }
      if (this.computeBlockHash(current) !== current.entryHash) {
        return { valid: false, error: `Tampering detected at block #${current.sequenceNumber}: hash mismatch`, blockIndex: i };
      }
    }

    const last = this.blocks[this.blocks.length - 1];
    if (!this.head) return { valid: false, error: 'Head anchor missing for non-empty ledger' };
    if (this.head.sequenceNumber !== last.sequenceNumber || this.head.entryHash !== last.entryHash) {
      return { valid: false, error: `Head anchor mismatch: anchor #${this.head.sequenceNumber}, ledger ends at #${last.sequenceNumber} (truncation or rewrite)` };
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

  async appendEpisodic({ interactionType, entityIds = [], summary, verbatimSnippet = null, provenanceSource = 'SYSTEM', sourceEventId = null }) {
    const rawContent = (summary || '') + (verbatimSnippet || '');
    const entry = {
      id: `ep-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      interactionType,
      entityIds,
      summary,
      verbatimSnippet,
      provenanceHash: crypto.createHash('sha256').update(rawContent).digest('hex'),
      provenanceSource,
      sourceEventId
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
