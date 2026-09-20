import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { inspectCluster, watchDatabase } from './cluster.js';
import type { OccupancyChecks, PortIdentity } from './cluster.js';

/** A cluster directory with the pid file a previous postmaster would have left. */
async function fakeCluster(pid: number, port: number): Promise<string> {
  const cluster = path.join(await mkdtemp(path.join(os.tmpdir(), 'buddi-cluster-')), 'postgres');
  await mkdir(cluster, { recursive: true });
  await writeFile(path.join(cluster, 'postmaster.pid'), `${pid}\n${cluster}\n1789900000\n${port}\n\n127.0.0.1\n  5432001   0\nready\n`);
  return cluster;
}

/** A fake pg_ctl that reports a running server, and seams that say nothing is there. */
function checks(overrides: Partial<OccupancyChecks> = {}): OccupancyChecks {
  return {
    status: async () => true,
    identity: async () => 'unreachable' as PortIdentity,
    command: async () => undefined,
    ...overrides,
  };
}

describe('what a postmaster.pid is believed to mean', () => {
  test('no pid file, no claim: pg_ctl reporting nothing leaves the cluster free', async () => {
    const cluster = await fakeCluster(4242, 46595);
    expect(await inspectCluster(cluster, checks({ status: async () => false }))).toBe('free');
  });

  test('a pid file whose port answers for this very cluster is a real orphan', async () => {
    const cluster = await fakeCluster(4242, 46595);
    const ports: number[] = [];
    const occupancy = await inspectCluster(cluster, checks({ identity: async port => { ports.push(port); return 'ours'; } }));
    expect(occupancy).toBe('orphan');
    expect(ports).toEqual([46595]);
  });

  test('a server that answers without saying whose it is stays an orphan: ambiguity deletes nothing', async () => {
    const cluster = await fakeCluster(4242, 46595);
    expect(await inspectCluster(cluster, checks({ identity: async () => 'unknown' }))).toBe('orphan');
  });

  test('a dead port but a pid the OS calls postgres is a real orphan', async () => {
    const cluster = await fakeCluster(4242, 46595);
    expect(await inspectCluster(cluster, checks({ command: async () => 'postgres' }))).toBe('orphan');
  });

  test('a pid that is some other live process, on a port nothing answers, is a stale file', async () => {
    const cluster = await fakeCluster(17, 46595);
    // Exactly the container case: pids restart small, so 17 exists again and is
    // not ours, and the recorded port belongs to nobody.
    expect(await inspectCluster(cluster, checks({ command: async () => 'node' }))).toBe('stale');
  });

  test('a port taken over by a different cluster does not make this pid file live', async () => {
    const cluster = await fakeCluster(17, 46595);
    expect(await inspectCluster(cluster, checks({ identity: async () => 'other' }))).toBe('stale');
  });
});

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
