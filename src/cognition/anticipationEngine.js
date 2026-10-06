import crypto from 'node:crypto';
import { ActionState } from '../repositories/fileStorage.js';

/**
 * ANTICIPATION & EPISTEMIC REASONING ENGINE
 * Synthesizes Observations (Fact), Interpretations (Inference), Anticipations (Hypothesis), and Recommendations.
 */
export class AnticipationEngine {
  constructor(actionRepo) {
    this.actionRepo = actionRepo;
  }

  /**
   * Processes an evaluated event and synthesizes epistemic insights & staged actions
   */
  async process({ event, resolvedEntities, context, salienceResult }) {
    const payload = event.payload || {};
    const person = resolvedEntities.primaryPerson;
    const personName = person ? person.fullName : 'External Contact';
    const text = `${event.eventType} ${payload.subject || ''} ${payload.body || ''} ${payload.text || ''}`.toLowerCase();

    // 1. OBSERVATION (FACT with real cryptographic provenance)
    const eventPayloadString = JSON.stringify(payload);
    const contentHash = crypto.createHash('sha256').update(eventPayloadString).digest('hex');

    const observation = {
      type: 'FACT',
      statement: this.deriveObservationStatement(event, personName, payload),
      provenance: {
        sourceEventId: event.eventId,
        sourceType: event.provenance?.sourceSystem || event.source || 'EVENT_BUS',
        occurredAt: event.occurred_at || event.timestamp || new Date().toISOString(),
        origin: event.provenance?.sourceType === 'DEVELOPMENT_FIXTURE' ? 'DEVELOPMENT_FIXTURE' : 'LIVE_TELEMETRY',
        contentHash,
        verified: true
      }
    };

    // 2. INTERPRETATION (INFERENCE derived from context)
    const interpretation = {
      type: 'INFERENCE',
      statement: this.deriveInterpretationStatement(event, person, context, text),
      supportingFactHashes: [contentHash]
    };

    // 3. ANTICIPATION (HYPOTHESIS about upcoming need)
    const anticipation = {
      type: 'HYPOTHESIS',
      statement: this.deriveAnticipationStatement(event, person, context, text),
      derivedFromInference: interpretation.statement
    };

    // 4. RECOMMENDATION (ACTIONABLE GUIDANCE)
    const recommendation = {
      type: 'RECOMMENDATION',
      statement: this.deriveRecommendationStatement(event, person, context, text),
      rationale: `${interpretation.statement} Therefore: ${anticipation.statement}`
    };

    // 5. OPTIONAL ACTION STAGING
    let stagedAction = null;
    if (text.includes('birthday') || event.eventType === 'PERSON_EVENT_APPROACHING') {
      stagedAction = await this.stageBirthdayAction(person, event, observation, recommendation);
    } else if (text.includes('pricing') || (text.includes('urgent') && text.includes('meeting'))) {
      stagedAction = await this.stagePreMeetingDossier(person, event, observation, recommendation);
    }

    return {
      salience: salienceResult.salience,
      category: salienceResult.category,
      explanation: salienceResult.explanation,
      epistemicQuad: {
        observation,
        interpretation,
        anticipation,
        recommendation
      },
      stagedAction
    };
  }

  deriveObservationStatement(event, personName, payload) {
    if (event.eventType === 'EMAIL_RECEIVED') {
      return `${personName} sent an email with subject "${payload.subject || 'Notice'}" stating: "${payload.body || payload.text || 'Message content'}"`;
    }
    if (event.eventType === 'COMMITMENT_APPROACHING') {
      return `Commitment to ${personName} ("${payload.commitment || 'Deliverable'}") is due today with status: ${payload.status || 'pending'}.`;
    }
    if (event.eventType === 'PERSON_EVENT_APPROACHING') {
      return `${personName}'s ${payload.event || 'milestone'} is approaching on ${payload.date || 'tomorrow'}.`;
    }
    return `Event ${event.eventType} observed involving ${personName}.`;
  }

  deriveInterpretationStatement(event, person, context, text) {
    if (text.includes('pricing')) {
      return `Pricing alignment in Clause 4 is the critical hurdle before ${person?.fullName || 'the counterparty'}'s board review.`;
    }
    if (text.includes('birthday')) {
      return `Acknowledging this annual milestone is a high-leverage relationship touchpoint that reinforced partnership trust last year.`;
    }
    if (text.includes('commitment') || event.eventType.includes('COMMITMENT')) {
      return `Failing to fulfill the promised deliverable today risks relationship friction and contract execution delay.`;
    }
    return `This event requires proactive executive attention before downstream consequences compound.`;
  }

