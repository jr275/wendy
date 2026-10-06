import crypto from 'node:crypto';
import { EntityResolver } from './entityResolver.js';
import { ContextRetriever } from './contextRetriever.js';
import { SalienceEngine } from './salienceEngine.js';
import { AnticipationEngine } from './anticipationEngine.js';

/**
 * THE COMPLETE REAL COGNITIVE PIPELINE
 * End-to-end autonomous event loop executing:
 * Signal -> Ingestion -> Normalization -> Persistence -> Entity Resolution ->
 * Context Retrieval -> Reasoning -> Salience -> Anticipation -> Action Staging.
 */
export class CognitivePipeline {
  constructor({
    eventRepo,
    entityRepo,
    relationshipRepo,
    memoryRepo,
    actionRepo,
    eventBus,
    principalId = process.env.WENDY_PRINCIPAL_ID || 'person-exec-joao'
  }) {
    this.eventRepo = eventRepo;
    this.entityRepo = entityRepo;
    this.relationshipRepo = relationshipRepo;
    this.memoryRepo = memoryRepo;
    this.actionRepo = actionRepo;
    this.eventBus = eventBus;

    this.entityResolver = new EntityResolver(entityRepo, relationshipRepo, principalId);
    this.contextRetriever = new ContextRetriever({ entityRepo, relationshipRepo, memoryRepo });
    this.salienceEngine = new SalienceEngine();
    this.anticipationEngine = new AnticipationEngine(actionRepo);

    // Subscribe to EventBus
    if (this.eventBus) {
      this.eventBus.on('event', (rawEvent) => {
        this.processEvent(rawEvent).catch(err => {
          console.error('[COGNITIVE PIPELINE ERROR]:', err);
        });
      });
    }
  }

  /**
   * Main entry point: Processes any standardized or raw event envelope
   */
  async processEvent(incomingEvent) {
    // 1. NORMALIZE EVENT ENVELOPE
    const event = this.normalizeEnvelope(incomingEvent);

    // 2. PERSIST EVENT (Append to durable ledger, check duplicate)
    const isDuplicate = await this.eventRepo.hasEvent(event.eventId);
    if (isDuplicate) {
      // Already processed: never repeat its side effects (memory writes, actions, insights).
      return { eventId: event.eventId, duplicate: true };
    }
    await this.eventRepo.saveEvent(event);

    // 3. IDENTIFY ENTITIES (Entity Resolution)
    const resolvedEntities = await this.entityResolver.resolveEntities(event);

    // 4. RETRIEVE CONTEXT & MEMORY
    const context = await this.contextRetriever.retrieveContext({
      event,
      resolvedEntities
    });

    // 5. CALCULATE SALIENCE & ATTENTION FILTER
    const salienceResult = this.salienceEngine.evaluate({
      event,
      resolvedEntities,
      context
    });

    // 6. ANTICIPATION & EPISTEMIC REASONING (Fact / Inference / Recommendation)
    const anticipationResult = await this.anticipationEngine.process({
      event,
      resolvedEntities,
      context,
      salienceResult
    });

    // 7. PERSIST OBSERVATION TO EPISODIC MEMORY
    if (resolvedEntities.primaryPerson) {
      await this.memoryRepo.appendEpisodic({
        interactionType: event.eventType,
        entityIds: resolvedEntities.allEntityIds,
        summary: anticipationResult.epistemicQuad.observation.statement,
        verbatimSnippet: event.payload?.body || event.payload?.text || null,
        sourceEventId: event.eventId,
        provenanceSource: event.provenance?.sourceSystem || 'EVENT_PIPELINE'
      });
    }

    const output = {
      eventId: event.eventId,
      eventType: event.eventType,
      primaryPerson: resolvedEntities.primaryPerson?.fullName || null,
      salience: salienceResult.salience,
      category: salienceResult.category,
      explanation: salienceResult.explanation,
      epistemicQuad: anticipationResult.epistemicQuad,
      duplicate: false,
      stagedAction: anticipationResult.stagedAction,
      processedAt: new Date().toISOString()
    };

    // Emit insight if event bus exists
    if (this.eventBus) {
      this.eventBus.emit('PROACTIVE_INSIGHT_GENERATED', output);
    }

    return output;
  }

  normalizeEnvelope(raw) {
    const now = new Date().toISOString();
    const eventId = raw.eventId || `evt-${crypto.randomUUID()}`;
    const payload = raw.payload || {};
    const rawPayloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    return {
      eventId,
      eventType: raw.eventType || 'EXTERNAL_SIGNAL',
      source: raw.source || raw.provenance?.sourceSystem || 'SENSORY_BUS',
      occurred_at: raw.occurred_at || raw.timestamp || now,
      received_at: now,
      actor: raw.actor || { id: 'unknown', type: 'EXTERNAL', identifier: payload.from || 'system' },
      primaryEntity: raw.primaryEntity || { entityType: 'Signal', entityId: 'generic' },
      secondaryEntityIds: raw.secondaryEntityIds || [],
      payload,
      confidenceScore: raw.confidenceScore !== undefined ? raw.confidenceScore : 1.0,
      provenance: {
        sourceSystem: raw.source || 'SENSORY_BUS',
        rawPayloadHash,
        sourceType: raw.provenance?.sourceType || 'UNLABELED'
      },
      correlationId: raw.correlationId || `corr-${crypto.randomUUID()}`,
      permissions: raw.permissions || { accessScope: 'EXECUTIVE_PRIVATE' }
    };
  }
}
