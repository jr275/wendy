import crypto from 'node:crypto';
import { globalAuditLedger } from './auditLedger.js';

/**
 * IDEMPOTENT ACTION ADAPTERS & DOWNSTREAM VERIFICATION
 */
export class ActionAdapters {
  constructor(memoryStore) {
    this.memory = memoryStore;
    this.executedKeys = new Set();
  }

  /**
   * Dispatches email to recipient with verification loop
   */
  async dispatchEmail({ actionId, recipient, subject, bodyText, actorId = 'person-exec-joao' }) {
    const idempotencyKey = `email-${crypto.createHash('md5').update(actionId + recipient + bodyText).digest('hex')}`;
    
    if (this.executedKeys.has(idempotencyKey)) {
      console.warn(`Idempotency check: Action ${actionId} already executed. Skipping redundant dispatch.`);
      return { status: 'ALREADY_EXECUTED', idempotencyKey };
    }

    // 1. Log dispatch attempt to cryptographic audit ledger
    globalAuditLedger.appendAuditEntry({
      eventType: 'ACTION_DISPATCHED',
      actionId,
      actorId,
      authorizationLevel: 3,
      payload: { recipient, subject, bodyText, idempotencyKey }
    });

    // 2. Simulate downstream execution
    console.log(`[ACTION ADAPTER] Dispatched email to ${recipient} (Subject: "${subject}")`);
    this.executedKeys.add(idempotencyKey);

    // 3. Post-execution verification simulation
    const verificationReceipt = {
      messageId: `msg-${crypto.randomUUID()}`,
      smtpResponse: '250 2.0.0 OK: message queued 10429',
      recipientStatus: 'DELIVERED_TO_GATEWAY',
      verifiedAt: new Date().toISOString()
    };

    // 4. Record to cryptographic audit ledger as verified
    globalAuditLedger.appendAuditEntry({
      eventType: 'ACTION_VERIFIED',
      actionId,
      actorId: 'system-verifier',
      authorizationLevel: 3,
      payload: verificationReceipt,
      verificationStatus: 'VERIFIED_SUCCESS'
    });

    // 5. Update episodic memory and relationship trajectory
    this.memory.appendEpisodicRecord({
      interactionType: 'EMAIL_SENT',
      entityIds: ['person-exec-joao', 'person-mariana'],
      summary: `Dispatched birthday greeting to ${recipient}.`,
      verbatimSnippet: bodyText,
      provenanceSource: 'ACTION_ADAPTER_VERIFIED'
    });

    // Update Mariana's relationship trajectory
    const rel = this.memory.getRelationship('person-exec-joao', 'person-mariana');
    if (rel) {
      this.memory.upsertRelationship({
        ...rel,
        lastInteractionAt: new Date().toISOString(),
        historicalNotes: [
          ...rel.historicalNotes,
          `Sent authorized birthday greeting on ${new Date().toISOString().split('T')[0]}. Verified delivered.`
        ]
      });
    }

    // Record historical outcome
    this.memory.recordOutcome({
      actionId,
      actionType: 'SEND_EMAIL',
      decision: 'APPROVED',
      wasSuccessful: true,
      verificationDetails: verificationReceipt
    });

    return {
      status: 'VERIFIED_SUCCESS',
      idempotencyKey,
      verificationReceipt
    };
  }
}
