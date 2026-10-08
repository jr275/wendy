/**
 * SKILL REGISTRY. Holds skill definitions, validates them, and answers "which skills could serve this
 * request". It never decides alone: `search` only ranks candidates for the intent step; the choice is
 * made by the model from this list (an enum), and the runtime re-validates everything.
 */
import { maxRisk, type RiskLevel } from '../permissions/policy.js';
import { isToolName, TOOL_SPECS } from '../tools/specs.js';
import type { PermissionDefinition, SkillDefinition, SkillManifest } from './types.js';

export class SkillRegistryError extends Error {}

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Lower-case, accent-free word set (for ranking only). */
function words(s: string): Set<string> {
  return new Set(
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly disabled = new Set<string>();

  register(skill: SkillDefinition): this {
    if (this.skills.has(skill.id)) throw new SkillRegistryError(`skill ${skill.id} is already registered`);
    this.validate(skill);
    this.skills.set(skill.id, skill);
    return this;
  }

  unregister(id: string): boolean {
    for (const s of this.skills.values()) if (s.id !== id && s.dependencies?.includes(id)) throw new SkillRegistryError(`${s.id} depends on ${id}`);
    this.disabled.delete(id);
    return this.skills.delete(id);
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  list(opts: { includeDisabled?: boolean } = {}): SkillDefinition[] {
    return [...this.skills.values()].filter((s) => opts.includeDisabled || !this.disabled.has(s.id));
  }

  enable(id: string): void {
    this.require(id);
    this.disabled.delete(id);
  }

  disable(id: string): void {
    this.require(id);
    this.disabled.add(id);
  }

  isEnabled(id: string): boolean {
    return this.skills.has(id) && !this.disabled.has(id);
  }

  /** Permissions a skill needs, derived from its tools (least privilege: nothing else is reachable). */
  permissions(id: string): PermissionDefinition[] {
    return this.require(id).requiredTools.map((t) => ({ tool: t, category: TOOL_SPECS[t].category }));
  }

  /** Every skill a run of `id` may involve, dependencies first (cycle-free by validation). */
  resolveDependencies(id: string): SkillDefinition[] {
    const out: SkillDefinition[] = [];
    const visit = (sid: string, path: string[]) => {
      if (path.includes(sid)) throw new SkillRegistryError(`dependency cycle: ${[...path, sid].join(' → ')}`);
      const s = this.require(sid);
      for (const d of s.dependencies ?? []) visit(d, [...path, sid]);
      if (!out.includes(s)) out.push(s);
    };
    visit(id, []);
    return out;
  }

  /** The composition tree of a skill, for display and planning. */
  compose(id: string): { id: string; name: string; children: ReturnType<SkillRegistry['compose']>[] } {
    const s = this.require(id);
    this.resolveDependencies(id); // throws on cycles
    return { id: s.id, name: s.name, children: (s.dependencies ?? []).map((d) => this.compose(d)) };
  }

  /** Ranks enabled skills by word overlap with the request (candidates for the intent step only). */
  search(text: string, limit = 8): SkillManifest[] {
    const q = words(text);
    const scored = this.list().map((s) => {
      const hay = words([s.id, s.name, s.description, s.category ?? '', ...s.triggers.flatMap((t) => (t.kind === 'intent' ? t.examples : []))].join(' '));
      let score = 0;
      for (const w of q) if (hay.has(w)) score++;
      return { s, score };
    });
    return scored
      .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
      .slice(0, limit)
      .map((x) => x.s);
  }

  /** Throws if a definition is not usable. */
  validate(skill: SkillDefinition): void {
    const problems: string[] = [];
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(skill.id)) problems.push('id must be kebab-case');
    if (!SEMVER.test(skill.version)) problems.push('version must be semver (x.y.z)');
    if (!skill.name.trim() || !skill.description.trim()) problems.push('name and description are required');
    if (!skill.steps.length) problems.push('at least one step');
    const stepIds = skill.steps.map((s) => s.id);
    if (new Set(stepIds).size !== stepIds.length) problems.push('step ids must be unique');
    for (const t of skill.requiredTools) if (!isToolName(t)) problems.push(`unknown tool ${t}`);
    const toolRisk = skill.requiredTools.filter(isToolName).reduce<RiskLevel>((r, t) => maxRisk(r, TOOL_SPECS[t].risk), 'LOW');
    if (maxRisk(skill.riskLevel, toolRisk) !== skill.riskLevel) problems.push(`riskLevel ${skill.riskLevel} is below its tools' risk ${toolRisk}`);
    for (const d of skill.dependencies ?? []) {
      const dep = d === skill.id ? skill : this.skills.get(d);
      if (!dep) problems.push(`dependency ${d} is not registered`);
      else if (!dep.composable) problems.push(`dependency ${d} is not composable`);
      else if (d === skill.id) problems.push('a skill cannot depend on itself');
      else if (maxRisk(skill.riskLevel, dep.riskLevel) !== skill.riskLevel) problems.push(`riskLevel ${skill.riskLevel} is below dependency ${d} (${dep.riskLevel})`);
    }
    if (problems.length) throw new SkillRegistryError(`skill ${skill.id}: ${problems.join('; ')}`);
  }

  private require(id: string): SkillDefinition {
    const s = this.skills.get(id);
    if (!s) throw new SkillRegistryError(`unknown skill ${id}`);
    return s;
  }
}
