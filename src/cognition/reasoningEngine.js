import { EpistemicState, AuthorizationLevel } from '../types/domain.js';
import { ContextRetriever } from './contextRetriever.js';
import { globalAttentionFilter } from './attentionFilter.js';

/**
 * WENDY EXECUTIVE INTELLIGENCE CORE
 * Performs continuous awareness evaluation, salience ranking, action staging, and epistemic dialogue.
 */
export class ReasoningEngine {
  constructor(memoryStore, eventBus) {
    this.memory = memoryStore;
    this.events = eventBus;
    this.retriever = new ContextRetriever(memoryStore);
    this.stagedActions = {};
    this.initializeStagedActions();
  }

  initializeStagedActions() {
    // Action 1: Level 3 External Email (Mariana's Birthday)
    const action1Id = 'act-mariana-birthday';
    this.stagedActions[action1Id] = {
      actionId: action1Id,
      actionType: 'SEND_EMAIL',
      authorizationLevel: AuthorizationLevel.LEVEL_3_EXTERNAL_MUTATION,
      status: 'AWAITING_APPROVAL',
      targetEntity: {
        id: 'person-mariana',
        name: 'Mariana Vance',
        title: 'Managing Director & Founder',
        organization: 'Apex Bio',
        tier: 1
      },
      headline: 'Send Birthday Greeting to Mariana Vance (Tier 1)',
      justification: [
        'Birthday is tomorrow (Fact: Verified in Contact profile)',
        'Crucial European alliance partner (Fact: Tier 1 Closeness 0.88)',
        'Sent personal message last year acknowledging expansion (Fact: Episodic log)',
        'Calibrated in executive voice: Direct, personal, warm, unhurried (Rule: Preference #1)'
      ],
      preview: {
        recipient: 'mariana@apexbio.com',
        scheduledFor: 'Tomorrow at 08:30 (BST)',
        subject: 'Happy Birthday, Mariana',
        body: `Mariana,

Wishing you a wonderful birthday tomorrow. 

I was reflecting on our discussion last month regarding the European market expansion—the pace of execution at Apex continues to impress me. I hope you take time away from the pipeline to celebrate with family.

Warmly,
João`
      },
      consequences: {
        reversibility: 'IRREVERSIBLE ON SEND',
        impact: 'Reinforces critical European strategic alliance; zero commercial push.'
      },
      epistemicState: EpistemicState.RECOMMENDATION
    };

    // Action 2: Level 1 Preparation Dossier (Carlos Meeting)
    const action2Id = 'act-carlos-prep';
    this.stagedActions[action2Id] = {
      actionId: action2Id,
      actionType: 'PREPARE_BRIEFING',
      authorizationLevel: AuthorizationLevel.LEVEL_1_PREPARE,
      status: 'APPROVED', // Autonomous execution for Level 1
      targetEntity: {
        id: 'person-carlos',
        name: 'Carlos Drummond',
        title: 'General Partner',
        organization: 'Horizon Capital',
        tier: 1
      },
      headline: 'Pre-Meeting Briefing & Pricing Sensitivity Dossier',
      justification: [
        'Meeting scheduled for 14:00 today (Fact: Google Calendar)',
        'Carlos emailed last night at 23:42 citing pricing anxiety in Clause 4 (Fact: Gmail)',
        'Horizon Investment Committee meets Thursday (Fact: Past meeting transcript)',
        'Reciprocity: João committed 14 days ago to revisit pricing structure (Fact: Episodic log)'
      ],
      preview: {
        keyTakeaways: [
          'Carlos is supportive overall, but needs defensible pricing terms for his Thursday committee.',
          'The core sticking point is the tier-2 escalation cap in Clause 4.',
          'Recommended stance: Offer a 3% volume rebate in exchange for a 24-month term lock.'
        ],
        pulledDocuments: [
          'Horizon_Partnership_Agreement_v3_draft.pdf',
          'Pricing_Sensitivity_Matrix_Q4.xlsx'
        ]
      },
      consequences: {
        reversibility: 'INTERNAL ONLY (ZERO EXTERNAL SIDE EFFECTS)',
        impact: 'Arms executive with exact counter-proposals before 14:00 call.'
      },
      epistemicState: EpistemicState.RECOMMENDATION
    };
  }

