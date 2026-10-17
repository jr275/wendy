import { ActionExecutor, type ExecutorHooks } from '../actions/executor.js';
import { ActionService } from '../actions/actions.js';
import type { ReasoningClient } from '../cognition/llm.js';
import type { Db } from '../db/db.js';
import type { EmailProvider } from '../providers/interfaces.js';
import { pgRepositories, type Repositories } from '../repositories/pg.js';
import type { Clock } from '../util/clock.js';
import { effectsToolbox, type Toolbox } from '../tools/index.js';
import type { SkillRuntime } from '../skills/runtime.js';

/** Everything the Cognitive Core needs, wired explicitly (no globals). */
export interface WendyContext {
  db: Db;
  repos: Repositories;
  reasoner: ReasoningClient;
  clock: Clock;
  emailProvider: EmailProvider;
  actions: ActionService;
  executor: ActionExecutor;
  /** Skill runtime, when this process runs skills (agent, worker). */
  skills?: SkillRuntime;
}

export function createContext(opts: { db: Db; reasoner: ReasoningClient; clock: Clock; emailProvider: EmailProvider; executorHooks?: ExecutorHooks; toolbox?: Toolbox }): WendyContext {
  return {
    db: opts.db,
    repos: pgRepositories(),
    reasoner: opts.reasoner,
    clock: opts.clock,
    emailProvider: opts.emailProvider,
    actions: new ActionService(opts.db),
    executor: new ActionExecutor(opts.db, opts.emailProvider, opts.executorHooks, opts.toolbox ?? effectsToolbox(), opts.clock),
  };
}
