import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_SPECS } from '../../src/tools/specs.js';

describe('approval labels in the web app', () => {
  it('every tool that can ask for approval (any non-read tool) has a Portuguese label, so the Home never shows a raw tool name', () => {
    const src = fs.readFileSync('web/lib/format.ts', 'utf8');
    const block = src.slice(src.indexOf('export const ACTION_LABEL'), src.indexOf('};', src.indexOf('export const ACTION_LABEL')));
    for (const spec of Object.values(TOOL_SPECS).filter((s) => s.category !== 'READ')) expect(block, spec.name).toContain(`"${spec.name}"`);
  });
});
