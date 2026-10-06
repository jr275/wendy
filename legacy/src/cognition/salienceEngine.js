/**
 * LEGACY PROTOTYPE SALIENCE — NOT IMPLEMENTED.
 *
 * The previous version derived urgency/impact/category from hardcoded keyword lists
 * ("urgent", "pricing", "birthday", ...). That was keyword intelligence and was removed.
 * The real, explainable salience model lives in the TypeScript Cognitive Core.
 */
export class SalienceEngine {
  evaluate() {
    return {
      salience: null,
      category: 'UNSCORED',
      deservesImmediateAttention: false,
      explanation: 'Salience not computed: the legacy prototype has no salience model.',
      factors: null
    };
  }
}
