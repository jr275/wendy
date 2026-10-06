import crypto from 'node:crypto';

/**
 * LEGACY PROTOTYPE — NO REASONING.
 *
 * The previous version produced interpretations, anticipations, recommendations and
 * staged actions from keyword matches with pre-written sentences. Those were removed.
 * This module now only restates what the event source contains (an observation with
 * its payload hash). Interpretation / anticipation / recommendation are explicitly
 * NOT_IMPLEMENTED here; the real reasoning lives in the TypeScript Cognitive Core.
 */
export class AnticipationEngine {
  constructor(actionRepo) {
    this.actionRepo = actionRepo;
  }

  async process({ event, resolvedEntities, salienceResult }) {
    const payload = event.payload || {};
    const person = resolvedEntities.primaryPerson;
    const contentHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    const observation = {
      type: 'FACT',
      statement: this.deriveObservationStatement(event, person, payload),
      provenance: {
        sourceEventId: event.eventId,
        sourceType: event.source,
        occurredAt: event.occurred_at,
        origin: event.provenance?.sourceType || 'UNLABELED',
        contentHash
      }
    };

    const notImplemented = (type) => ({ type, statement: null, status: 'NOT_IMPLEMENTED' });

    return {
      salience: salienceResult.salience,
      category: salienceResult.category,
      explanation: salienceResult.explanation,
      epistemicQuad: {
        observation,
        interpretation: notImplemented('INFERENCE'),
        anticipation: notImplemented('HYPOTHESIS'),
        recommendation: notImplemented('RECOMMENDATION')
      },
      stagedAction: null
    };
  }

  deriveObservationStatement(event, person, payload) {
    const who = person ? person.fullName : `unresolved sender (${payload.from || event.actor?.identifier || 'unknown'})`;
    const fields = Object.entries(payload)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `${event.eventType} from ${who}: ${fields}`;
  }
}
