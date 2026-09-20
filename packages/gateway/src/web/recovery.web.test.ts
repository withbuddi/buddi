/**
 * The recovery routes, against a fake pool and a fake supervisor.
 *
 * Nothing here restores anything: what is under test is the checklist the page
 * renders — that a missing credential is listed with somewhere to put it, that
 * the pending counts are the ones the restore recorded rather than a fresh
 * query, and that leaving drops what the owner did not keep and then asks the
 * supervisor to restart the gateway, because the loops are decided at startup.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { vaultMarkersIn } from './recovery.js';

const servers: WebServer[] = [];
const fakes: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(fakes.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const RESTORED_AT = new Date('2026-09-19T03:30:00.000Z');

interface PoolState {
  active: boolean;
  grants: Array<{ id: string; agent_id: string; tool: string; conversation_id: string }>;
  telegram: number;
  accounts: Array<{ secret_ref: string | null; auth: string; label: string }>;
}

/** Enough of a pool for the recovery row, the grants and the two counts. */
function fakePool(state: PoolState) {
  const updates: string[] = [];
  const pool = {
    updates,
    state,
    /** Set once the server is up, to play a pool that has been ended. */
    dead: false,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (pool.dead) throw new Error('Cannot use a pool after calling end on the pool');
      if (/from core\.recovery where id and left_at is null/.test(sql)) {
        return { rows: state.active ? [{ n: 1 }] : [] };
      }
      if (/from core\.recovery where id/.test(sql)) {
        return {
          rows: [{
            restored_at: RESTORED_AT,
            archive: 'buddi-backup-20260919-033000.tar.gz.age',
            buddi_version: '0.1.0',
            pending: { jobs: 11, missions: 2, approvals: 1, telegramChats: 1, grants: 2 },
            left_at: state.active ? null : new Date(),
          }],
        };
      }
      if (/update core\.recovery/.test(sql)) {
        const was = state.active;
        state.active = false;
        return { rows: was ? [{ left_at: params[0] }] : [] };
      }
      if (/update core\.jobs/.test(sql)) { updates.push('jobs'); return { rows: [], rowCount: 11 }; }
      if (/update core\.approvals/.test(sql)) { updates.push('approvals'); return { rows: [], rowCount: 1 }; }
      if (/delete from core\.tool_permissions/.test(sql)) {
        const before = state.grants.length;
        state.grants = state.grants.filter((g) => g.id !== params[1]);
        return { rows: before === state.grants.length ? [] : [{ agent_id: 'a', tool: 't', conversation_id: '' }] };
      }
      if (/from core\.tool_permissions/.test(sql)) {
        return { rows: state.grants.map((g) => ({ ...g, owner_id: 'owner', tool_version: '1', created_at: RESTORED_AT })) };
      }
      if (/from core\.provider_accounts/.test(sql)) return { rows: state.accounts };
      if (/from core\.surface_identities/.test(sql)) return { rows: [{ n: String(state.telegram) }] };
      return { rows: [] };
    }),
  };
  return pool;
}

/** A supervisor that only records what it was asked to do. */
async function fakeSupervisor(): Promise<{ socket: string; seen: string[] }> {
  const seen: string[] = [];
  const socket = path.join(await mkdtemp(path.join(tmpdir(), 'buddi-recovery-')), 'supervisor.sock');
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  fakes.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
  return { socket, seen };
}

async function dashboard(pool: unknown, env: NodeJS.ProcessEnv): Promise<{ app: WebServer; headers: Record<string, string>; origin: string }> {
  const app = await startWebServer({
    pool: pool as never, registry: new ToolRegistry(),
    catalog: { list: () => [], get: () => undefined } as unknown as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', env,
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return { app, origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' } };
}

function state(over: Partial<PoolState> = {}): PoolState {
  return {
    active: true,
    grants: [
      { id: 'g1', agent_id: 'concierge', tool: 'mail.send', conversation_id: '' },
      { id: 'g2', agent_id: 'concierge', tool: 'host.exec', conversation_id: 'c1' },
    ],
    telegram: 1,
    accounts: [{ secret_ref: 'ANTHROPIC_API_KEY', auth: 'api-key', label: 'work' }],
    ...over,
  };
}

it('lists what the restore left the owner to do, and says so on every page', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-recovery-env-'));
  const envFile = path.join(dir, '.env');
  await writeFile(envFile, 'TAVILY_API_KEY="<vault>"\nBUDDI_WEB_PORT=4317\n');
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_ENV_FILE: envFile });

  // The shell reads it from the session it already asks for.
  expect(await (await fetch(`${origin}/api/session`, { headers })).json()).toMatchObject({ recovery: true });

  const view = await (await fetch(`${origin}/api/recovery`, { headers })).json() as any;
  expect(view.active).toBe(true);
  expect(view.archive).toBe('buddi-backup-20260919-033000.tar.gz.age');
  expect(view.restoredAt).toBe(RESTORED_AT.toISOString());

  // A backup carries no secret value, so every credential is on the list —
  // the account's, the bot's, and whatever the restored .env marked.
  expect(view.checklist.secrets).toEqual([
    { name: 'ANTHROPIC_API_KEY', kind: 'account', settingsRoute: '#/settings/accounts' },
    { name: 'TELEGRAM_BOT_TOKEN', kind: 'telegram', settingsRoute: '#/settings/system' },
    { name: 'TAVILY_API_KEY', kind: 'plugin', settingsRoute: '#/settings/system' },
  ]);
  // The counts are the ones the restore took, not a fresh query.
  expect(view.checklist.pending).toEqual({ jobs: 11, missions: 2, approvals: 1, telegramChats: 1 });
  expect(view.checklist.grants.map((g: { id: string; scope: string }) => [g.id, g.scope])).toEqual([
    ['g1', 'every conversation'],
    ['g2', 'one conversation'],
  ]);
});

