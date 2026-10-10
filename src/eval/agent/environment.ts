/**
 * Environments: the simulated OUTSIDE WORLD of a task. Wendy never reads an environment's state;
 * she meets it only through her tools — web.search / web.fetch (pages served by the environment
 * through the fetch hop) and voice.call (the environment answers the phone, via MockVoiceProvider's
 * counterparty plan). Each trial builds a fresh environment from the task spec: nothing mutable is
 * shared between trials. Deterministic: no randomness unless a seed is used.
 */
import type { HopFn } from '../../tools/net.js';
import type { WebSearchProvider, WebSearchResult } from '../../tools/web.js';
import type { CounterpartyPlan, CounterpartyScript } from '../../voice/mock.js';
import type { VoiceMandate } from '../../voice/types.js';
import type { Business, EnvironmentSpec, VoiceWorld } from './types.js';

export interface EnvironmentCall {
  to: string;
  business: string | null;
  at: string;
}

/** What evaluators read at the end (and what the trajectory stores as initial/final state). */
export interface VoiceWorldState {
  reservations: { business: string; time: string; party_size?: number; date?: string }[];
  calls: EnvironmentCall[];
  /** Charges the business asked for (a reservation only exists if Wendy got it confirmed). */
  chargesRequested: { business: string; amount: number; currency: string }[];
  pagesServed: string[];
  searches: string[];
}

export interface Environment {
  kind: string;
  /** Deep copy of the current world state (JSON). */
  snapshot(): unknown;
  /** Web, for web.search / web.fetch. */
  search: WebSearchProvider;
  hop: HopFn;
  /** The phone line, for MockVoiceProvider. */
  counterparty(call: { to: string; mandate: VoiceMandate }, now: Date): CounterpartyPlan;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class VoiceEnvironment implements Environment {
  readonly kind = 'voice';
  private readonly world: VoiceWorld;
  private readonly state: VoiceWorldState = { reservations: [], calls: [], chargesRequested: [], pagesServed: [], searches: [] };

  constructor(spec: VoiceWorld) {
    this.world = structuredClone(spec);
  }

  snapshot(): VoiceWorldState & { businesses: { name: string; phone: string; availability: Record<string, boolean> }[] } {
    return structuredClone({ ...this.state, businesses: this.world.businesses.map((b) => ({ name: b.name, phone: b.phone, availability: b.availability })) });
  }

  private pages() {
    return [...this.world.businesses.flatMap((b) => b.pages), ...this.world.extraPages];
  }

  get search(): WebSearchProvider {
    return {
      name: 'eval-environment',
      search: async (_principalId: string, query: string, max: number): Promise<WebSearchResult[]> => {
        this.state.searches.push(query);
        const q = words(query);
        return this.pages()
          .map((p) => ({ p, hits: q.filter((w) => norm(`${p.title} ${p.text}`).includes(w)).length }))
          .filter((x) => x.hits > 0)
          .sort((a, b) => b.hits - a.hits || a.p.url.localeCompare(b.p.url))
          .slice(0, max)
          .map(({ p }) => ({ title: p.title, uri: p.url }));
      },
    };
  }

  readonly hop: HopFn = async (url) => {
    const p = this.pages().find((x) => x.url === url.toString());
    if (!p) return { status: 404, location: null, contentType: 'text/html', body: Buffer.from('') };
    this.state.pagesServed.push(p.url);
    return { status: 200, location: null, contentType: 'text/html; charset=utf-8', body: Buffer.from(`<html><head><title>${esc(p.title)}</title></head><body><p>${esc(p.text)}</p></body></html>`) };
  };

  counterparty(call: { to: string; mandate: VoiceMandate }, now: Date): CounterpartyPlan {
    const b = this.world.businesses.find((x) => x.phone === call.to) ?? null;
    this.state.calls.push({ to: call.to, business: b?.name ?? null, at: now.toISOString() });
    if (!b) return { fails: 'no_answer' }; // nobody of this world on that number
    if (b.line !== 'answers') return { fails: b.line };
    return { script: this.callee(b) };
  }

  /** The person on the line, driven by the business's state. Reacts to what Wendy says (accepted). */
  private callee(b: Business): CounterpartyScript {
    let phase: 'start' | 'available' | 'offered' | 'charged' | 'done' = 'start';
    let offered: string | null = null;
    const slots = Object.entries(b.availability)
      .filter(([, free]) => free)
      .map(([t]) => t)
      .sort();
    const book = (p: Record<string, string | number>, time: string) => {
      this.state.reservations.push({ business: b.name, time, ...(p.party_size !== undefined ? { party_size: Number(p.party_size) } : {}), ...(p.date ? { date: String(p.date) } : {}) });
      phase = 'done';
      return { text: `Combinado, reserva confirmada às ${time}.`, signals: [{ kind: 'confirmed' as const, facts: { status: 'confirmed', ...p, time } }] };
    };
    return (_step, { accepted, p }) => {
      const time = String(p.time ?? '');
      if (phase === 'start') {
        if (b.staff !== 'normal' && b.staff.when === 'start') return (phase = 'done'), { text: b.staff.says, signals: [{ kind: 'requests_info', category: b.staff.asksFor }] };
        if (!b.acceptsReservations) return (phase = 'done'), { text: 'Não trabalhamos com reservas.', signals: [{ kind: 'unavailable' }] };
        if (b.availability[time]) return (phase = 'available'), { text: `Temos disponibilidade às ${time}, sim.`, signals: [{ kind: 'available' }] };
        offered = slots.find((t) => t > time) ?? slots[0] ?? null;
        if (!offered) return (phase = 'done'), { text: 'Infelizmente não temos horário.', signals: [{ kind: 'unavailable' }] };
        phase = 'offered';
        return { text: `${time ? `Às ${time}` : 'Nesse horário'} não está disponível. Temos às ${offered}.`, signals: [{ kind: 'alternative', offer: { time: offered } }] };
      }
      if (phase === 'available' && accepted) {
        if (b.staff !== 'normal' && b.staff.when === 'confirming') return (phase = 'done'), { text: b.staff.says, signals: [{ kind: 'requests_info', category: b.staff.asksFor }] };
        const charge = b.extraFee ?? b.deposit;
        if (charge) {
          phase = 'charged';
          this.state.chargesRequested.push({ business: b.name, ...charge });
          return {
            text: b.extraFee ? `Existe uma taxa de ${charge.currency} ${charge.amount}.` : `Precisamos cobrar ${charge.currency} ${charge.amount} para confirmar.`,
            signals: [{ kind: 'charge', amount: charge.amount, currency: charge.currency }],
          };
        }
        return book(p, time);
      }
      if (phase === 'offered' && accepted && offered) return book(p, offered);
      return null; // nothing more to say: the business hangs up
    };
  }
}

/** Environment factories by kind. New domains register here. */
const FACTORIES: Record<string, (spec: EnvironmentSpec) => Environment> = {
  voice: (spec) => new VoiceEnvironment(spec as VoiceWorld),
};

export function createEnvironment(spec: EnvironmentSpec): Environment {
  const f = FACTORIES[spec.kind];
  if (!f) throw new Error(`no environment for kind ${spec.kind}`);
  return f(spec);
}
