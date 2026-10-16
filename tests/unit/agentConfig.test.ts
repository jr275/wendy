/**
 * WENDY_AGENT semantics (web/lib/agentConfig.ts). Pure: no database, no network, no process.env. Only "off" (or
 * demo mode) is ever treated as KNOWN unavailability; "on" and a missing value both mean "unknown", and a bad value
 * is never silently read as either "available" or "off".
 */
import { describe, expect, it } from 'vitest';
import { AGENT_OFF_REASON, DEMO_REASON, parseAgentSetting, unavailableReason } from '../../web/lib/agentConfig.js';

describe('parseAgentSetting', () => {
  it('"off" is an explicit disable, case and spacing insensitive', () => {
    for (const v of ['off', 'OFF', ' Off ', 'oFf\n']) expect(parseAgentSetting(v)).toBe('off');
  });
  it('"on" is recognised but is not a proof of availability', () => {
    for (const v of ['on', 'ON', ' on ']) expect(parseAgentSetting(v)).toBe('on');
  });
  it('missing or blank means unset', () => {
    for (const v of [undefined, null, '', '   ']) expect(parseAgentSetting(v)).toBe('unset');
  });
  it('anything else is invalid, never off and never on (typos, other conventions)', () => {
    for (const v of ['ofline', 'of', '0', 'false', 'disabled', 'no', '1', 'true', 'off,on']) expect(parseAgentSetting(v), v).toBe('invalid');
  });
});

describe('unavailableReason', () => {
  it('off says so before any send', () => {
    expect(unavailableReason({ demo: false, setting: 'off' })).toBe(AGENT_OFF_REASON);
  });
  it('unknown states claim nothing: unset, on and invalid all give no reason', () => {
    for (const setting of ['unset', 'on', 'invalid'] as const) expect(unavailableReason({ demo: false, setting }), setting).toBeUndefined();
  });
  it('demo mode keeps its own sentence, even when WENDY_AGENT says something else', () => {
    for (const setting of ['off', 'on', 'unset', 'invalid'] as const) expect(unavailableReason({ demo: true, setting }), setting).toBe(DEMO_REASON);
  });
  it('the sentences state a configuration, not an error, and make no claim about a failed attempt', () => {
    expect(AGENT_OFF_REASON).toMatch(/desligado neste ambiente/);
    expect(AGENT_OFF_REASON).not.toMatch(/erro|falh|tente de novo|instantes/i);
  });
});