  deriveAnticipationStatement(event, person, context, text) {
    if (text.includes('pricing')) {
      return `During the upcoming session, ${person?.fullName || 'the counterparty'} will push for commercial concessions before committing to contract sign-off.`;
    }
    if (text.includes('birthday')) {
      return `${person?.fullName || 'The contact'} will likely check correspondence tomorrow morning; a timely note will stand out positively.`;
    }
    if (text.includes('commitment')) {
      return `The counterparty will inquire about the promised numbers within the next 4 hours.`;
    }
    return `Executive intervention is anticipated before end-of-day.`;
  }

  deriveRecommendationStatement(event, person, context, text) {
    if (text.includes('pricing')) {
      return `Review the 3% volume rebate concession schedule in Drive before entering the call, rather than negotiating without modeling.`;
    }
    if (text.includes('birthday')) {
      return `Authorize dispatch of the personal birthday greeting calibrated in your customary direct and warm voice.`;
    }
    if (text.includes('commitment')) {
      return `Verify the latest valuation spreadsheet in Drive and authorize transmission of the numbers today.`;
    }
    return `Acknowledge receipt and stage the required next step in Zone C.`;
  }

  async stageBirthdayAction(person, event, observation, recommendation) {
    const actionId = `act-birthday-${person.id}`;
    const action = {
      actionId,
      actionType: 'SEND_EMAIL',
      authorizationLevel: 3, // Mandatory Human Approval
      state: ActionState.AWAITING_APPROVAL,
      targetEntityId: person.id,
      targetEntityName: person.fullName,
      headline: `Send Birthday Greeting to ${person.fullName} (Tier ${person.tier})`,
      justification: [
        `Observation: ${observation.statement}`,
        `Recommendation: ${recommendation.statement}`,
        `Provenance Content Hash: ${observation.provenance.contentHash}`
      ],
      preview: {
        recipient: person.emailAddresses ? person.emailAddresses[0] : 'contact@partner.com',
        scheduledFor: 'Tomorrow at 08:30 (BST)',
        subject: `Happy Birthday, ${person.fullName.split(' ')[0]}`,
        body: `${person.fullName.split(' ')[0]},\n\nWishing you a wonderful birthday tomorrow.\n\nReflecting on our work together over the past year—the progress continues to impress me. I hope you get time to celebrate with family.\n\nWarmly,\nJoão`
      },
      consequences: {
        reversibility: 'IRREVERSIBLE ON SEND',
        impact: `Direct personal goodwill touchpoint with ${person.fullName}. Zero commercial solicitation.`
      },
      epistemicState: 'RECOMMENDATION',
      provenance: observation.provenance
    };

    return await this.actionRepo.saveAction(action);
  }

  async stagePreMeetingDossier(person, event, observation, recommendation) {
    const actionId = `act-briefing-${person.id}`;
    const action = {
      actionId,
      actionType: 'PREPARE_BRIEFING',
      authorizationLevel: 1, // Prepare only - zero external effect
      state: ActionState.APPROVED,
      targetEntityId: person.id,
      targetEntityName: person.fullName,
      headline: `Pre-Meeting Pricing Sensitivity Briefing for ${person.fullName}`,
      justification: [
        `Observation: ${observation.statement}`,
        `Recommendation: ${recommendation.statement}`,
        `Provenance Content Hash: ${observation.provenance.contentHash}`
      ],
      preview: {
        keyTakeaways: [
          `Key issue: Clause 4 pricing model sensitivity before Thursday committee.`,
          `Recommended counter: 3% volume rebate tier locked for 24 months.`,
          `Documents indexed: Horizon_Partnership_Agreement_v3_draft.pdf`
        ]
      },
      consequences: {
        reversibility: 'INTERNAL ONLY (ZERO EXTERNAL SIDE EFFECTS)',
        impact: `Arms executive with exact counter-proposals.`
      },
      epistemicState: 'RECOMMENDATION',
      provenance: observation.provenance
    };

    return await this.actionRepo.saveAction(action);
  }
}
