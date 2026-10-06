/**
 * REAL SALIENCE & ATTENTION SCORING ENGINE
 * Deterministically calculates importance and generates human-readable explanations.
 */
export class SalienceEngine {
  /**
   * Calculates salience score and categorization
   */
  evaluate({ event, resolvedEntities, context }) {
    const payload = event.payload || {};
    const text = `${event.eventType} ${JSON.stringify(payload)}`.toLowerCase();
    const person = resolvedEntities.primaryPerson;
    const relationship = resolvedEntities.relationship;

    // 1. Relationship & Importance Weight (0.0 - 1.0)
    let importance = 0.4;
    if (person) {
      if (person.tier === 1) importance = 1.0;
      else if (person.tier === 2) importance = 0.75;
      else if (person.tier === 3) importance = 0.5;
      else importance = 0.3;
    }

    // 2. Urgency Detection
    let urgency = 0.3;
    if (text.includes('urgent') || text.includes('asap') || text.includes('immediately') || text.includes('emergency')) {
      urgency = 0.95;
    } else if (text.includes('today') || text.includes('tonight') || text.includes('before tomorrow') || text.includes('in 5 hours')) {
      urgency = 0.85;
    } else if (text.includes('tomorrow') || text.includes('birthday') || text.includes('thursday')) {
      urgency = 0.75;
    } else if (text.includes('next week') || text.includes('later')) {
      urgency = 0.25;
    }

    // 3. Business & Commitment Impact
    let businessImpact = 0.4;
    if (text.includes('pricing') || text.includes('committee') || text.includes('board') || text.includes('contract') || text.includes('valuation')) {
      businessImpact = 0.9;
    } else if (text.includes('commitment') || text.includes('promised') || text.includes('numbers')) {
      businessImpact = 0.85;
    } else if (text.includes('birthday') || text.includes('milestone')) {
      businessImpact = 0.7;
    }

    // 4. Closeness & Confidence
    const closeness = relationship ? relationship.closenessScore : 0.5;
    const confidence = event.confidenceScore || 1.0;

    // 5. Deterministic Weighted Formula
    const rawScore = (
      (0.30 * importance) +
      (0.30 * urgency) +
      (0.20 * businessImpact) +
      (0.10 * closeness) +
      (0.10 * confidence)
    );

    const salience = Math.min(1.0, Math.max(0.1, Number(rawScore.toFixed(3))));

    // Category and Explanation
    let category = 'CAN_WAIT';
    let deservesImmediateAttention = false;

    if (urgency >= 0.8 && importance >= 0.8) {
      category = 'URGENT';
      deservesImmediateAttention = true;
    } else if (text.includes('birthday') || (text.includes('milestone') && importance >= 0.7)) {
      category = 'RELATIONSHIP';
      deservesImmediateAttention = false;
    } else if (text.includes('commitment') || text.includes('promised') || event.eventType.includes('COMMITMENT')) {
      category = 'COMMITMENT';
      deservesImmediateAttention = urgency >= 0.8;
    } else if (salience >= 0.75) {
      category = 'URGENT';
      deservesImmediateAttention = true;
    }

    const explanation = this.buildExplanation({
      category,
      salience,
      person,
      urgency,
      businessImpact,
      text
    });

    return {
      salience,
      category,
      deservesImmediateAttention,
      explanation,
      factors: {
        importance,
        urgency,
        businessImpact,
        closeness,
        confidence
      }
    };
  }

  buildExplanation({ category, salience, person, urgency, businessImpact, text }) {
    const personName = person ? person.fullName : 'External Counterparty';
    const tier = person ? `Tier ${person.tier}` : 'Unknown Tier';

    if (category === 'URGENT') {
      return `Surfaced to URGENT (Salience ${salience}) because ${personName} (${tier}) requires time-sensitive alignment (Urgency: ${urgency}, Impact: ${businessImpact}).`;
    }
    if (category === 'RELATIONSHIP') {
      return `Surfaced to RELATIONSHIP (Salience ${salience}) because ${personName} (${tier}) has an approaching milestone with high goodwill value.`;
    }
    if (category === 'COMMITMENT') {
      return `Surfaced to COMMITMENT (Salience ${salience}) because an unfulfilled deliverable with ${personName} is approaching its deadline.`;
    }
    return `Categorized as CAN_WAIT (Salience ${salience}) because time horizon is distant or impact is non-strategic.`;
  }
}
