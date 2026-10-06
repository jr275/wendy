import { RetrievalEngine } from './retrievalEngine.js';
import { ActionState } from '../repositories/fileStorage.js';

/**
 * LEGACY PROTOTYPE REASONING ENGINE
 *
 * The hardcoded four-quadrant dossier (fixed titles, times, scores and narratives)
 * was removed. The dossier now only reports persisted staged actions; derived
 * quadrants are NOT_IMPLEMENTED in this prototype.
 */
export class ReasoningEngine {
  constructor({ entityRepo, relationshipRepo, eventRepo, actionRepo, memoryRepo, principalId }) {
    this.actionRepo = actionRepo;
    this.retrievalEngine = new RetrievalEngine({ entityRepo, relationshipRepo, memoryRepo, actionRepo, principalId });
  }

  async generateExecutiveDossier() {
    const allActions = await this.actionRepo.listActions({ limit: 50 });
    const pending = allActions.filter(a => a.state === ActionState.AWAITING_APPROVAL || a.state === ActionState.PROPOSED);
    return {
      status: 'NOT_IMPLEMENTED',
      note: 'Dossier quadrants are not derived by the legacy prototype.',
      quadrants: null,
      preparedActionsCount: pending.length,
      stagedActions: Object.fromEntries(allActions.map(a => [a.actionId, a]))
    };
  }

  async processExecutiveQuery(query) {
    return await this.retrievalEngine.answerQuery(query);
  }
}
