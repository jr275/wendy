import { SalienceCategory } from '../types/domain.js';

/**
 * ATTENTION & SALIENCE EVALUATION ENGINE
 * Strictly filters noise, computes epistemic importance, and protects cognitive load.
 */
export class AttentionFilter {
  /**
   * Calculates salience score [0.0 - 1.0] and categorizes into the 4 Quadrants.
   */
  evaluate({
    impact = 0.5,
    urgency = 0.5,
    relationshipTier = 3, // 1 is highest, 4 is lowest
    confidence = 1.0,
    timeHorizonHours = 72,
    interruptionPenalty = 0.1
  }) {
    // Normalize tier (Tier 1 = 1.0, Tier 2 = 0.75, Tier 3 = 0.5, Tier 4 = 0.25)
    const tierWeight = Math.max(0.2, (5 - relationshipTier) / 4);

    // Compute raw weighted salience
    const rawSalience = (
      (0.35 * impact) +
      (0.30 * urgency) +
      (0.25 * tierWeight) +
      (0.10 * confidence)
    );

    const salience = Math.min(1.0, Math.max(0.0, rawSalience / (1 + interruptionPenalty)));

    let category = SalienceCategory.CAN_WAIT;
    let shouldAlertImmediately = false;

    if (urgency >= 0.8 && timeHorizonHours <= 6) {
      category = SalienceCategory.URGENT;
      shouldAlertImmediately = true;
    } else if (tierWeight >= 0.9 && timeHorizonHours <= 48) {
      category = SalienceCategory.RELATIONSHIP;
      shouldAlertImmediately = false; // Staged for briefing
    } else if (urgency >= 0.7 && timeHorizonHours <= 24) {
      category = SalienceCategory.COMMITMENT;
      shouldAlertImmediately = false;
    } else if (salience < 0.55) {
      category = SalienceCategory.CAN_WAIT;
      shouldAlertImmediately = false;
    }

    return {
      salience: Number(salience.toFixed(3)),
      category,
      shouldAlertImmediately,
      reason: this.getExplanation(category, salience, urgency, timeHorizonHours)
    };
  }

  getExplanation(category, salience, urgency, hours) {
    switch (category) {
      case SalienceCategory.URGENT:
        return `High urgency meeting/event within ${hours}h with Tier 1 entity (Salience: ${salience}).`;
      case SalienceCategory.RELATIONSHIP:
        return `Approaching milestone for Tier 1 relationship within ${hours}h requiring proactive gesture (Salience: ${salience}).`;
      case SalienceCategory.COMMITMENT:
        return `Unfulfilled deliverable promised by executive due within ${hours}h (Salience: ${salience}).`;
      case SalienceCategory.CAN_WAIT:
      default:
        return `Low immediate impact or distant time horizon (${hours}h). Suppressed to protect executive focus (Salience: ${salience}).`;
    }
  }
}

export const globalAttentionFilter = new AttentionFilter();
