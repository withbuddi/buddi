import { describe, expect, test } from 'vitest';
import { watchDatabase } from './postgres.js';

describe('the managed database monitor', () => {
  test('adopted database is watched without a child exit event', async () => {
    let probes = 0;
    const monitor = watchDatabase(async () => { probes++; throw new Error('down'); }, { interval: 1, failures: 2 });
    await monitor.exited;
    expect(monitor.alive).toBe(false); expect(probes).toBe(2);
    monitor.stop();
  });

  test('database probe failures must be consecutive and probes are serialized', async () => {
    let probes = 0, inFlight = 0;
    const monitor = watchDatabase(async () => {
      expect(++inFlight).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 2)); inFlight--;
      probes++;
      if (probes !== 2) throw new Error('down');
    }, { interval: 1, failures: 2 });
    await monitor.exited; monitor.stop();
    expect(probes).toBe(4);
  });

  test('stopping a monitor cancels future probes', async () => {
    let probes = 0;
    const monitor = watchDatabase(async () => { probes++; }, { interval: 1 });
    monitor.stop(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(probes).toBe(0);
  });
});
