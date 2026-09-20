/**
 * The dashboard's backup routes: what they forward, and what they refuse.
 *
 * The supervisor here is a socket that records what it was asked; no archive is
 * written and no database is touched. The two decisions that belong to the
 * gateway rather than to the supervisor are what this is really about: that an
 * uploaded file becomes a path *this* process chose under `<data>/incoming/`,
 * and that the first-run restore stops being available the moment this
 * installation has an agent of its own.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { incomingName, isSafeArchiveName } from './backups.js';

const servers: WebServer[] = [];
const fakes: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(fakes.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface Seen { method: string; url: string; body: string }

async function fakeSupervisor(): Promise<{ socket: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const socket = path.join(await mkdtemp(path.join(tmpdir(), 'buddi-backups-')), 'supervisor.sock');
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      const out = req.url === '/backups'
        ? { dir: '/data/backups', database: 'buddi', archives: [] }
        : { job: { id: 'job-1', kind: 'restore', phase: 'stopping', phases: ['starting', 'stopping'] } };
      res.writeHead(req.url === '/backups' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  fakes.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
  return { socket, seen };
}

/** Enough of a pool for the onboarding read and the owner profile. */
function fakePool(state: { preferredName: string | null; onboarding: string }) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from core\.onboarding/.test(sql)) {
        return { rows: [{ owner_id: 'owner', state: state.onboarding, steps_done: [], details: {} }] };
      }
      if (/from core\.owner/.test(sql)) {
        return { rows: [{ preferred_name: state.preferredName, timezone: null, language: null, about: null, display_name: null }] };
      }
      return { rows: [] };
    }),
  };
}

async function dashboard(env: NodeJS.ProcessEnv, over: { agents?: string[]; pool?: unknown } = {}) {
  const agents = (over.agents ?? []).map((id) => ({ id, source: 'private' as const }));
  const app = await startWebServer({
    pool: (over.pool ?? fakePool({ preferredName: null, onboarding: 'pending' })) as never,
    registry: new ToolRegistry(),
    catalog: { list: () => agents, get: () => undefined, reload: () => {} } as unknown as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', env,
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return { app, origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf } };
}

const json = (headers: Record<string, string>): Record<string, string> => ({ ...headers, 'Content-Type': 'application/json' });

it('forwards a listing and adds the two facts the restore panel needs', async () => {
  const { socket, seen } = await fakeSupervisor();
  const { origin, headers } = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const listed = await fetch(`${origin}/api/backups`, { headers });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ dir: '/data/backups', database: 'buddi', archives: [], supervised: true });
  expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /backups']);
});

it('passes a named restore down the socket, and refuses anything that is not a name', async () => {
  const { socket, seen } = await fakeSupervisor();
  const { origin, headers } = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const accepted = await fetch(`${origin}/api/backups/restore`, {
    method: 'POST', headers: json(headers),
    body: JSON.stringify({ name: 'buddi-backup-20260101-033000.tar.gz.age', passphrase: 'able acid', confirm: 'buddi' }),
  });
  expect(accepted.status).toBe(202);
  expect(((await accepted.json()) as any).job.id).toBe('job-1');
  expect(JSON.parse(seen.at(-1)!.body)).toEqual({
    name: 'buddi-backup-20260101-033000.tar.gz.age', passphrase: 'able acid', confirm: 'buddi',
  });

  const refused = await fetch(`${origin}/api/backups/restore`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ name: '../../etc/passwd' }),
  });
  expect(refused.status).toBe(400);
  // A name that is not a name never reaches the socket at all.
  expect(seen).toHaveLength(1);
});

it('writes an uploaded archive under the data directory and tells the supervisor the path it chose', async () => {
  const { socket, seen } = await fakeSupervisor();
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-data-'));
  const { origin, headers } = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket, BUDDI_DATA_DIR: data });

  const sent = await fetch(`${origin}/api/backups/restore`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Filename': '../../evil.tar.gz.age', 'X-Backup-Passphrase': 'able acid', 'X-Backup-Confirm': 'buddi' },
    body: 'pretend ciphertext',
  });
  expect(sent.status).toBe(202);

  // The browser's filename never becomes a path: the file this process wrote
  // is named by this process, inside `<data>/incoming/`.
  const written = await readdir(path.join(data, 'incoming'));
  expect(written).toHaveLength(1);
  expect(written[0]).toMatch(/^upload-\d+-[0-9a-f]{8}\.tar\.gz\.age$/);
  const forwarded = JSON.parse(seen.at(-1)!.body) as { path: string; passphrase: string; confirm: string };
  expect(forwarded.path).toBe(path.join(data, 'incoming', written[0]!));
  expect(forwarded.passphrase).toBe('able acid');
  expect(forwarded.confirm).toBe('buddi');
});

