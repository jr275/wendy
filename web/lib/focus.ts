/**
 * When may a card take over the "Em foco" panel? Only when it arrived in an answer that is being
 * produced NOW, in this page session — never because the conversation was restored from history.
 *
 * Without this rule every visit to Hoje opened on the last answer from some earlier day, covering the
 * panel and pushing today's greeting, the delegate field, "Agora" and "Retomar" off the screen.
 * (Opening any card on purpose, from "Ver raciocínio e fontes", is unaffected.)
 */
export const LIVE_GRACE_MS = 1500; // a card renders a moment after its turn finishes

export interface LiveGate {
  begin(): void;
  end(now?: number): void;
  /** Is a card that appears at `now` part of a live answer? */
  accepts(now?: number): boolean;
}

export function createLiveGate(): LiveGate {
  let until = 0;
  return {
    begin: () => {
      until = Number.POSITIVE_INFINITY;
    },
    end: (now = Date.now()) => {
      until = now + LIVE_GRACE_MS;
    },
    accepts: (now = Date.now()) => now <= until,
  };
}
