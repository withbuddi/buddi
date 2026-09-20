import { describe, expect, test } from 'vitest';
import { watchDatabase } from './cluster.js';

describe('the managed database monitor', () => {
  test('a database that stops answering is declared gone without a child exit event', async () => {
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

  test('a monitor stopped mid-probe neither reschedules nor declares the database gone', async () => {
    let probes = 0, gone = false;
    let entered!: () => void, release!: () => void;
    const inProbe = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const monitor = watchDatabase(async () => { probes++; entered(); await blocked; throw new Error('down'); }, { interval: 1, failures: 1 });
    void monitor.exited.then(() => { gone = true; });
    await inProbe;
    monitor.stop(); release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(probes).toBe(1); expect(gone).toBe(false); expect(monitor.alive).toBe(true);
  });

  test('stopping a monitor cancels future probes', async () => {
    let probes = 0;
    const monitor = watchDatabase(async () => { probes++; }, { interval: 1 });
    monitor.stop(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(probes).toBe(0);
  });
});
