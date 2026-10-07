import { describe, expect, it, vi } from 'vitest';
import type { CoreToolContext, Mission } from '@buddi/core';
import { runConsent } from './run-consent.js';

const ctx = {} as CoreToolContext;
const mission = { context: { plugin: 'digest', export: 'material', args: { slot: 'late' } } } satisfies Pick<Mission, 'context'>;

describe('a mission context vouching for a tool in its run (host API 1.33)', () => {
  it('asks only the context plugin, with the tool, its export and its args, and rechecks every call', async () => {
    const registry = { callExportAsCore: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    expect(await runConsent(registry, mission, ctx, 'voice.say')).toBe(true);
    expect(registry.callExportAsCore).toHaveBeenCalledWith('digest', 'consent_for_run', { tool: 'voice.say', export: 'material', args: { slot: 'late' } }, ctx);
    // The owner turned it off since: the next call is refused.
    expect(await runConsent(registry, mission, ctx, 'voice.say')).toBe(false);
  });

  it('vouches for nothing without a context or for a malformed tool name', async () => {
    const registry = { callExportAsCore: vi.fn() };
    expect(await runConsent(registry, {}, ctx, 'voice.say')).toBe(false);
    expect(await runConsent(registry, { context: null }, ctx, 'voice.say')).toBe(false);
    expect(await runConsent(registry, mission, ctx, 'not a tool')).toBe(false);
    expect(registry.callExportAsCore).not.toHaveBeenCalled();
  });

  it('fails closed: a missing export, an error, or any answer but true', async () => {
    const registry = {
      callExportAsCore: vi.fn()
        .mockRejectedValueOnce(new Error('digest exports no "consent_for_run"'))
        .mockResolvedValueOnce({ enabled: true })
        .mockResolvedValueOnce('true')
        .mockResolvedValueOnce(1),
    };
    for (let i = 0; i < 4; i += 1) expect(await runConsent(registry, mission, ctx, 'voice.say')).toBe(false);
  });
});
