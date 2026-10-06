import crypto from 'node:crypto';
import { ActionState } from '../repositories/fileStorage.js';

/**
 * ACTION ADAPTERS
 *
 * No email provider is connected in this prototype. Dispatch therefore does NOT
 * send anything and never reports delivery, verification, or "sent" memories.
 * The idempotency key is derived from the action identity (not its content), so
 * editing a draft can never produce a second dispatch for the same action.
 */
export class ActionAdapters {
  constructor({ idempotencyRepo, auditRepo, memoryRepo, actionRepo, emailProvider = null }) {
    this.idempotencyRepo = idempotencyRepo;
    this.auditRepo = auditRepo;
    this.memoryRepo = memoryRepo;
    this.actionRepo = actionRepo;
    this.emailProvider = emailProvider;
  }

  static idempotencyKeyFor(actionId) {
    return `idem-dispatch-${actionId}`;
  }

  async dispatchEmail({ actionId, recipient, subject, bodyText, actorId }) {
    const idempotencyKey = ActionAdapters.idempotencyKeyFor(actionId);
    const requestHash = crypto.createHash('sha256').update(`${recipient}\n${subject}\n${bodyText}`).digest('hex');

    const attempt = await this.idempotencyRepo.recordAttempt(idempotencyKey, actionId, 'DISPATCH_EMAIL', requestHash);
    if (attempt.alreadyCompleted) {
      return { status: 'ALREADY_COMPLETED_IDEMPOTENT', idempotencyKey, result: attempt.record.result };
    }
    if (attempt.inDoubt) {
      return { status: 'IN_DOUBT_REQUIRES_RECONCILIATION', idempotencyKey, result: null };
    }

    if (!this.emailProvider) {
      const result = {
        executed: false,
        reason: 'NO_EMAIL_PROVIDER_CONNECTED',
        detail: 'Nothing was sent. This prototype has no email provider.'
      };
      await this.idempotencyRepo.failAttempt(idempotencyKey, result.reason);
      await this.auditRepo.appendBlock({
        eventType: 'ACTION_NOT_EXECUTED',
        actionId,
        actorId: actorId || 'unknown',
        authorizationLevel: 3,
        payload: { recipient, subject, requestHash, reason: result.reason },
        verificationStatus: 'NOT_EXECUTED'
      });
      await this.memoryRepo.recordOutcome({
        actionId,
        actionType: 'SEND_EMAIL',
        decision: 'APPROVED',
        wasSuccessful: false,
        verificationDetails: result
      });
      return { status: 'NOT_EXECUTED', idempotencyKey, result };
    }

    throw new Error('Real email providers are not supported by the legacy prototype adapter');
  }
}

export { ActionState };
