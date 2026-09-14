import { describe, expect, it } from 'vitest';
import type { Mission } from '@buddi/core';
import { formatMissionLine, STALE_CLAIM_MS, TICK_MS } from './serve.js';

const mission: Mission = {
  id: 'friday-recap',
  name: 'Friday recap',
  agentId: 'finance-advisor',
  prompt: 'recap',
  enabled: true,
  alwaysDeliver: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

describe('formatMissionLine', () => {
  it('shows the cron, the zone and the next instant', () => {
    const line = formatMissionLine({
      mission,
      cron: '0 8 * * FRI',
      timezone: 'America/New_York',
      next: new Date('2026-09-18T12:00:00Z'),
    });
    expect(line).toContain('friday-recap (finance-advisor)');
    expect(line).toContain('0 8 * * FRI America/New_York');
    expect(line).toContain('next 2026-09-18T12:00:00.000Z');
  });

  it('says so when a mission has no schedule', () => {
    expect(formatMissionLine({ mission })).toContain('no schedule');
  });

  it('marks a disabled mission and computes no next instant', () => {
    const line = formatMissionLine({
      mission: { ...mission, enabled: false },
      cron: '0 8 * * FRI',
      timezone: 'America/New_York',
      next: null,
    });
    expect(line).toContain('[disabled]');
    expect(line).toContain('next (disabled)');
  });
});

describe('serve cadence', () => {
  it('ticks every 30s and releases claims older than 15 minutes', () => {
    expect(TICK_MS).toBe(30_000);
    expect(STALE_CLAIM_MS).toBe(900_000);
  });
});
