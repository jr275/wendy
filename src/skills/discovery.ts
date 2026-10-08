/**
 * Intent → skill. The registry ranks candidates; the model picks one id FROM THAT LIST (an enum) or
 * "none", and fills its input; the skill's own schema then validates the input. Nothing here is a
 * keyword rule: the decision is the model's, the constraints are code's.
 */
import { z } from 'zod';
import type { ReasoningClient } from '../cognition/llm.js';
import type { Db } from '../db/db.js';
import type { Toolbox } from '../tools/index.js';
import { INTENT_SYSTEM } from './prompts.js';
import type { SkillRegistry } from './registry.js';

export type Intent = { kind: 'skill'; skillId: string; input: unknown; reason: string; modelCallId: string } | { kind: 'none'; reason: string; modelCallId: string | null };

export async function discoverIntent(
  deps: { db: Db; registry: SkillRegistry; toolbox: Toolbox; reasoner: ReasoningClient },
  req: { principalId: string; request: string; screen?: string | null; now: Date },
): Promise<Intent> {
  const candidates = deps.registry.search(req.request).filter((s) => s.triggers.some((t) => t.kind === 'intent'));
  if (!candidates.length) return { kind: 'none', reason: 'no skills available', modelCallId: null };

  // Data the model may copy inputs from (never invent): readable documents and open tasks.
  const ctx = { db: deps.db, principalId: req.principalId, now: req.now };
  const documents = await deps.toolbox.read('documents.list')!.run(ctx, {}).catch(() => [] as unknown);
  const tasks = await deps.toolbox.read('tasks.list')!.run(ctx, {}).catch(() => [] as unknown);

  const catalog = candidates.map((s) => {
    const full = deps.registry.get(s.id)!;
    return {
      id: s.id,
      description: s.description,
      examples: s.triggers.flatMap((t) => (t.kind === 'intent' ? t.examples : [])),
      input_schema: z.toJSONSchema(full.inputs, { io: 'input' }),
    };
  });
  const Choice = z.object({
    skill: z.enum(['none', ...candidates.map((c) => c.id)] as [string, ...string[]]),
    input_json: z.string().describe('JSON object with the chosen skill input; "{}" for none'),
    reason: z.string(),
  });

  const r = await deps.reasoner.generate({
    purpose: 'intent',
    principalId: req.principalId,
    system: INTENT_SYSTEM,
    user: [
      `Current time: ${req.now.toISOString()}`,
      req.screen ? `On screen while asking: ${req.screen}` : '',
      '',
      'Skill catalog:',
      JSON.stringify(catalog, null, 1),
      '',
      `Documents available (paths): ${JSON.stringify((documents as { path: string }[]).map((d) => d.path))}`,
      `Open tasks: ${JSON.stringify(tasks)}`,
      '',
      '<request>',
      req.request,
      '</request>',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    schema: Choice,
    effort: 'low',
    evidenceRefs: [],
  });

  const { skill, input_json, reason } = r.output;
  if (skill === 'none') return { kind: 'none', reason, modelCallId: r.modelCallId };
  const def = deps.registry.get(skill);
  if (!def || !deps.registry.isEnabled(skill)) return { kind: 'none', reason: `unknown skill ${skill}`, modelCallId: r.modelCallId };
  let raw: unknown;
  try {
    raw = JSON.parse(input_json);
  } catch {
    return { kind: 'none', reason: `input for ${skill} was not JSON`, modelCallId: r.modelCallId };
  }
  const parsed = def.inputs.safeParse(raw);
  if (!parsed.success) return { kind: 'none', reason: `input for ${skill} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, modelCallId: r.modelCallId };
  return { kind: 'skill', skillId: skill, input: parsed.data, reason, modelCallId: r.modelCallId };
}
