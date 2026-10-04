/** Uninstall from the product, against a fake machine: nothing is moved, written or spawned for real. */
import { describe, expect, it } from 'vitest';
import { createProductUninstall, PASSPHRASE_HELD_MS } from './product-uninstall.js';
import type { ProductUninstallDeps } from './product-uninstall.js';

const home = '/Users/owner';
const data = '/Users/owner/Library/Application Support/buddi';
const NAME = 'buddi-backup-20261004-100000.tar.gz.age';

function machine(over: Partial<ProductUninstallDeps> & { backupFails?: string } = {}) {
  const moved: Array<[string, string]> = [];
  const written = new Map<string, string>();
  const spawned: Array<{ args: string[]; log: string }> = [];
  const requests: Array<{ keepData: boolean }> = [];
  let exited = 0;
  const files = new Set([`${data}/backups/${NAME.replace(/\.age$/, '.json')}`]);
  const deps: ProductUninstallDeps = {
    data, home,
    plan: () => ({ data, keychain: 'buddi.install.abc', backups: `${home}/buddi-backups`, appFinishes: false }),
    backup: {
      dir: `${data}/backups`,
      create: () => ({ id: 'b1' }),
      job: () => (over.backupFails
        ? { phase: 'failed', error: over.backupFails, finishedAt: 'now' }
        : { phase: 'done', finishedAt: 'now', report: { archive: NAME } }),
      passphrase: async () => 'able acid actor adult afraid agent',
    },
    exists: (file) => files.has(file),
    move: async (from, to) => { moved.push([from, to]); },
    writePrivate: async (file, text) => { written.set(file, text); },
    appFinishes: false,
    writeRequest: async (request) => { requests.push(request); },
    exitForApp: () => { exited++; },
    spawnUninstall: (args, log) => { spawned.push({ args, log }); },
    sleep: async () => {},
    now: () => new Date('2026-10-04T10:00:00Z'),
    ...over,
  };
  return { uninstall: createProductUninstall(deps), moved, written, spawned, requests, exited: () => exited };
}

async function finished(m: ReturnType<typeof machine>, id: string) {
  for (let i = 0; i < 50; i++) {
    const job = m.uninstall.job(id);
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the job never finished');
}

describe('uninstall from the product', () => {
  it('takes the last backup, moves it and its envelope to ~/buddi-backups, and writes the passphrase file beside it', async () => {
    const m = machine();
    const started = m.uninstall.keepLast();
    if ('status' in started) throw new Error(started.error);
    const job = await finished(m, started.id);
    expect(job.phase).toBe('done');
    expect(m.moved).toEqual([
      [`${data}/backups/${NAME}`, `${home}/buddi-backups/${NAME}`],
      [`${data}/backups/buddi-backup-20261004-100000.tar.gz.json`, `${home}/buddi-backups/buddi-backup-20261004-100000.tar.gz.json`],
    ]);
    expect([...m.written.keys()]).toEqual([`${home}/buddi-backups/${NAME}.passphrase.txt`]);
    expect(job.report).toEqual({ archive: `${home}/buddi-backups/${NAME}`, passphraseFile: `${home}/buddi-backups/${NAME}.passphrase.txt`, passphrase: 'able acid actor adult afraid agent' });
  });

  it('removes nothing before the last backup was taken', () => {
    const m = machine();
    expect(m.uninstall.start({ keepData: false })).toMatchObject({ status: 409, error: expect.stringMatching(/last backup first/) });
    expect(m.spawned).toEqual([]);
    expect(m.requests).toEqual([]);
  });

  it('removes nothing when the backup failed', async () => {
    const m = machine({ backupFails: 'disk full' });
    const started = m.uninstall.keepLast();
    if ('status' in started) throw new Error(started.error);
    const job = await finished(m, started.id);
    expect(job).toMatchObject({ phase: 'failed', error: expect.stringMatching(/disk full/) });
    expect(m.uninstall.start({ keepData: false }).status).toBe(409);
  });

  it('npm: runs buddi uninstall detached, with the backup and the words already taken care of', async () => {
    const m = machine();
    const started = m.uninstall.keepLast();
    if ('status' in started) throw new Error(started.error);
    await finished(m, started.id);
    expect(m.uninstall.start({ keepData: true })).toEqual({ status: 202 });
    expect(m.spawned).toEqual([{
      args: ['uninstall', '--yes', '--no-backup', '--i-have-the-passphrase', '--keep-data'],
      log: `${home}/buddi-backups/uninstall-20261004-100000.log`,
    }]);
    // Twice is once.
    expect(m.uninstall.start({ keepData: true }).status).toBe(409);
    expect(m.spawned).toHaveLength(1);
  });

  it('buddi.app: writes the request and leaves for the app to finish', async () => {
    const m = machine({ appFinishes: true });
    const started = m.uninstall.keepLast();
    if ('status' in started) throw new Error(started.error);
    await finished(m, started.id);
    expect(m.uninstall.start({ keepData: false })).toEqual({ status: 202 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(m.requests).toEqual([{ keepData: false, at: '2026-10-04T10:00:00.000Z' }]);
    expect(m.exited()).toBe(1);
    expect(m.spawned).toEqual([]);
  });

  it('holds the six words only while the page needs them: dropped on start, on a new plan, or after 30 minutes', async () => {
    const PHRASE = 'able acid actor adult afraid agent';
    // On start.
    const a = machine();
    const one = a.uninstall.keepLast();
    if ('status' in one) throw new Error(one.error);
    expect((await finished(a, one.id)).report?.passphrase).toBe(PHRASE);
    a.uninstall.start({ keepData: false });
    expect(a.uninstall.job(one.id)?.report).toEqual({ archive: `${home}/buddi-backups/${NAME}`, passphraseFile: `${home}/buddi-backups/${NAME}.passphrase.txt` });
    // On a new plan (the dialog cancelled and opened again): the backup still counts.
    const b = machine();
    const two = b.uninstall.keepLast();
    if ('status' in two) throw new Error(two.error);
    await finished(b, two.id);
    b.uninstall.plan();
    expect(b.uninstall.job(two.id)?.report?.passphrase).toBeUndefined();
    expect(b.uninstall.start({ keepData: false })).toEqual({ status: 202 });
    // After the hold.
    let clock = new Date('2026-10-04T10:00:00Z');
    const c = machine({ now: () => clock });
    const three = c.uninstall.keepLast();
    if ('status' in three) throw new Error(three.error);
    expect((await finished(c, three.id)).report?.passphrase).toBe(PHRASE);
    clock = new Date(clock.getTime() + PASSPHRASE_HELD_MS - 1);
    expect(c.uninstall.job(three.id)?.report?.passphrase).toBe(PHRASE);
    clock = new Date(clock.getTime() + 1);
    expect(c.uninstall.job(three.id)?.report?.passphrase).toBeUndefined();
  });
});