  /**
   * Generates the Comprehensive Morning Dossier ("The First Wow Moment")
   */
  generateExecutiveDossier() {
    const carlosContext = this.retriever.retrieveMeetingDossier('person-carlos');
    const marianaContext = this.retriever.retrieveMilestoneContext('person-mariana');
    const commitments = this.retriever.retrievePendingCommitments();

    return {
      overview: {
        greeting: "Good morning João.",
        narrativeHeadline: "I found four things worth your attention before your first call.",
        preparedActionsCount: Object.values(this.stagedActions).filter(a => a.status === 'AWAITING_APPROVAL').length
      },
      quadrants: {
        urgent: {
          category: 'URGENT',
          title: 'Meeting with Carlos Drummond (14:00)',
          entity: 'Carlos Drummond • General Partner, Horizon Capital (Tier 1)',
          timeHorizon: 'In 5.5 hours',
          salienceScore: 0.94,
          epistemicState: EpistemicState.FACT,
          narrative: 'You have a strategic meeting with Carlos at 14:00. He replied last night at 23:42 with a specific concern regarding Clause 4 pricing. I have pulled the relevant email thread, previous dinner commitments, and the latest proposal with counter-terms ready.',
          evidence: [
            'Calendar Event: 14:00 "Strategic Partnership & Pricing Review"',
            'Email: Sent by carlos@horizoncap.com at 23:42 yesterday',
            'Commitment: Dinner note 14 days ago stating pricing would be revisited'
          ],
          stagedActionId: 'act-carlos-prep'
        },
        relationship: {
          category: 'RELATIONSHIP',
          title: "Mariana Vance's Birthday Tomorrow",
          entity: 'Mariana Vance • Managing Director, Apex Bio (Tier 1)',
          timeHorizon: 'Tomorrow (BST)',
          salienceScore: 0.88,
          epistemicState: EpistemicState.FACT,
          narrative: "Tomorrow is Mariana's birthday. She is one of your most important European relationships. Last year you sent her a personal message acknowledging her expansion, which generated deep goodwill. I've prepared a new message matching your customary tone.",
          evidence: [
            'Verified birthdate in relationship record',
            'Episodic log: Sent note on same date last year',
            'Tone preference: Direct, warm, no corporate clichés'
          ],
          stagedActionId: 'act-mariana-birthday'
        },
        commitment: {
          category: 'COMMITMENT',
          title: 'Revised Financial Numbers Promised by Today',
          entity: 'Commitment to Carlos & Mariana',
          timeHorizon: 'Due Today (17:00)',
          salienceScore: 0.82,
          epistemicState: EpistemicState.FACT,
          narrative: "You promised Carlos on Tuesday that you would provide the revised valuation sensitivities by today. I don't see the document sent yet. The latest draft is in Drive (Pricing_Sensitivity_Matrix_Q4.xlsx). Would you like me to prepare the final transmittal note?",
          evidence: [
            'Tuesday commitment log in episodic memory',
            'Unsent file: Pricing_Sensitivity_Matrix_Q4.xlsx modified yesterday at 18:20'
          ],
          stagedActionId: null
        },
        canWait: {
          category: 'CAN_WAIT',
          title: 'Q4 Tool Evaluation Sync Conflict (Next Wednesday)',
          entity: 'Vendor Sync Request',
          timeHorizon: 'Next week',
          salienceScore: 0.38,
          epistemicState: EpistemicState.INFERENCE,
          narrative: 'There is a minor scheduling overlap next Wednesday between a vendor pitch and internal sprint review. This has low strategic impact and can wait until your weekly review on Friday.',
          evidence: [
            'Vendor tier: Tier 4 (Non-critical)',
            'No executive commitments bound to this event'
          ],
          stagedActionId: null
        }
      },
      stagedActions: this.stagedActions
    };
  }

