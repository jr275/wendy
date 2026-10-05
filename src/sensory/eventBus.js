import crypto from 'node:crypto';
import EventEmitter from 'node:events';

/**
 * Reactive Event Bus and Ingestion Normalizer for Wendy
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.ledger = [];
  }

  /**
   * Normalizes raw signals into standard WendyEventEnvelope
   */
  publishEvent({
    eventType,
    actor,
    primaryEntity,
    secondaryEntityIds = [],
    importanceScore = 0.5,
    confidenceScore = 1.0,
    epistemicCategory = 'FACT',
    sourceSystem = 'INTERNAL',
    payload = {}
  }) {
    const rawString = JSON.stringify(payload);
    const envelope = {
      eventId: `evt-${crypto.randomUUID()}`,
      correlationId: `corr-${crypto.randomUUID()}`,
      eventType,
      timestamp: new Date().toISOString(),
      actor: actor || { id: 'system', type: 'SYSTEM_CRON', identifier: 'wendy-daemon' },
      primaryEntity,
      secondaryEntityIds,
      importanceScore,
      confidenceScore,
      epistemicCategory,
      provenance: {
        sourceSystem,
        rawPayloadHash: crypto.createHash('sha256').update(rawString).digest('hex')
      },
      payload
    };

    this.ledger.push(envelope);
    this.emit('event', envelope);
    this.emit(eventType, envelope);

    return envelope;
  }

  getRecentEvents(limit = 20) {
    return this.ledger.slice(-limit).reverse();
  }
}

export const globalEventBus = new EventBus();
