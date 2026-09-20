/**
 * The backup half of the control socket, and the pure decisions behind it.
 *
 * Nothing here starts a supervisor, opens a database or writes an archive: the
 * socket is served with a fake `BackupControl`, so what is under test is
 * exactly what the socket itself decides — which names it will accept, which
 * paths, what a bad schedule is answered with, and that a passphrase is
 * normalized before it is stored. The engine is tested in `@buddi/core`.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  backupDue,
  createBackupService,
  sweepIncoming,
  incomingDir,
  isIncomingPath,
  isSafeArchiveName,
  parseSchedule,
  readSchedule,
  writeSchedule,
  JobStore,
  type BackupControl,
  type BackupJob,
  type ScheduleFile,
} from './backup.js';
import { controlSocket, listenOnSocket, supervisorSocket, type SupervisorStatus } from './supervisor.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const STATUS: SupervisorStatus = {
  phase: 'ready', supervisorPid: 1, installRoot: '/install', nodePath: '/node',
  database: 'running', databasePid: 2, gateway: 'running', gatewayPid: 3,
};

function call(socket: string, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, method, headers: {
      host: 'localhost',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

function job(kind: BackupJob['kind'], phase = 'starting'): BackupJob {
  return { id: '11111111-2222-3333-4444-555555555555', kind, phase, phases: [phase], startedAt: '2026-01-01T00:00:00.000Z' };
}

/** A supervisor's backup half, as far as the socket can tell. */
function fakeControl(): { control: BackupControl; seen: unknown[] } {
  const seen: unknown[] = [];
  const control: BackupControl = {
    dir: '/data/backups',
    list: async () => ({ dir: '/data/backups', database: 'buddi', archives: [] }),
    create: (encrypt) => { seen.push({ create: encrypt }); return job('backup'); },
    verify: (name) => { seen.push({ verify: name }); return job('verify'); },
    restore: async (input) => { seen.push({ restore: input }); return job('restore', 'stopping'); },
    job: (id) => (id === job('backup').id ? job('backup', 'done') : undefined),
    schedule: async () => ({ ...DEFAULT_SCHEDULE }),
    setSchedule: async (next) => { seen.push({ schedule: next }); return { schedule: { ...next, lastRunAt: null } }; },
    passphrase: async () => 'able acid actor adult afraid agent',
    setPassphrase: async (value) => { seen.push({ passphrase: value }); },
    lastBackupAt: async () => '2026-01-01T03:30:00.000Z',
    inRecovery: async () => true,
    busy: () => false,
    tick: async () => {},
  };
  return { control, seen };
}

async function serve(): Promise<{ socket: string; data: string; seen: unknown[] }> {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-backup-socket-'));
  const socket = supervisorSocket(data);
  const { control, seen } = fakeControl();
  const server = controlSocket({ status: () => STATUS, action: vi.fn(async () => {}), backup: control, data });
  servers.push(server);
  await listenOnSocket(server, socket);
  return { socket, data, seen };
}