  /**
   * Responds to an executive query with quad-state rigor
   */
  processExecutiveQuery(query) {
    const q = query.toLowerCase();

    if (q.includes('carlos') && (q.includes('why') || q.includes('important'))) {
      const person = this.memory.getPerson('person-carlos');
      const rel = this.memory.getRelationship('person-exec-joao', 'person-carlos');
      return {
        reply: `Carlos Drummond is categorized as **Tier 1 (High Strategic Value)** based on three concrete factors:
1. **[FACT] Co-Investor & Board Partner:** Carlos is General Partner at Horizon Capital and co-sits on two mutual portfolio company boards.
2. **[FACT] Imminent Board Deadline:** His investment committee meets this Thursday to vote on the partnership.
3. **[FACT] Outstanding Executive Commitment:** You committed 14 days ago to deliver revised Clause 4 pricing terms.
4. **[RECOMMENDATION]:** Arrive at 14:00 with the 3% volume rebate concession pre-cleared, rather than negotiating from scratch.`,
        epistemicBreakdown: [
          { type: EpistemicState.FACT, text: 'Co-investor at Horizon Capital and board partner on 2 mutual assets.' },
          { type: EpistemicState.FACT, text: 'Email at 23:42 yesterday confirming Thursday committee deadline.' },
          { type: EpistemicState.RECOMMENDATION, text: 'Offer 3% volume rebate in exchange for 24-month term lock.' }
        ]
      };
    }

    if (q.includes('mariana') || q.includes('birthday')) {
      return {
        reply: `Mariana Vance is Managing Director at Apex Bio (Tier 1 relationship). 
- **[FACT]**: Her birthday is tomorrow.
- **[FACT]**: You sent her a personal email on her birthday last year reflecting on her European expansion, which she warmly acknowledged.
- **[RECOMMENDATION]**: Send the prepared greeting tomorrow morning at 08:30 London time. You can review and authorize the draft directly in the Staging Drawer.`,
        epistemicBreakdown: [
          { type: EpistemicState.FACT, text: 'Birthday verified for tomorrow.' },
          { type: EpistemicState.FACT, text: 'Positive historical response to birthday greeting in episodic log.' },
          { type: EpistemicState.RECOMMENDATION, text: 'Authorize Level 3 email dispatch in Zone C.' }
        ]
      };
    }

    if (q.includes('commit') || q.includes('promise') || q.includes('owe')) {
      return {
        reply: `You have **one pending commitment due today**:
- **[FACT] Deliverable**: Send revised valuation sensitivities and pricing model.
- **[FACT] Promisee**: Carlos Drummond (Horizon Capital).
- **[FACT] Deadline**: Today by 17:00 (promised Tuesday).
- **[INFERENCE]**: Carlos's late-night email indicates this is the primary bottleneck for Thursday's board decision.
- **[RECOMMENDATION]**: Review the draft in Drive before your 14:00 meeting so you can walk him through it live.`,
        epistemicBreakdown: [
          { type: EpistemicState.FACT, text: 'Commitment recorded on Tuesday due today at 17:00.' },
          { type: EpistemicState.INFERENCE, text: 'Pricing sensitivity is the primary obstacle to contract sign-off.' }
        ]
      };
    }

    // Default executive response
    return {
      reply: `I have processed your query against your current active relationships, commitments, and calendar. The two highest-salience priorities right now remain the 14:00 pricing session with Carlos and Mariana's birthday dispatch staged for tomorrow morning. Would you like me to adjust either action?`,
      epistemicBreakdown: [
        { type: EpistemicState.RECOMMENDATION, text: 'Focus on 14:00 Carlos prep and Mariana birthday authorization.' }
      ]
    };
  }
}
