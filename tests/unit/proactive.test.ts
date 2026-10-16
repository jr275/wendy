/**
 * The anatomy of a proactive suggestion (web/lib/proactive.ts), fed with insight cards shaped exactly
 * like the read API returns them. Everything shown must come from Wendy's records: origin from the
 * evidence cited, "why" from the stored explanation, the action from her action records — and an
 * approval that is still waiting must never read as "done".
 */
import { describe, expect, it } from 'vitest';
import { actionOf, anatomyOf, originOf } from '../../web/lib/proactive.js';
import type { InsightCard } from '../../web/lib/wendy.js';

const card = (over: Partial<InsightCard> = {}): InsightCard => ({
  id: 'i1', status: 'SURFACED', headline: 'Queda de 30% nos cliques [C1]', narrative: null, created_at: '2026-10-08T12:00:00Z', score: 0.8, event_type: 'SEARCH_PERFORMANCE_CHANGE', test_double: false, other_model: null,
  claims: [], explanation: ['Pontuação 0.82 (limiar 0.5) — apareceu na sua tela.', 'confidence: 0.9'], cited: [{ handle: 'SC1', kind: 'search_metric', id: 'x' }, { handle: 'E1', kind: 'event', id: 'y' }], actions: [], ...over,
});

describe('origin', () => {
  it('names where the information came from, from the evidence the claims cite (not from the event wrapper)', () => {
    expect(originOf(card())).toBe('Search Console');
    expect(originOf(card({ cited: [{ handle: 'M1', kind: 'message', id: 'a' }, { handle: 'MEM1', kind: 'memory', id: 'b' }, { handle: 'SC1', kind: 'search_metric', id: 'c' }] }))).toBe('e-mail · memória · Search Console');
  });
  it('falls back to the event type when nothing is cited, and never hides an unknown kind', () => {
    expect(originOf(card({ cited: null }))).toBe('site · Google');
    expect(originOf(card({ cited: [{ handle: 'Z1', kind: 'novo_tipo', id: 'a' }] }))).toBe('novo_tipo');
    expect(originOf(card({ cited: [{ handle: 'E1', kind: 'event', id: 'a' }], event_type: 'COMMITMENT_DUE' }))).toBe('compromisso');
  });
});

describe('the action and its nature', () => {
  it('no action: it says so (information only), it does not invent a recommendation', () => {
    expect(actionOf([])).toEqual({ nature: 'none', text: 'Nenhuma ação sugerida: é só informação.' });
    expect(actionOf(null).nature).toBe('none');
  });
  it('a draft still waiting is a SUGGESTION that needs you, never "done"', () => {
    for (const state of ['PROPOSED', 'STAGED', 'AWAITING_APPROVAL']) {
      const a = actionOf([{ id: 'a', type: 'SEND_EMAIL', state }]);
      expect(a.nature, state).toBe('suggestion');
      expect(a.text).toContain('aguardando sua aprovação');
    }
  });
  it('done only when the record says executed/verified; approved-but-running is not done', () => {
    expect(actionOf([{ id: 'a', type: 'PREPARE_BRIEFING', state: 'VERIFIED' }])).toMatchObject({ nature: 'done', text: 'Briefing concluído e verificado.' });
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'APPROVED' }]).nature).toBe('suggestion');
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'EXECUTING' }]).nature).toBe('suggestion');
  });
  it('a pending approval wins over an older finished action of the same insight', () => {
    expect(actionOf([{ id: 'a', type: 'PREPARE_BRIEFING', state: 'VERIFIED' }, { id: 'b', type: 'SEND_EMAIL', state: 'AWAITING_APPROVAL' }]).nature).toBe('suggestion');
  });
  it('stopped outcomes are stated plainly', () => {
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'REJECTED' }]).text).toBe('E-mail recusado por você.');
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'FAILED' }]).text).toBe('E-mail não foi concluído.');
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'EXPIRED' }]).text).toBe('E-mail expirou sem decisão.');
    expect(actionOf([{ id: 'a', type: 'SEND_EMAIL', state: 'CANCELLED' }]).text).toBe('E-mail cancelado.');
  });
});

describe('anatomy', () => {
  it('combines the four answers and strips claim markers from the headline', () => {
    expect(anatomyOf(card({ actions: [{ id: 'a', type: 'SEND_EMAIL', state: 'AWAITING_APPROVAL' }] }))).toEqual({
      detected: 'Queda de 30% nos cliques', origin: 'Search Console', whyShown: 'Pontuação 0.82 (limiar 0.5) — apareceu na sua tela.',
      action: { nature: 'suggestion', text: 'E-mail aguardando sua aprovação. Nada sai antes disso.' },
    });
  });
  it('shows no "why" when Wendy recorded no explanation (it is not made up)', () => {
    expect(anatomyOf(card({ explanation: null })).whyShown).toBeNull();
    expect(anatomyOf(card({ explanation: [] })).whyShown).toBeNull();
  });
});

describe('quiet list ("registrados sem interromper")', () => {
  const mk = (id: string, status: InsightCard['status'], at: string): InsightCard => card({ id, status, created_at: at });
  it('lists only what Wendy recorded without interrupting, newest first, and respects the limit', async () => {
    const { quietOf } = await import('../../web/lib/proactive.js');
    const all = [mk('a', 'SURFACED', '2026-10-09T10:00:00Z'), mk('b', 'SUPPRESSED', '2026-10-08T10:00:00Z'), mk('c', 'SUPPRESSED', '2026-10-09T09:00:00Z'), mk('d', 'REJECTED_BY_VALIDATION', '2026-10-09T11:00:00Z'), mk('e', 'SUPPRESSED', '2026-10-07T10:00:00Z')];
    expect(quietOf(all).map((i) => i.id)).toEqual(['c', 'b', 'e']); // surfaced and rejected are not here
    expect(quietOf(all, 2).map((i) => i.id)).toEqual(['c', 'b']);
    expect(quietOf([])).toEqual([]);
  });
  it('does not mutate what it is given', async () => {
    const { quietOf } = await import('../../web/lib/proactive.js');
    const all = [mk('b', 'SUPPRESSED', '2026-10-08T10:00:00Z'), mk('c', 'SUPPRESSED', '2026-10-09T09:00:00Z')];
    quietOf(all);
    expect(all.map((i) => i.id)).toEqual(['b', 'c']);
  });
});
