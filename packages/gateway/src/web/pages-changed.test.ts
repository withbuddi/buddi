/**
 * `pages.changed { plugin }`: read off the rows every run already writes, and
 * named for the plugin whose tool finished and worked — never for another's.
 */
import { describe, expect, it } from 'vitest';
import { pagesChangedFrame, toolPlugin } from './attention.js';
import type { LogRow } from './stream.js';

const registry = {
  pluginOf: (name: string) => ({ 'finance.record_balance': 'finance', 'email.send': 'email' } as Record<string, string>)[name],
  manifests: () => [{ name: 'finance' }, { name: 'email' }],
};
const pluginOf = (tool: string) => toolPlugin(tool, registry);
const row = (kind: string, payload: Record<string, unknown>): LogRow => ({ id: '1', kind, payload, createdAt: new Date('2026-10-05T10:00:00Z') });

describe('pages.changed', () => {
  it('names the plugin a tool belongs to, by registration or by its family', () => {
    expect(pluginOf('finance.record_balance')).toBe('finance');
    // Registered for one run only: in no registry, but the name says whose it is.
    expect(pluginOf('finance.per_run_thing')).toBe('finance');
    expect(pluginOf('memory_save')).toBeUndefined();
    expect(pluginOf('nobody.write')).toBeUndefined();
  });

  it('is said for a tool that worked, or a gated one that ran once approved', () => {
    expect(pagesChangedFrame(row('tool.result', { name: 'finance.record_balance', ok: true }), pluginOf))
      .toEqual({ event: 'pages.changed', data: { plugin: 'finance', at: '2026-10-05T10:00:00.000Z' } });
    expect(pagesChangedFrame(row('effect.succeeded', { tool: 'email.send', actionId: 'a' }), pluginOf)?.data)
      .toMatchObject({ plugin: 'email' });
  });

  it('is not said for a failed call, a core tool, or a name no plugin owns', () => {
    expect(pagesChangedFrame(row('tool.result', { name: 'finance.record_balance', ok: false, reason: 'refused' }), pluginOf)).toBeNull();
    expect(pagesChangedFrame(row('tool.result', { name: 'memory_save', ok: true }), pluginOf)).toBeNull();
    expect(pagesChangedFrame(row('tool.result', { name: 'nobody.write', ok: true }), pluginOf)).toBeNull();
  });
});
