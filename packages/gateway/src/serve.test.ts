import { describe, expect, it } from 'vitest';
import type { Mission } from '@buddi/core';
import { UNATTENDED_JOB_KINDS } from '@buddi/core';
import { formatMissionLine, idleLoops, JOB_KINDS, STALE_CLAIM_MS, TICK_MS } from './serve.js';

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

  /**
   * Core names the unattended kinds as strings because it may not import the
   * gateway that defines them. This is the check that keeps the two honest: a
   * new kind added here without being classified there would silently get the
   * interactive six-minute horizon and no dead-letter alert.
   */
  it('classifies every kind this process runs as unattended work', () => {
    expect([...JOB_KINDS].sort()).toEqual([...UNATTENDED_JOB_KINDS].sort());
  });
});

/**
 * Recovery mode's stand-ins.
 *
 * `main` waits on `done` and ends the pool afterwards, so a stand-in that
 * resolves `done` on its own ends the database under a dashboard that is still
 * serving — which is how a restored installation came up answering 500 on the
 * very checklist recovery exists for.
 */
describe('the loops recovery mode starts instead', () => {
  /** Did it finish within a beat? A timer, because "never" has no other proof. */
  const settled = (done: Promise<void>): Promise<boolean> =>
    Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

  it('keeps the process alive until it is stopped', async () => {
    const idle = idleLoops();
    expect(await settled(idle.scheduler.done)).toBe(false);
    expect(await settled(idle.worker.done)).toBe(false);

    // What shutdown does, and the only thing that ends the wait.
    await idle.scheduler.stop();
    expect(await settled(idle.worker.done)).toBe(true);
    await expect(Promise.all([idle.scheduler.done, idle.worker.done])).resolves.toBeDefined();
  });

  it('does no work while it stands in', async () => {
    const idle = idleLoops();
    expect(await idle.scheduler.tick()).toEqual({ materialized: 0, executed: 0 });
    expect(await idle.worker.tick()).toBeNull();
    expect(await idle.worker.recover()).toBe(0);
    expect(await idle.loop.tick()).toBe('skipped');
    await idle.worker.stop();
  });
});
