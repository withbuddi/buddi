/**
 * The independent loop, driven by hand: no timers, no sleeping.
 *
 * What is under test is the property that made the loop necessary — a slow poll
 * must never accumulate overlapping runs, and must never own the loop forever.
 */
import { describe, expect, it } from 'vitest';
import { startLoop } from './loop.js';

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('startLoop', () => {
  it('skips a tick while the previous run is still going, and says so', async () => {
    const logged: string[] = [];
    let clock = 1_000;
    const gate = deferred();
    let starts = 0;

    const loop = startLoop({
      name: 'sources',
      everyMs: 30_000,
      autoStart: false,
      now: () => clock,
      log: (line) => logged.push(line),
      run: async () => {
        starts += 1;
        await gate.promise;
      },
    });

    const first = loop.tick();
    expect(loop.busy).toBe(true);
    expect(starts).toBe(1);

    clock += 30_000;
    expect(await loop.tick()).toBe('skipped');
    clock += 5_000;
    expect(await loop.tick()).toBe('skipped');
    // Still exactly one run in flight — no pile-up.
    expect(starts).toBe(1);
    expect(logged).toEqual([
      'sources: poll still running (30000ms elapsed) — skipping this tick',
      'sources: poll still running (35000ms elapsed) — skipping this tick',
    ]);

    gate.resolve();
    await first;
    expect(loop.busy).toBe(false);

    // And once it finishes, the loop is free again.
    clock += 30_000;
    expect(await loop.tick()).toBe('ran');
    expect(starts).toBe(2);
    loop.stop();
  });

  it('abandons a run that outlives the hard abort and starts a fresh one', async () => {
    const logged: string[] = [];
    let clock = 0;
    const stuck = deferred();
    let starts = 0;

    const loop = startLoop({
      name: 'sources',
      everyMs: 30_000,
      abortAfterMs: 90_000,
      autoStart: false,
      now: () => clock,
      log: (line) => logged.push(line),
      run: async () => {
        starts += 1;
        if (starts === 1) await stuck.promise;
      },
    });

    const wedged = loop.tick();
    clock = 60_000;
    expect(await loop.tick()).toBe('skipped');

    clock = 95_000;
    expect(await loop.tick()).toBe('abandoned');
    expect(starts).toBe(2);
    expect(logged.at(-1)).toContain('hard abort at 90000ms');

    // The abandoned run finishing late must not release the newer run's claim
    // on the loop — and by now the newer run has already finished, so the loop
    // is idle rather than wrongly marked busy.
    stuck.resolve();
    await wedged;
    expect(loop.busy).toBe(false);
    loop.stop();
  });

  it('logs a failing run and stays alive', async () => {
    const logged: string[] = [];
    let calls = 0;
    const loop = startLoop({
      name: 'sentinels',
      everyMs: 1_000,
      autoStart: false,
      log: (line) => logged.push(line),
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('imap select timed out after 45000ms');
      },
    });

    expect(await loop.tick()).toBe('ran');
    expect(logged).toEqual(['sentinels: imap select timed out after 45000ms']);
    expect(loop.busy).toBe(false);
    expect(await loop.tick()).toBe('ran');
    expect(calls).toBe(2);
    loop.stop();
  });
});
