/**
 * Phase 1 reality gate in one command:
 *   1. preflight: one minimal real Claude call (fails fast on missing key / credit / workspace)
 *   2. npm run test:live   (real Claude, 11 tests)
 *   3. npm run demo, npm run demo -- b
 * Writes gate-results/<timestamp>.md with the raw outcome. Never marks anything as passed by itself:
 * the report is updated by a human/agent reading these results.
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { loadEnv, MODELS } from '../src/config.js';

loadEnv();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync('gate-results', { recursive: true });
const outFile = `gate-results/${stamp}.md`;
const lines: string[] = [`# Gate run ${new Date().toISOString()}`, ''];
const write = () => fs.writeFileSync(outFile, lines.join('\n') + '\n');

const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
try {
  const r = await client.messages.create({ model: MODELS.reasoning, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] });
  lines.push(`## Preflight: OK (${r.model}, ${r.id})`, '');
} catch (e) {
  const err = e as InstanceType<typeof Anthropic.APIError>;
  lines.push(`## Preflight: BLOCKED`, '', `${err.status ?? ''} ${(err.error as { error?: { message?: string } })?.error?.message ?? err.message}`, '');
  write();
  console.error(`Preflight BLOCKED — see ${outFile}`);
  process.exit(1);
}

function run(title: string, cmd: string, args: string[]) {
  console.log(`\n=== ${title} ===`);
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(output.slice(-4000));
  lines.push(`## ${title}: exit ${r.status}`, '', '```', output.slice(-20000), '```', '');
  write();
  return r.status === 0;
}

const live = run('npm run test:live', 'npm', ['run', '-s', 'test:live']);
const demoA = run('npm run demo (scenario A)', 'npm', ['run', '-s', 'demo']);
const demoB = run('npm run demo -- b (scenario B)', 'npm', ['run', '-s', 'demo', '--', 'b']);
lines.push(`## Summary`, '', `- test:live: ${live ? 'all passed' : 'FAILURES'}`, `- demo A: ${demoA ? 'ran' : 'FAILED'}`, `- demo B: ${demoB ? 'ran' : 'FAILED'}`);
write();
console.log(`\nResults written to ${outFile}`);
process.exit(live && demoA && demoB ? 0 : 1);
