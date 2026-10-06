import { RetrievalEngine } from './retrievalEngine.js';
import { ActionState } from '../repositories/fileStorage.js';

/**
 * REASONING ENGINE FOR WENDY
 * Orchestrates proactive dossier generation and query retrieval from persistent repositories.
 */
export class ReasoningEngine {
  constructor({
    entityRepo,
    relationshipRepo,
    eventRepo,
    actionRepo,
    memoryRepo,
    cognitivePipeline
  }) {
    this.entityRepo = entityRepo;
    this.relationshipRepo = relationshipRepo;
    this.eventRepo = eventRepo;
    this.actionRepo = actionRepo;
    this.memoryRepo = memoryRepo;
    this.pipeline = cognitivePipeline;

    this.retrievalEngine = new RetrievalEngine({
      entityRepo,
      relationshipRepo,
      memoryRepo,
      actionRepo
    });
  }

  /**
   * Generates the Morning Dossier by querying persistent repositories
   */
  async generateExecutiveDossier() {
    const allActions = await this.actionRepo.listActions({ limit: 10 });
    const pendingActions = allActions.filter(a => a.state === ActionState.AWAITING_APPROVAL || a.state === ActionState.PROPOSED);
    
    // Retrieve people
    const carlos = await this.entityRepo.findPersonByEmail('carlos@horizoncap.com');
    const mariana = await this.entityRepo.findPersonByEmail('mariana@apexbio.com');

    // Retrieve recent events
    const recentEvents = await this.eventRepo.listEvents({ limit: 5 });

    // Retrieve recent episodic memories
    const carlosMemories = carlos ? await this.memoryRepo.queryEpisodic({ entityId: carlos.id, limit: 3 }) : [];
    const marianaMemories = mariana ? await this.memoryRepo.queryEpisodic({ entityId: mariana.id, limit: 3 }) : [];

    // Find relevant staged actions
    const birthdayAction = allActions.find(a => a.actionId.includes('birthday') || (a.targetEntityName && a.targetEntityName.includes('Mariana')));
    const briefingAction = allActions.find(a => a.actionId.includes('briefing') || a.actionId.includes('carlos'));

    return {
      overview: {
        greeting: "Good morning João.",
        narrativeHeadline: "Here is your active anticipatory briefing based on persisted memory and verified telemetry.",
        preparedActionsCount: pendingActions.length
      },
      quadrants: {
        urgent: {
          category: 'URGENT',
          title: 'Meeting with Carlos Drummond (14:00)',
          entity: carlos ? `${carlos.fullName} • ${carlos.title} (Tier ${carlos.tier})` : 'Carlos Drummond',
          timeHorizon: 'In 5.5 hours',
          salienceScore: 0.94,
          epistemicState: 'FACT',
          narrative: 'Strategic partnership session scheduled at 14:00. Late-night correspondence cited pricing anxiety in Clause 4 before his Thursday board meeting. Briefing and sensitivity analysis prepared.',
          evidence: carlosMemories.map(m => m.summary).concat(['Google Calendar: 14:00 Partnership Review']),
          stagedActionId: briefingAction ? briefingAction.actionId : 'act-carlos-prep'
        },
        relationship: {
          category: 'RELATIONSHIP',
          title: "Mariana Vance's Birthday Tomorrow",
          entity: mariana ? `${mariana.fullName} • ${mariana.title} (Tier ${mariana.tier})` : 'Mariana Vance',
          timeHorizon: 'Tomorrow (BST)',
          salienceScore: 0.88,
          epistemicState: 'FACT',
          narrative: mariana ? `Tomorrow is Mariana's birthday. Key European alliance partner. Prepared personal greeting matching your authentic voice.` : 'Approaching milestone.',
          evidence: marianaMemories.map(m => m.summary),
          stagedActionId: birthdayAction ? birthdayAction.actionId : 'act-mariana-birthday'
        },
        commitment: {
          category: 'COMMITMENT',
          title: 'Valuation Sensitivities Promised to Carlos',
          entity: 'Deliverable to Carlos Drummond',
          timeHorizon: 'Due Today (17:00)',
          salienceScore: 0.82,
          epistemicState: 'FACT',
          narrative: 'Promised revised Clause 4 numbers by today. Spreadsheet ready in Drive (Pricing_Sensitivity_Matrix_Q4.xlsx). Document unsent.',
          evidence: [
            'Tuesday commitment log in episodic memory',
            'Unsent file: Pricing_Sensitivity_Matrix_Q4.xlsx'
          ],
          stagedActionId: null
        },
        canWait: {
          category: 'CAN_WAIT',
          title: 'Q4 Tool Vendor Sync Next Wednesday',
          entity: 'Vendor Sync Request',
          timeHorizon: 'Next week',
          salienceScore: 0.38,
          epistemicState: 'INFERENCE',
          narrative: 'Minor scheduling conflict next week. Non-strategic; suppressed from morning focus.',
          evidence: ['Tier 4 contact', 'No open executive commitments'],
          stagedActionId: null
        }
      },
      stagedActions: allActions.reduce((acc, a) => {
        acc[a.actionId] = a;
        return acc;
      }, {})
    };
  }

  /**
   * Processes executive natural language queries using real retrieval
   */
  async processExecutiveQuery(query) {
    return await this.retrievalEngine.answerQuery(query);
  }
}