describe('the control socket, backup half', () => {
  test('status gains the two facts a restored installation has', async () => {
    const { socket } = await serve();
    const status = await call(socket, '/status');
    expect(status.body).toMatchObject({ ...STATUS, recovery: true, lastBackupAt: '2026-01-01T03:30:00.000Z' });
  });

  test('takes a name from its own listing and nothing that could be a path', async () => {
    const { socket, seen } = await serve();
    const good = await call(socket, '/verify', 'POST', { name: 'buddi-backup-20260101-033000.tar.gz.age' });
    expect(good.status).toBe(202);
    expect(good.body.job.kind).toBe('verify');

    for (const name of [
      '../../etc/passwd',
      '/etc/passwd',
      'backups/buddi-backup-20260101-033000.tar.gz',
      '..',
      '.env',
      'anything.tar.gz',
      42,
      null,
    ]) {
      const refused = await call(socket, '/verify', 'POST', { name });
      expect(refused.status, String(name)).toBe(400);
    }
    expect(seen).toEqual([{ verify: 'buddi-backup-20260101-033000.tar.gz.age' }]);
  });

  test('a restore names one archive: a listed name, or an upload buddi itself received', async () => {
    const { socket, data, seen } = await serve();
    expect((await call(socket, '/restore', 'POST', {})).status).toBe(400);
    expect((await call(socket, '/restore', 'POST', { name: 'a.tar.gz', path: '/tmp/a' })).status).toBe(400);
    // A path outside `<data>/incoming/` is the whole reason this check exists.
    for (const given of ['/etc/passwd', path.join(data, 'backups', 'x.tar.gz'), `${incomingDir(data)}-evil/x.tar.gz`]) {
      expect((await call(socket, '/restore', 'POST', { path: given })).status, given).toBe(400);
    }
    const inside = path.join(incomingDir(data), 'upload-1.tar.gz');
    const accepted = await call(socket, '/restore', 'POST', { path: inside, passphrase: '  able  acid ', confirm: 'buddi' });
    expect(accepted.status).toBe(202);
    expect(accepted.body.job.phase).toBe('stopping');
    expect(seen.at(-1)).toEqual({ restore: { path: inside, passphrase: '  able  acid ', confirm: 'buddi' } });
  });

  test('a schedule is refused in the words the owner reads under the field', async () => {
    const { socket, seen } = await serve();
    expect((await call(socket, '/schedule')).body).toEqual(DEFAULT_SCHEDULE);
    for (const body of [
      { enabled: 'yes', time: '03:30', keep: 14, encryptLocal: true, copyTo: null },
      { enabled: true, time: '25:00', keep: 14, encryptLocal: true, copyTo: null },
      { enabled: true, time: '3:30', keep: 14, encryptLocal: true, copyTo: null },
      { enabled: true, time: '03:30', keep: 0, encryptLocal: true, copyTo: null },
      { enabled: true, time: '03:30', keep: 14, encryptLocal: true, copyTo: 'relative/path' },
    ]) {
      const refused = await call(socket, '/schedule', 'PUT', body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(typeof refused.body.error).toBe('string');
    }
    const saved = await call(socket, '/schedule', 'PUT', { enabled: true, time: '23:05', keep: 3, encryptLocal: false, copyTo: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ enabled: true, time: '23:05', keep: 3, encryptLocal: false, copyTo: null, lastRunAt: null });
    expect(seen.at(-1)).toEqual({ schedule: { enabled: true, time: '23:05', keep: 3, encryptLocal: false, copyTo: null } });
  });

  test('the passphrase is readable on an owner-only socket, and never stored empty', async () => {
    const { socket, seen } = await serve();
    expect((await call(socket, '/passphrase')).body).toEqual({ passphrase: 'able acid actor adult afraid agent' });
    expect((await call(socket, '/passphrase', 'PUT', { passphrase: '   ' })).status).toBe(400);
    expect((await call(socket, '/passphrase', 'PUT', { passphrase: 7 })).status).toBe(400);
    expect((await call(socket, '/passphrase', 'PUT', { passphrase: 'able  acid ' })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ passphrase: 'able  acid ' });
  });

  test('a job is looked up by its id, and an unknown id is not an error page', async () => {
    const { socket } = await serve();
    const found = await call(socket, `/jobs/${job('backup').id}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ kind: 'backup', phase: 'done' });
    expect((await call(socket, '/jobs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await call(socket, '/jobs/not-a-uuid')).status).toBe(404);
  });

  test('a supervisor with no installation to back up serves none of it', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-backup-socket-'));
    const socket = supervisorSocket(data);
    const server = controlSocket({ status: () => STATUS, action: async () => {} });
    servers.push(server);
    await listenOnSocket(server, socket);
    expect((await call(socket, '/status')).body).toEqual(STATUS);
    for (const [route, method] of [['/backups', 'GET'], ['/backup', 'POST'], ['/schedule', 'GET'], ['/passphrase', 'GET']] as const) {
      expect((await call(socket, route, method, method === 'POST' ? {} : undefined)).status).toBe(404);
    }
  });
});

describe('what a name and a path may be', () => {
  test('only a name this installation could have written', () => {
    expect(isSafeArchiveName('buddi-backup-20260101-033000.tar.gz')).toBe(true);
    expect(isSafeArchiveName('pre-restore-20260101-033000.tar.gz.age')).toBe(true);
    for (const bad of ['../x.tar.gz', 'a/b.tar.gz', 'a\\b.tar.gz', '.hidden.tar.gz', 'x.tar.gz\0', '', undefined]) {
      expect(isSafeArchiveName(bad), String(bad)).toBe(false);
    }
  });

  test('only a path inside `<data>/incoming/`', () => {
    const data = '/data';
    expect(isIncomingPath(data, '/data/incoming/upload-1.tar.gz')).toBe(true);
    expect(isIncomingPath(data, '/data/incoming/nested/upload.tar.gz')).toBe(true);
    // A sibling whose name merely starts the same way is not inside it.
    expect(isIncomingPath(data, '/data/incoming-evil/upload.tar.gz')).toBe(false);
    expect(isIncomingPath(data, '/data/incoming')).toBe(false);
    expect(isIncomingPath(data, '/data/backups/x.tar.gz')).toBe(false);
    expect(isIncomingPath(data, '/data/incoming/../backups/x.tar.gz')).toBe(false);
  });
});

describe('the schedule', () => {
  test('is read back as it was written, and a corrupt file is the default', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-schedule-'));
    expect(await readSchedule(data)).toEqual(DEFAULT_SCHEDULE);
    const file: ScheduleFile = { enabled: true, time: '01:15', keep: 2, encryptLocal: false, copyTo: null, lastRunAt: '2026-01-01T01:15:00.000Z' };
    await writeSchedule(data, file);
    expect(await readSchedule(data)).toEqual(file);
    await writeFile(path.join(data, 'backup.json'), 'not json');
    expect(await readSchedule(data)).toEqual(DEFAULT_SCHEDULE);
  });

  test('is due once the local clock has crossed the time, and once a day', () => {
    const base: ScheduleFile = { ...DEFAULT_SCHEDULE, enabled: true, time: '03:30' };
    const at = (h: number, m: number, day = 2): Date => new Date(2026, 0, day, h, m, 0, 0);
    expect(backupDue({ ...base, enabled: false }, at(4, 0))).toBe(false);
    expect(backupDue(base, at(3, 29))).toBe(false);
    expect(backupDue(base, at(3, 30))).toBe(true);
    // A laptop that was asleep at 03:30 takes it when it wakes.
    expect(backupDue(base, at(11, 0))).toBe(true);
    const ranToday = { ...base, lastRunAt: at(3, 31).toISOString() };
    expect(backupDue(ranToday, at(11, 0))).toBe(false);
    expect(backupDue(ranToday, at(3, 30, 3))).toBe(true);
    expect(backupDue({ ...base, lastRunAt: 'nonsense' }, at(4, 0))).toBe(true);
  });

  test('parses a whole schedule or says which field is wrong', () => {
    expect(parseSchedule({ enabled: true, time: '03:30', keep: 7, encryptLocal: true, copyTo: '/tmp' }))
      .toEqual({ schedule: { enabled: true, time: '03:30', keep: 7, encryptLocal: true, copyTo: '/tmp' } });
    expect(parseSchedule(null)).toHaveProperty('error');
    expect(parseSchedule([])).toHaveProperty('error');
  });
});

describe('the job store', () => {
  test('records every phase in order and keeps the last twenty jobs', () => {
    const store = new JobStore(3);
    const first = store.start('restore');
    for (const phase of ['stopping', 'snapshot', 'database', 'files', 'recovery', 'starting']) {
      store.phase(first, phase, `${phase}…`);
    }
    // A repeated phase is not a second entry: the engine reports progress
    // within a phase more than once.
    store.phase(first, 'starting', 'again');
    store.finish(first, 'done', { report: { ok: true } });
    expect(first.phases).toEqual(['starting', 'stopping', 'snapshot', 'database', 'files', 'recovery', 'starting', 'done']);
    expect(first.phase).toBe('done');
    expect(first.finishedAt).toBeTypeOf('string');

    const ids = [first.id, store.start('backup').id, store.start('backup').id, store.start('backup').id];
    expect(store.get(ids[0]!)).toBeUndefined();
    expect(store.list()).toHaveLength(3);
  });

  test('a failed restore says rolled-back and carries the reason', () => {
    const store = new JobStore();
    const restore = store.start('restore');
    store.phase(restore, 'stopping');
    store.finish(restore, 'rolled-back', { error: 'the artifacts directory is read-only' });
    expect(restore.phase).toBe('rolled-back');
    expect(restore.error).toBe('the artifacts directory is read-only');
  });
});

/* ------------------------------------------------------------------ *
 * The service itself
 * ------------------------------------------------------------------ */

/**
 * A `Core` and a `Gateway` as far as a restore can tell.
 *
 * Neither package is imported here: the service takes both as arguments
 * precisely so the supervisor can hand it the ones it loaded after rewriting
 * the environment, and that is what makes it testable without a database, an
 * archive or a gateway process. Only the members a restore touches are
 * answered; anything else would be a test of `@buddi/core`.
 */
function fakeWorld(restore: (opts: any) => Promise<any>, recover?: () => Promise<void>) {
  const calls: string[] = [];
  const pool = {
    query: async () => { throw new Error('no schema'); },
    end: async () => {},
  };
  const core = {
    CORE_SCHEMA: 'core',
    CORE_MIGRATIONS_DIR: '/migrations',
    timezoneFromEnv: () => 'UTC',
    createVault: () => undefined,
    pluginsFilePath: () => '/nowhere/plugins.json',
    readPluginsFile: () => { throw new Error('none'); },
    databaseIn: () => 'buddi',
    normalizePassphrase: (value: string) => value.trim().replace(/\s+/g, ' '),
    createPool: () => pool,
    envelopePath: (file: string) => `${file}.json`,
    verifyEnvelope: async () => ({ ok: true }),
    countPending: async () => ({ jobs: 0, missions: 0, approvals: 0, telegramChats: 0 }),
    enterRecovery: async () => { calls.push('enterRecovery'); if (recover) await recover(); },
    inRecovery: async () => false,
    restoreBackup: async (opts: any) => { calls.push('restoreBackup'); return restore(opts); },
  };
  const gateway = {
    agentSearchPath: () => ({ ownerRoot: '/owner', owner: { dir: '/owner/agents', skillsDir: '/owner/skills' } }),
    installedManifests: () => [],
  };
  return { core, gateway, calls };
}

function report(over: Record<string, unknown> = {}) {
  return { ok: true, did: [], didNot: [], next: [], manifest: null, snapshot: null, rolledBack: false, database: null, ...over };
}

/**
 * The engine, as far as the service is concerned.
 *
 * It runs the caller's `afterDatabase` where the real one does — inside the
 * region the snapshot covers — and rolls back when it throws, which is the
 * whole contract the supervisor is relying on for the recovery row.
 */
function engine(over: Record<string, unknown> = {}) {
  return async (opts: any) => {
    try {
      if (opts.afterDatabase) await opts.afterDatabase({});
    } catch (err) {
      return report({ ok: false, didNot: [`the restore failed: ${(err as Error).message}`], rolledBack: true, ...over });
    }
    return report(over);
  };
}

async function settled(control: BackupControl, id: string): Promise<BackupJob> {
  for (let i = 0; i < 200; i += 1) {
    const job = control.job(id);
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the job never finished');
}

async function makeService(world: ReturnType<typeof fakeWorld>): Promise<{
  control: BackupControl; data: string; started: string[];
}> {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-service-'));
  const started: string[] = [];
  const control = createBackupService({
    ctx: { root: '/install', data, env: { DATABASE_URL: 'postgres://u@localhost/buddi' }, state: {} as any },
    core: world.core as any,
    gateway: world.gateway as any,
    stopGateway: async () => { started.push('stop'); },
    startGateway: () => { started.push('start'); },
    log: () => {},
  });
  return { control, data, started };
}

/** An archive in this installation's own backups directory. */
async function archived(data: string, name = 'buddi-backup-20260101-033000.tar.gz'): Promise<string> {
  await mkdir(path.join(data, 'backups'), { recursive: true });
  await writeFile(path.join(data, 'backups', name), 'archive');
  return name;
}

/** An upload, where the gateway would have put one. */
async function upload(data: string, name = 'upload-1.tar.gz'): Promise<string> {
  await mkdir(incomingDir(data), { recursive: true });
  const file = path.join(incomingDir(data), name);
  await writeFile(file, 'archive');
  return file;
}

describe('a restore, as the service runs it', () => {
  test('a rolled-back restore says so; anything else says failed', async () => {
    const back = await makeService(fakeWorld(async () => report({ ok: false, didNot: ['the files came back wrong'], rolledBack: true })));
    const first = await back.control.restore({ name: await archived(back.data) }) as BackupJob;
    const rolled = await settled(back.control, first.id);
    expect(rolled.phase).toBe('rolled-back');
    expect(rolled.error).toContain('the files came back wrong');
    // Whatever happened, the installation is up again.
    expect(back.started).toEqual(['stop', 'start']);

    // A throw is not a rollback: something happened and it is still there.
    const broke = await makeService(fakeWorld(async () => { throw new Error('the archive is not readable'); }));
    const second = await broke.control.restore({ name: await archived(broke.data) }) as BackupJob;
    const failed = await settled(broke.control, second.id);
    expect(failed.phase).toBe('failed');
    expect(failed.error).toContain('the archive is not readable');
    expect(broke.started).toEqual(['stop', 'start']);
  });

  test('a recovery row that cannot be written takes the whole restore back with it', async () => {
    // Restored and ungated is the one outcome that must not exist: the row is
    // what keeps every loop asleep until the owner has seen the checklist.
    const world = fakeWorld(engine(), async () => { throw new Error('the row could not be written'); });
    const { control, data, started } = await makeService(world);
    const job = await control.restore({ name: await archived(data) }) as BackupJob;
    const done = await settled(control, job.id);
    expect(world.calls).toContain('enterRecovery');
    expect(done.phase).toBe('rolled-back');
    expect(done.error).toContain('the row could not be written');
    expect(started).toEqual(['stop', 'start']);
  });

  test('the upload a restore was given is removed when it is over, and kept when nothing was undone', async () => {
    const good = await makeService(fakeWorld(engine()));
    const kept = await upload(good.data);
    const job = await good.control.restore({ path: kept }) as BackupJob;
    expect((await settled(good.control, job.id)).phase).toBe('done');
    expect(existsSync(kept)).toBe(false);

    const broke = await makeService(fakeWorld(async () => { throw new Error('half way through'); }));
    const stranded = await upload(broke.data);
    const second = await broke.control.restore({ path: stranded }) as BackupJob;
    const failed = await settled(broke.control, second.id);
    expect(failed.phase).toBe('failed');
    expect(existsSync(stranded)).toBe(true);
    expect(failed.error).toContain(stranded);
  });

  test('one chain: nothing else runs while a restore does', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { control, data } = await makeService(fakeWorld(async (opts) => { await waiting; return engine()(opts); }));
    const name = await archived(data);
    const job = await control.restore({ name }) as BackupJob;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(control.busy()).toBe(true);
    expect(await control.restore({ name })).toEqual({ status: 409, error: 'A restore is running.' });
    expect(control.create(true)).toEqual({ status: 409, error: 'A restore is running.' });
    // The schedule waits too, and keeps its place: `lastRunAt` is untouched.
    await writeSchedule(data, { ...DEFAULT_SCHEDULE, enabled: true, time: '00:00' });
    await control.tick(new Date(2026, 0, 2, 4, 0));
    expect(await readSchedule(data)).toMatchObject({ lastRunAt: null });
    release();
    expect((await settled(control, job.id)).phase).toBe('done');
    expect(control.busy()).toBe(false);
  });

  test('the socket refuses start, stop, restart and a backup while a restore runs', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-backup-socket-'));
    const socket = supervisorSocket(data);
    const { control } = fakeControl();
    const action = vi.fn(async (_name: string) => {});
    const server = controlSocket({ status: () => STATUS, action, backup: { ...control, busy: () => true }, data });
    servers.push(server);
    await listenOnSocket(server, socket);
    for (const route of ['/start', '/stop', '/restart', '/backup']) {
      const refused = await call(socket, route, 'POST', {});
      expect(refused.status, route).toBe(409);
      expect(refused.body.error).toBe('A restore is running.');
    }
    expect(action).not.toHaveBeenCalled();
  });

  test('restart is acknowledged before it is carried out; stop is answered after', async () => {
    const { socket } = await serve();
    // `buddi service stop` reads this reply, so it is composed once the child
    // is gone and the status in it is the one that is true.
    expect((await call(socket, '/start', 'POST', {})).status).toBe(200);
    expect((await call(socket, '/stop', 'POST', {})).status).toBe(200);
    // The caller of a restart is the process about to be replaced.
    expect((await call(socket, '/restart', 'POST', {})).status).toBe(202);
  });
});

describe('uploads nobody restored from', () => {
  test('are swept once they are a day old, and never before', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-incoming-'));
    expect(await sweepIncoming(data)).toEqual([]);
    const old = await upload(data, 'upload-old.tar.gz');
    const fresh = await upload(data, 'upload-new.tar.gz');
    const then = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(old, then, then);
    expect(await sweepIncoming(data)).toEqual(['upload-old.tar.gz']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
