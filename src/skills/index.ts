/** Wiring of the skill layer: built-in registry and runtime factory. */
import { ActionExecutor } from '../actions/executor.js';
import type { WendyContext } from '../runtime/context.js';
import { Toolbox, type ToolboxDeps } from '../tools/index.js';
import { GeminiWebSearch } from '../tools/web.js';
import { contactManagement } from './builtin/contactManagement.js';
import { documentAnalysis } from './builtin/documentAnalysis.js';
import { learnAboutMe } from './builtin/learnAboutMe.js';
import { marketWatchSkill } from './builtin/marketWatch.js';
import { researchDigestSkill } from './builtin/researchDigest.js';
import { researchAndPlan } from './builtin/researchAndPlan.js';
import { taskManagement } from './builtin/taskManagement.js';
import { voiceConcierge } from './builtin/voiceConcierge.js';
import { webResearch } from './builtin/webResearch.js';
import { SkillRegistry } from './registry.js';
import { SkillRuntime, type RuntimeDeps } from './runtime.js';

/** Built-in skills, dependencies first. */
export function builtinRegistry(): SkillRegistry {
  return new SkillRegistry().register(webResearch).register(documentAnalysis).register(taskManagement).register(researchAndPlan).register(learnAboutMe).register(voiceConcierge).register(researchDigestSkill).register(marketWatchSkill).register(contactManagement);
}

export function defaultToolbox(ctx: Pick<WendyContext, 'db'>, overrides: Partial<ToolboxDeps> = {}): Toolbox {
  return new Toolbox({ search: () => new GeminiWebSearch(ctx.db), ...overrides });
}

export function createSkillRuntime(
  ctx: Pick<WendyContext, 'db' | 'reasoner' | 'clock' | 'emailProvider'>,
  opts: { registry?: SkillRegistry; toolbox?: Toolbox } & Partial<Pick<RuntimeDeps, 'owner' | 'leaseMs' | 'sleep' | 'hooks'>> = {},
): { runtime: SkillRuntime; registry: SkillRegistry; toolbox: Toolbox } {
  const registry = opts.registry ?? builtinRegistry();
  const toolbox = opts.toolbox ?? defaultToolbox(ctx);
  const executor = new ActionExecutor(ctx.db, ctx.emailProvider, {}, toolbox);
  const runtime = new SkillRuntime({ db: ctx.db, registry, toolbox, reasoner: ctx.reasoner, clock: ctx.clock, executor, owner: opts.owner, leaseMs: opts.leaseMs, sleep: opts.sleep, hooks: opts.hooks });
  return { runtime, registry, toolbox };
}
