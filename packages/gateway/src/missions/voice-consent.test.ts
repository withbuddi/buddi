import { describe, expect, it, vi } from 'vitest';
import type { CoreToolContext, Mission } from '@buddi/core';
import { editionVoiceConsent } from './voice-consent.js';
const ctx = {} as CoreToolContext;
const mission = { context: { plugin: 'news', export: 'edition_material', args: { edition: 'evening' } } } satisfies Pick<Mission, 'context'>;
describe('owner-configured edition voice consent', () => {
  it('rechecks the saved choice, including revocation, for the exact edition', async () => {
    const registry = { callExportAsCore: vi.fn().mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce({ enabled: false }) };
    expect(await editionVoiceConsent(registry, mission, ctx, 'speech.say')).toBe(true);
    expect(registry.callExportAsCore).toHaveBeenCalledWith('news', 'edition_voice', { edition: 'evening' }, ctx);
    expect(await editionVoiceConsent(registry, mission, ctx, 'speech.say')).toBe(false);
  });
  it('does not authorize another tool, an ordinary run, or forged material', async () => {
    const registry = { callExportAsCore: vi.fn() };
    expect(await editionVoiceConsent(registry, mission, ctx, 'speech.transcribe')).toBe(false);
    expect(await editionVoiceConsent(registry, {}, ctx, 'speech.say')).toBe(false);
    expect(await editionVoiceConsent(registry, { context: { plugin: 'other', export: 'edition_material', args: { edition: 'evening', voice: true } } }, ctx, 'speech.say')).toBe(false);
    expect(registry.callExportAsCore).not.toHaveBeenCalled();
  });
  it('fails closed for missing exports and malformed settings', async () => {
    const registry = { callExportAsCore: vi.fn().mockRejectedValueOnce(Error('unavailable')).mockResolvedValueOnce({ enabled: 'true' }) };
    expect(await editionVoiceConsent(registry, mission, ctx, 'speech.say')).toBe(false);
    expect(await editionVoiceConsent(registry, mission, ctx, 'speech.say')).toBe(false);
  });
});
