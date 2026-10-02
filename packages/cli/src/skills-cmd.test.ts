import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { GatewayUnavailable } from './mcp/gateway-client.js';
import { runSkills } from './skills-cmd.js';

const SKILLS = [
  { id: 'my-voice', title: 'Write in my voice', description: 'When drafting.', group: 'mine', every: true, holders: [], untrusted: null },
  { id: 'packing', title: 'Trip packing list', description: 'When I travel.', group: 'mine', every: false, holders: [], untrusted: 'upload' },
  { id: 'researcher/compare', title: 'Compare sources', description: 'When comparing.', group: 'catalogue', every: false, holders: [{ agent: 'researcher' }, { agent: 'scout' }], untrusted: null },
];

describe('buddi skills list', () => {
  it('parses', () => {
    expect(parseArgs(['skills', 'list'])).toEqual({ kind: 'skills', action: 'list' });
    expect(() => parseArgs(['skills'])).toThrow(/expected list/);
  });

  it('prints the groups with who uses each', async () => {
    const lines: string[] = [];
    const code = await runSkills({ gateway: { get: async () => ({ skills: SKILLS }) as never }, json: false, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Yours\n  Write in my voice (my-voice) — every agent');
    expect(text).toContain('Trip packing list (packing) — no agent uses it · untrusted until you mark it as yours');
    expect(text).toContain('From the catalogue\n  Compare sources (researcher/compare) — researcher, scout');
    expect(text).not.toContain('Learned');
  });

  it('says when buddi is not running', async () => {
    const errs: string[] = [];
    const code = await runSkills({ gateway: { get: async () => { throw new GatewayUnavailable(); } }, json: false, err: (l) => errs.push(l) });
    expect(code).toBe(3);
  });
});
