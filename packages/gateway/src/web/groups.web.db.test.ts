/**
 * Changing a group over the wire: `PATCH /api/groups/:id` and the archive.
 *
 * The rules are core's, and they are tested there; what is asserted here is
 * that the route applies them — the same refusals, in the same words — that it
 * is a *partial* change (a rename does not restate the membership), that a
 * write still needs a session and the CSRF pair, and that DELETE archives the
 * group instead of deleting it: the transcript is kept, the rail is not.
 *
 * Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createGroup,
  createPool,
  ensureOwner,
  migrate,
  roleProblemMessage,
  ToolRegistry,
  type AgentCatalog,
  type AgentSummary,
  type ToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_group_routes_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

/** Five agents: a front desk, two colleagues, the maker, and a broken one. */
const ROSTER: Array<{ id: string; roles: string[]; available: boolean }> = [
  { id: 'concierge', roles: ['front-desk'], available: true },
  { id: 'ledger', roles: [], available: true },
  { id: 'garage', roles: [], available: true },
  { id: 'father', roles: ['maker'], available: true },
  { id: 'scout', roles: [], available: false },
];

const fakeCatalog = (): AgentCatalog => {
  const summaries: AgentSummary[] = ROSTER.map((a) => ({
    id: a.id,
    handle: a.id,
    name: a.id[0]!.toUpperCase() + a.id.slice(1),
    description: 'A test agent.',
    isDefault: a.id === 'concierge',
    roles: [...a.roles],
    source: 'private' as const,
    providerKind: 'anthropic' as const,
    available: a.available,
  }));
  const full = (summary: AgentSummary): never => ({ ...summary, availability: { ok: summary.available } }) as never;
  return {
    get: (id: string) => {
      const found = summaries.find((s) => s.id === id);
      return found ? full(found) : undefined;
    },
    byHandle: (handle: string) => {
      const found = summaries.find((s) => s.handle === handle);
      return found ? full(found) : undefined;
    },
    list: () => summaries,
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({
      ok: false as const,
      problem: { code: 'no-agent-for-role' as const, role, message: roleProblemMessage(role) },
    }),
    defaultAgent: () => full(summaries[0]!),
    resolve: () => full(summaries[0]!),
  };
};

interface GroupBody {
  id: string;
  name: string;
  coordinator: string;
  members: string[];
}

suite('the group routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  const cookies = new Map<string, string>();

  const send = async (
    method: string,
    path: string,
    body?: unknown,
    opts: { csrf?: string | null; origin?: string | null } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const jar = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar !== '') headers.cookie = jar;
    const csrf = opts.csrf === undefined ? (cookies.get('buddi_csrf') ?? '') : opts.csrf;
    if (csrf !== null) headers['x-buddi-csrf'] = csrf;
    const origin = opts.origin === undefined ? base : opts.origin;
    if (origin !== null) headers.origin = origin;
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
    return res;
  };

  /** A room of concierge and ledger, made straight in the database. */
  const room = async (name: string): Promise<GroupBody> => {
    const group = await createGroup(pool, { name, coordinator: 'concierge', members: ['ledger'] });
    return { id: group.id, name: group.name, coordinator: group.coordinator, members: group.members };
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    const ctx: ToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool,
      registry: new ToolRegistry(),
      catalog: fakeCatalog(),
      ctx,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;
    const signed = await send('GET', `/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
    expect(signed.status).toBe(302);
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('renames without restating the membership, and keeps the id', async () => {
    const group = await room('Test room');
    const res = await send('PATCH', `/api/groups/${group.id}`, { name: 'Money' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupBody;
    expect(body).toMatchObject({ id: group.id, name: 'Money', coordinator: 'concierge', members: ['concierge', 'ledger'] });
  });

  it('adds a member and moves the coordinator in one change', async () => {
    const group = await room('The move');
    const res = await send('PATCH', `/api/groups/${group.id}`, {
      coordinator: 'ledger',
      members: ['concierge', 'ledger', 'garage'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ coordinator: 'ledger', members: ['concierge', 'ledger', 'garage'] });
  });

  it('refuses a coordinator outside the room, the maker, an agent that cannot run, and an empty room', async () => {
    const group = await room('Tax season');
    const cases: Array<[unknown, RegExp]> = [
      [{ members: ['ledger'] }, /coordinator has to be one of the members/],
      [{ members: ['concierge', 'father'] }, /father/],
      [{ members: ['concierge', 'scout'] }, /scout/],
      [{ members: ['concierge', 'nobody'] }, /nobody/],
      [{ members: ['concierge'] }, /at least one member besides the coordinator/],
      [{ name: '   ' }, /needs a name/],
    ];
    for (const [body, message] of cases) {
      const res = await send('PATCH', `/api/groups/${group.id}`, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    // And nothing moved.
    const after = await send('GET', `/api/groups/${group.id}`);
    expect(await after.json()).toMatchObject({ name: 'Tax season', members: ['concierge', 'ledger'] });
  });

  it('refuses a body that is not the shape it claims', async () => {
    const group = await room('Shapes');
    for (const body of [{ members: 'ledger' }, { members: [''] }, { name: 7 }, { coordinator: [] }]) {
      expect((await send('PATCH', `/api/groups/${group.id}`, body)).status).toBe(400);
    }
  });

  it('is 404 for a group that is not there, and 405 for a path that is not a group', async () => {
    expect((await send('PATCH', '/api/groups/11111111-2222-3333-4444-555555555555', { name: 'x' })).status).toBe(404);
    expect((await send('PATCH', '/api/agents', { name: 'x' })).status).toBe(405);
  });

  it('needs the CSRF pair and this origin, like every other write', async () => {
    const group = await room('Guarded');
    expect((await send('PATCH', `/api/groups/${group.id}`, { name: 'x' }, { csrf: null })).status).toBe(403);
    expect((await send('PATCH', `/api/groups/${group.id}`, { name: 'x' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await send('DELETE', `/api/groups/${group.id}`, undefined, { csrf: 'wrong' })).status).toBe(403);
  });

  it('archives rather than deletes: gone from the list, rows still there', async () => {
    const group = await room('Done with');
    expect((await send('DELETE', `/api/groups/${group.id}`)).status).toBe(204);
    const list = (await (await send('GET', '/api/groups')).json()) as { groups: GroupBody[] };
    expect(list.groups.some((g) => g.id === group.id)).toBe(false);
    const { rows } = await pool.query('select archived_at from core.groups where id = $1::uuid', [group.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).not.toBeNull();
    // A second archive has nothing left to archive.
    expect((await send('DELETE', `/api/groups/${group.id}`)).status).toBe(404);
  });
});
