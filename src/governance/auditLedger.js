import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const AUDIT_FILE = path.join(DATA_DIR, 'wendy_audit_ledger.json');

/**
 * IMMUTABLE CRYPTOGRAPHIC AUDIT LEDGER
 * Every action, approval, denial, and downstream tool execution is recorded here.
 */
export class AuditLedger {
  constructor() {
    this.ensureDataDirectory();
    this.entries = this.loadFromDisk();
  }

  ensureDataDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(AUDIT_FILE)) {
        return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8'));
      }
    } catch (err) {
      console.warn('Audit file empty or corrupted, initializing fresh ledger');
    }
    return [];
  }

  saveToDisk() {
    try {
      fs.writeFileSync(AUDIT_FILE, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write audit ledger:', err);
    }
  }

  appendAuditEntry({
    eventType,
    actionId,
    actorId,
    authorizationLevel,
    payload,
    verificationStatus = 'PENDING'
  }) {
    const timestamp = new Date().toISOString();
    const previousEntry = this.entries[this.entries.length - 1];
    const prevHash = previousEntry ? previousEntry.entryHash : 'GENESIS_BLOCK_00000000000000000';

    const payloadString = JSON.stringify(payload);
    const entryHash = crypto.createHash('sha256')
      .update(prevHash + timestamp + eventType + actionId + payloadString)
      .digest('hex');

    const entry = {
      sequenceNumber: this.entries.length + 1,
      timestamp,
      eventType, // e.g. ACTION_APPROVED, ACTION_DISPATCHED, ACTION_VERIFIED
      actionId,
      actorId,
      authorizationLevel,
      payload,
      verificationStatus,
      prevHash,
      entryHash
    };

    this.entries.push(entry);
    this.saveToDisk();
    return entry;
  }

  getEntries(limit = 20) {
    return this.entries.slice(-limit).reverse();
  }
}

export const globalAuditLedger = new AuditLedger();
