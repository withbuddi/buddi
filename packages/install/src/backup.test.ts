/**
 * The backup half of the control socket, and the pure decisions behind it.
 *
 * Nothing here starts a supervisor, opens a database or writes an archive: the
 * socket is served with a fake `BackupControl`, so what is under test is
 * exactly what the socket itself decides — which names it will accept, which
 * paths, what a bad schedule is answered with, and that a passphrase is
 * normalized before it is stored. The engine is tested in `@buddi/core`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  backupDue,
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