it('an installation that was never restored answers, rather than 404', async () => {
  const pool = fakePool(state({ active: false }));
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory' });
  const view = await (await fetch(`${origin}/api/recovery`, { headers })).json() as any;
  expect(view.active).toBe(false);
  expect(view.checklist.secrets).toEqual([]);
  expect(await (await fetch(`${origin}/api/session`, { headers })).json()).toMatchObject({ recovery: false });
});

/*
 * A database that cannot be read is a failure, never an answer.
 *
 * The restored gateway used to end its own pool while the dashboard kept
 * serving; `/api/recovery` then answered `{active: false}` because the read
 * swallowed the error, and the banner and the whole checklist were invisible
 * on the one installation they exist for. A 500 is the honest reply.
 */
it('a database it cannot read is a 500, not "not in recovery"', async () => {
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory' });
  pool.dead = true;

  const view = await fetch(`${origin}/api/recovery`, { headers });
  expect(view.status).toBe(500);
  const session = await fetch(`${origin}/api/session`, { headers });
  expect(session.status).toBe(500);
});

it('leaving drops the pending work and every grant the owner did not keep, then restarts', async () => {
  const { socket, seen } = await fakeSupervisor();
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: socket });

  const left = await fetch(`${origin}/api/recovery/leave`, {
    method: 'POST', headers, body: JSON.stringify({ dropPending: true, keepGrants: ['g2'] }),
  });
  expect(left.status).toBe(202);
  expect(await left.json()).toMatchObject({ left: true, droppedJobs: 11, droppedApprovals: 1, droppedGrants: 1, restarting: true });
  expect(pool.updates).toEqual(['jobs', 'approvals']);
  expect(pool.state.grants.map((g) => g.id)).toEqual(['g2']);

  // The loops start again by restarting the gateway, not by a live switch.
  await vi.waitFor(() => expect(seen).toContain('POST /restart'));
});

it('refuses a body that is not what it says it is', async () => {
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory' });
  for (const body of [{ dropPending: 'yes' }, { keepGrants: 'g1' }, { keepGrants: [1] }]) {
    const res = await fetch(`${origin}/api/recovery/leave`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status, JSON.stringify(body)).toBe(400);
  }
});

it('reads the vault markers a scrubbed .env carries and nothing else', () => {
  expect(vaultMarkersIn([
    'ANTHROPIC_API_KEY="<vault>"',
    "OPENAI_API_KEY='<vault>'",
    'export TAVILY_API_KEY=<vault>',
    'BUDDI_WEB_PORT=4317',
    'SOMETHING="not a marker"',
    '# ANTHROPIC_API_KEY="<vault>"',
  ].join('\n'))).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY']);
});

it('leaving when nothing was restored touches nothing', async () => {
  const { socket, seen } = await fakeSupervisor();
  const pool = fakePool(state({ active: false }));
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: socket });

  const left = await fetch(`${origin}/api/recovery/leave`, {
    method: 'POST', headers, body: JSON.stringify({ dropPending: true, keepGrants: [] }),
  });
  expect(left.status).toBe(202);
  expect(await left.json()).toMatchObject({ left: false, droppedJobs: 0, droppedApprovals: 0, droppedGrants: 0 });
  // A page left open and posted twice must not cancel the queue of an
  // installation that finished recovering days ago.
  expect(pool.updates).toEqual([]);
  expect(pool.state.grants.map((g) => g.id)).toEqual(['g1', 'g2']);
  // The restart is asked for once the reply is on the wire, never before: it
  // kills this process, and a SIGTERM in the middle of the work would end the
  // pool under the request doing it.
  await vi.waitFor(() => expect(seen).toContain('POST /restart'));
});

it('a body with no grants in it keeps every grant', async () => {
  const { socket } = await fakeSupervisor();
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: socket });

  const left = await fetch(`${origin}/api/recovery/leave`, {
    method: 'POST', headers, body: JSON.stringify({ dropPending: false }),
  });
  expect(await left.json()).toMatchObject({ left: true, droppedGrants: 0 });
  expect(pool.state.grants.map((g) => g.id)).toEqual(['g1', 'g2']);
});

it('a supervisor that will not restart leaves the installation in recovery', async () => {
  const socket = path.join(await mkdtemp(path.join(tmpdir(), 'buddi-recovery-')), 'nothing.sock');
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: socket });

  const left = await fetch(`${origin}/api/recovery/leave`, {
    method: 'POST', headers, body: JSON.stringify({ dropPending: true, keepGrants: [] }),
  });
  expect(left.status).toBe(502);
  expect((await left.json() as { error: string }).error).toContain('could not be restarted');
  // Nothing was dropped and the row is still open, so the button still works.
  expect(pool.updates).toEqual([]);
  expect(pool.state.active).toBe(true);
});

it('the checklist compares the archive plugins the restore wrote down, not the live record', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-recovery-data-'));
  await writeFile(path.join(data, 'restored-plugins.json'), JSON.stringify({
    version: 1,
    plugins: [{
      name: 'ledger', version: '1.2.0', entry: 'index.js', installedAt: RESTORED_AT.toISOString(),
      schema: 'finance', source: { kind: 'directory', path: '/plugins/ledger' },
    }],
  }));
  const pool = fakePool(state());
  const { origin, headers } = await dashboard(pool, { BUDDI_VAULT: 'memory', BUDDI_DATA_DIR: data });
  const view = await (await fetch(`${origin}/api/recovery`, { headers })).json() as any;
  expect(view.checklist.plugins).toEqual([
    { name: 'ledger', version: '1.2.0', source: '/plugins/ledger', installed: false },
  ]);
});
