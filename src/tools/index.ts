/**
 * Toolbox: every tool implementation, wired with its providers (no globals). READ tools are called by
 * skill steps through the runtime's gateway; effects are only reached through approved actions.
 */
import type { HopFn, Resolver } from './net.js';
import { documentTools, defaultDocumentsRoot } from './documents.js';
import { isToolName, TOOL_SPECS, type ToolName } from './specs.js';
import { memoryTools } from './memory.js';
import { researchTools } from './research.js';
import { taskTools } from './tasks.js';
import { ToolError, type AnyReadTool, type AnyToolEffect } from './types.js';
import { webTools, type WebSearchProvider } from './web.js';
import { voiceTools, type VoiceToolDeps } from './voice.js';
import { systemClock } from '../util/clock.js';
import { voiceConfig } from '../voice/config.js';
import { VoicePolicy } from '../voice/policy.js';
import { createVoiceProvider } from '../voice/provider.js';

export interface ToolboxDeps {
  /** Lazily created, so nothing reaches Vertex unless a search actually runs. */
  search: () => WebSearchProvider;
  documentsRoot?: string;
  hop?: HopFn;
  resolve?: Resolver;
  /** Telephony (default: VOICE_PROVIDER from the environment; no real provider exists yet). */
  voice?: VoiceToolDeps;
}

export function defaultVoiceDeps(): VoiceToolDeps {
  return { provider: () => createVoiceProvider(), policy: new VoicePolicy(voiceConfig()), clock: systemClock };
}

export class Toolbox {
  private readonly reads = new Map<ToolName, AnyReadTool>();
  private readonly effects = new Map<ToolName, AnyToolEffect>();

  constructor(deps: ToolboxDeps) {
    let provider: WebSearchProvider | null = null;
    const search: WebSearchProvider = {
      get name() {
        return (provider ??= deps.search()).name;
      },
      search: (p, q, m) => (provider ??= deps.search()).search(p, q, m),
    };
    const all = { ...webTools({ search, hop: deps.hop, resolve: deps.resolve }), ...documentTools({ root: deps.documentsRoot ?? defaultDocumentsRoot() }), ...taskTools(), ...researchTools(), ...memoryTools(), ...voiceTools(deps.voice ?? defaultVoiceDeps()) };
    for (const [name, t] of Object.entries(all)) {
      if (!isToolName(name)) throw new Error(`tool ${name} has no spec`);
      if ('run' in t) this.reads.set(name, t as AnyReadTool);
      else this.effects.set(name, t as AnyToolEffect);
    }
    for (const name of Object.keys(TOOL_SPECS) as ToolName[]) {
      if (!this.reads.has(name) && !this.effects.has(name)) throw new Error(`tool ${name} has a spec but no implementation`);
      const isRead = TOOL_SPECS[name].category === 'READ';
      if (isRead !== this.reads.has(name)) throw new Error(`tool ${name}: READ tools must have run(), others an effect`);
    }
  }

  read(name: ToolName): AnyReadTool | undefined {
    return this.reads.get(name);
  }

  effect(name: string): AnyToolEffect | undefined {
    return isToolName(name) ? this.effects.get(name) : undefined;
  }
}

/**
 * A toolbox for executing approved effects (tasks.*), which need no search provider. Every action
 * executor gets one, so an approved tool action can never be picked up by an executor that cannot run it.
 */
export function effectsToolbox(): Toolbox {
  return new Toolbox({
    search: () => {
      throw new ToolError('NOT_ALLOWED', 'web search is not configured in this process');
    },
  });
}
