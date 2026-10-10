/**
 * User simulator: plays the PRINCIPAL. It sees only what the principal sees in the chat — Wendy's
 * text and the cards (approvals waiting, run state) — never Wendy's internals or the environment.
 * Its replies go through the same paths the UI uses: a chat message (a new agent turn), or a decision
 * on an approval card (ActionService approve / reject).
 *
 * ScriptedUser is deterministic (engineering runs). Other simulators (e.g. model-played users with a
 * persona) implement the same interface.
 */
import type { UserScript } from './types.js';

export interface Observation {
  turn: number;
  /** What Wendy wrote in the chat since the principal's last move. */
  wendy: string[];
  /** Approval cards waiting for the principal. */
  approvals: { actionId: string; tool: string; label: string; items: string[] }[];
  /** Runs shown in cards. */
  runs: { id: string; skillId: string; status: string }[];
}

export type UserMove =
  | { kind: 'message'; text: string }
  | { kind: 'approve'; actionId: string }
  | { kind: 'reject'; actionId: string; text: string }
  | { kind: 'stop'; reason: string };

export interface UserSimulator {
  /** The first message (the task's request). */
  start(): string;
  next(o: Observation): UserMove;
}

export class ScriptedUser implements UserSimulator {
  private sent = 1;
  private readonly used = new Set<number>();

  constructor(
    private readonly initial: string,
    private readonly script: UserScript,
  ) {}

  start(): string {
    return this.initial;
  }

  next(o: Observation): UserMove {
    const card = o.approvals[0];
    if (card) {
      if (this.script.onApproval === 'approve') return { kind: 'approve', actionId: card.actionId };
      return { kind: 'reject', actionId: card.actionId, text: this.script.rejectionText ?? 'Não.' };
    }
    if (this.sent >= this.script.maxTurns) return { kind: 'stop', reason: 'max turns' };
    const said = o.wendy.join('\n');
    const i = this.script.answers.findIndex((a, k) => !this.used.has(k) && new RegExp(a.whenAsked, 'i').test(said));
    if (i < 0) return { kind: 'stop', reason: o.runs.some((r) => r.status === 'completed' || r.status === 'failed') ? 'done' : 'nothing to answer' };
    this.used.add(i);
    this.sent++;
    return { kind: 'message', text: this.script.answers[i]!.say };
  }
}
