import type { PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { ownerFollowingDeclarations } from './zone-provenance.js';

describe('ownerFollowingDeclarations', () => {
  it('names what buddi made without a zone, and leaves out a suggestion that names one', () => {
    const manifest = {
      name: 'finance',
      version: '1.0.0',
      missions: [
        { id: 'friday-recap', name: 'Recap', cron: '0 17 * * FRI', prompt: 'p' },
        { id: 'ny-open', name: 'Open', cron: '30 9 * * 1-5', timezone: 'America/New_York', prompt: 'p' },
      ],
      agents: [{ id: 'ledger', missions: [{ id: 'daily-check', name: 'Daily check', cron: '0 9 * * *', prompt: 'p' }] }],
    } as unknown as PluginManifest;
    const ids = ownerFollowingDeclarations([manifest], ['ledger']).map((d) => `${d.missionId} ${d.cron}`);
    expect(ids).toContain('learning-digest null');
    expect(ids).toContain('getting-started 30 9 * * *');
    expect(ids).toContain('friday-recap 0 17 * * FRI');
    expect(ids).toContain('agent:ledger:daily-check 0 9 * * *');
    expect(ids.some((d) => d.startsWith('ny-open'))).toBe(false);
  });
});
