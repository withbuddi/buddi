import { describe, expect, it } from 'vitest';
import { BAR_AFTER_MS, OWNER_WAIT_MS, waitForOwner, type BarChoice, type WaitProbes } from './bar.js';

/** Probes over a fake clock: `watchedFor` ms of the owner looking, then a tap at `tapAt`. */
function probes(opts: { watchedFor?: number; tapAt?: number; tap?: BarChoice } = {}) {
  let clock = 0;
  const calls: string[] = [];
  const probe: WaitProbes = {
    watched: async () => clock < (opts.watchedFor ?? Infinity),
    show: async () => { calls.push(`show@${clock}`); },
    hide: async () => { calls.push(`hide@${clock}`); },
    choice: async () => (opts.tapAt !== undefined && clock >= opts.tapAt ? opts.tap : undefined),
    wait: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { probe, calls, time: () => clock };
}

describe('the in-tab bar protocol', () => {
  it('a tab the owner is not looking at goes ahead at once, with no bar', async () => {
    const { probe, calls } = probes({ watchedFor: 0 });
    await expect(waitForOwner(probe)).resolves.toBe('left');
    expect(calls).toEqual([]);
  });
  it('the owner leaving within 3 s needs no bar', async () => {
    const { probe, calls } = probes({ watchedFor: 1_500 });
    await expect(waitForOwner(probe)).resolves.toBe('left');
    expect(calls).toEqual([]);
  });
  it('after 3 s the bar appears; Let it continue and Take over come back as the answer, and the bar goes', async () => {
    const go = probes({ tapAt: 5_000, tap: 'continue' });
    await expect(waitForOwner(go.probe)).resolves.toBe('continue');
    expect(go.calls).toEqual([`show@${BAR_AFTER_MS}`, 'hide@5000']);
    const take = probes({ tapAt: 4_000, tap: 'takeover' });
    await expect(waitForOwner(take.probe)).resolves.toBe('takeover');
  });
  it('waits thirty seconds at most, then says so; the bar never outlives the wait', async () => {
    const { probe, calls, time } = probes();
    await expect(waitForOwner(probe)).resolves.toBe('timeout');
    expect(time()).toBe(OWNER_WAIT_MS);
    expect(calls.at(-1)).toBe(`hide@${OWNER_WAIT_MS}`);
  });
});
