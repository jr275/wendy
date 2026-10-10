/**
 * The continuous loop: one cycle = verify ledger → detect → expire → think → reconcile → act → resume skills.
 * Safe to run in several processes at once (events and executions are claimed with SKIP LOCKED).
 */
import { assertLedgerIntegrity, LedgerIntegrityError } from '../audit/ledger.js';
import { runDetectors } from '../cognition/detectors.js';
import { processEvent, type PipelineOutcome } from '../cognition/pipeline.js';
import type { WendyContext } from './context.js';

export const WORKER_CONFIG = {
  eventLeaseMs: 10 * 60_000,
  inFlightStaleMs: 2 * 60_000,
  batchSize: 10,
};

export interface CycleReport {
  detected: string[];
  expired: number;
  outcomes: PipelineOutcome[];
  failures: { eventId: string; error: string }[];
  reconciled: string[];
  executed: string[];
  /** Skill runs advanced this cycle (resumed after approval, child finished, or recovered after a crash). */
  skills: string[];
}

export async function runCycle(ctx: WendyContext, opts: { inFlightStaleMs?: number } = {}): Promise<CycleReport> {
  await assertLedgerIntegrity(ctx.db); // FAIL CLOSED: nothing runs on a compromised ledger
  const now = ctx.clock.now();
  const report: CycleReport = { detected: [], expired: 0, outcomes: [], failures: [], reconciled: [], executed: [], skills: [] };

  for (const principal of await ctx.repos.entities.listPrincipals(ctx.db)) {
    report.detected.push(...(await runDetectors(ctx.db, principal, now)).emitted);
    report.expired += await ctx.actions.expireDue(principal.id, now);
  }

  for (;;) {
    const batch = await ctx.repos.events.claimPending(ctx.db, now, WORKER_CONFIG.eventLeaseMs, WORKER_CONFIG.batchSize);
    if (batch.length === 0) break;
    for (const event of batch) {
      try {
        report.outcomes.push(await processEvent(ctx, event));
      } catch (err) {
        const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        await ctx.repos.events.markFailed(ctx.db, event.id, error, now);
        report.failures.push({ eventId: event.id, error });
      }
    }
  }

  report.reconciled = await ctx.executor.reconcileInFlight(new Date(Date.now() - (opts.inFlightStaleMs ?? WORKER_CONFIG.inFlightStaleMs)));
  report.executed = await ctx.executor.runPending();
  await ctx.executor.settleAsync(); // long-running effects (e.g. calls) that may have finished
  if (ctx.skills) report.skills = await ctx.skills.runReady();
  return report;
}

export function startWorker(ctx: WendyContext, intervalMs: number, onReport: (r: CycleReport) => void, onError: (e: unknown) => void): { stop(): Promise<void> } {
  let running = true;
  let current: Promise<void> = Promise.resolve();
  const loop = async () => {
    while (running) {
      current = runCycle(ctx).then(onReport, (e) => {
        onError(e);
        // A ledger integrity failure is fatal: stop instead of continuing silently.
        if (e instanceof LedgerIntegrityError) running = false;
      });
      await current;
      if (running) await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return {
    async stop() {
      running = false;
      await current;
    },
  };
}