it('is the first-run restore only while nothing has been answered and no agent exists', async () => {
  const { socket, seen } = await fakeSupervisor();
  const body = JSON.stringify({ name: 'buddi-backup-20260101-033000.tar.gz', passphrase: 'able acid' });

  const fresh = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  expect((await fetch(`${fresh.origin}/api/onboarding/restore`, { method: 'POST', headers: json(fresh.headers), body })).status).toBe(202);
  // No confirmation is sent, because there is nothing here to lose.
  expect(JSON.parse(seen.at(-1)!.body)).toEqual({ name: 'buddi-backup-20260101-033000.tar.gz', passphrase: 'able acid' });

  const withAgent = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket }, { agents: ['concierge'] });
  const refusedAgent = await fetch(`${withAgent.origin}/api/onboarding/restore`, { method: 'POST', headers: json(withAgent.headers), body });
  expect(refusedAgent.status).toBe(409);
  expect(((await refusedAgent.json()) as any).error).toMatch(/already has an agent/);

  const done = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket }, { pool: fakePool({ preferredName: 'Amen', onboarding: 'done' }) });
  const refusedDone = await fetch(`${done.origin}/api/onboarding/restore`, { method: 'POST', headers: json(done.headers), body });
  expect(refusedDone.status).toBe(409);
  expect(((await refusedDone.json()) as any).error).toMatch(/already been set up/);

  expect(seen).toHaveLength(1);
});

it('a checkout lists its own backups, says it is not supervised, and will not restore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buddi-checkout-'));
  const env = {
    BUDDI_AGENTS_DIR: path.join(root, 'private', 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'private', 'skills'),
    BUDDI_DATA_DIR: path.join(root, 'data'),
    DATABASE_URL: 'postgres://buddi:secret@127.0.0.1:5432/buddi_dev',
    BUDDI_VAULT: 'memory',
  };
  const { origin, headers } = await dashboard(env);

  const listed = await (await fetch(`${origin}/api/backups`, { headers })).json() as any;
  expect(listed).toMatchObject({ archives: [], database: 'buddi_dev', supervised: false });
  expect(listed.dir).toBe(path.join(root, 'private', 'backups'));

  const restore = await fetch(`${origin}/api/backups/restore`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ name: 'buddi-backup-20260101-033000.tar.gz' }),
  });
  expect(restore.status).toBe(409);
  expect(((await restore.json()) as any).error).toBe('Restore needs the packaged installation. In a checkout, run: buddi backup restore <file>');

  // The schedule is the OS unit `buddi backup schedule install` writes, and the
  // page is told so rather than shown a switch that changes nothing.
  const schedule = await (await fetch(`${origin}/api/backups/schedule`, { headers })).json() as any;
  expect(schedule).toMatchObject({ supervised: false });
  expect(schedule.error).toMatch(/buddi backup schedule install/);
  expect((await fetch(`${origin}/api/backups/schedule`, { method: 'PUT', headers: json(headers), body: '{}' })).status).toBe(409);
});

it('names an upload itself, keeping only whether it was encrypted', () => {
  expect(incomingName('holiday.tar.gz.age')).toMatch(/^upload-\d+-[0-9a-f]{8}\.tar\.gz\.age$/);
  expect(incomingName('../../etc/passwd')).toMatch(/^upload-\d+-[0-9a-f]{8}\.tar\.gz$/);
  expect(incomingName(undefined)).toMatch(/^upload-\d+-[0-9a-f]{8}\.tar\.gz$/);
});

it('accepts only a name this installation could have written', () => {
  expect(isSafeArchiveName('buddi-backup-20260101-033000.tar.gz')).toBe(true);
  expect(isSafeArchiveName('pre-restore-20260101-033000.tar.gz.age')).toBe(true);
  for (const bad of ['../x.tar.gz', 'x.tar.gz', 'a/buddi-backup-20260101-033000.tar.gz', 7, undefined]) {
    expect(isSafeArchiveName(bad), String(bad)).toBe(false);
  }
});
