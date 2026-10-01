/**
 * Changing a group over the wire: `PATCH /api/groups/:id`, the archive, delete with its undo, and clear.
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
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';
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
    const csrf = opts.csrf === undefined ? (cookies.get(csrfCookieName(web.port)) ?? '') : opts.csrf;
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
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
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

  it('archives on its own route: gone from the list, rows still there', async () => {
    const group = await room('Done with');
    expect((await send('POST', `/api/groups/${group.id}/archive`)).status).toBe(204);
    const list = (await (await send('GET', '/api/groups')).json()) as { groups: GroupBody[] };
    expect(list.groups.some((g) => g.id === group.id)).toBe(false);
    const { rows } = await pool.query('select archived_at from core.groups where id = $1::uuid', [group.id]);
    expect(rows[0].archived_at).not.toBeNull();
  });

  it('deletes softly: gone from the list at once, an undo deadline, and back as it was on restore', async () => {
    const group = await room('Undo me');
    const res = await send('DELETE', `/api/groups/${group.id}`);
    expect(res.status).toBe(200);
    const { undoUntil } = (await res.json()) as { undoUntil: string };
    expect(Date.parse(undoUntil)).toBeGreaterThan(Date.now());
    const list = (await (await send('GET', '/api/groups')).json()) as { groups: GroupBody[] };
    expect(list.groups.some((g) => g.id === group.id)).toBe(false);
    expect((await send('GET', `/api/groups/${group.id}`)).status).toBe(404);
    // A second delete has nothing left to delete.
    expect((await send('DELETE', `/api/groups/${group.id}`)).status).toBe(404);
    const back = await send('POST', `/api/groups/${group.id}/restore`);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ id: group.id, name: 'Undo me', members: ['concierge', 'ledger'] });
    const again = (await (await send('GET', '/api/groups')).json()) as { groups: GroupBody[] };
    expect(again.groups.some((g) => g.id === group.id)).toBe(true);
  });

  it('is too late to restore once the minute is up, and the group and its history are then gone for good', async () => {
    const group = await room('For good');
    const { rows: [conv] } = await pool.query(`insert into core.conversations (agent_id, group_id) values ('concierge', $1::uuid) returning id`, [group.id]);
    expect((await send('DELETE', `/api/groups/${group.id}`)).status).toBe(200);
    // As if the minute had passed.
    await pool.query(`update core.groups set deleted_at = now() - interval '2 minutes' where id = $1::uuid`, [group.id]);
    const late = await send('POST', `/api/groups/${group.id}/restore`);
    expect(late.status).toBe(410);
    expect(((await late.json()) as { error: string }).error).toMatch(/Too late/);
    await send('GET', '/api/groups');
    expect((await pool.query('select 1 from core.groups where id = $1::uuid', [group.id])).rows).toHaveLength(0);
    expect((await pool.query('select 1 from core.conversations where id = $1::uuid', [conv.id])).rows).toHaveLength(0);
  });

  it('stops what the group was doing before deleting it', async () => {
    const group = await room('Busy');
    const { rows: [conv] } = await pool.query(`insert into core.conversations (agent_id, group_id) values ('concierge', $1::uuid) returning id`, [group.id]);
    const { rows: [request] } = await pool.query(
      `insert into core.group_requests (group_id, conversation_id, text, state) values ($1::uuid, $2::uuid, 'Do it', 'suspended') returning id`,
      [group.id, conv.id],
    );
    expect((await send('DELETE', `/api/groups/${group.id}`)).status).toBe(200);
    const { rows } = await pool.query('select state from core.group_requests where id = $1::uuid', [request.id]);
    expect(rows[0].state).toBe('stopped');
  });

  it('clears the history and keeps the group, its members and its id', async () => {
    const group = await room('Clear me');
    for (let i = 0; i < 2; i += 1) {
      await pool.query(`insert into core.conversations (agent_id, group_id) values ('concierge', $1::uuid)`, [group.id]);
    }
    const before = (await (await send('GET', `/api/groups/${group.id}`)).json()) as { history: { conversations: number } };
    expect(before.history.conversations).toBe(2);
    const res = await send('POST', `/api/groups/${group.id}/clear`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: 2 });
    const after = (await (await send('GET', `/api/groups/${group.id}`)).json()) as GroupBody & { history: { conversations: number }; latestConversationId: string | null };
    expect(after).toMatchObject({ id: group.id, name: 'Clear me', members: ['concierge', 'ledger'], latestConversationId: null });
    expect(after.history.conversations).toBe(0);
    expect((await send('POST', '/api/groups/11111111-2222-3333-4444-555555555555/clear')).status).toBe(404);
  });

  it('adds a member and removes one, each a change of its own', async () => {
    const group = await room('Members');
    const added = await send('PATCH', `/api/groups/${group.id}`, { members: ['concierge', 'ledger', 'garage'] });
    expect(await added.json()).toMatchObject({ members: ['concierge', 'ledger', 'garage'] });
    const removed = await send('PATCH', `/api/groups/${group.id}`, { members: ['concierge', 'garage'] });
    expect(await removed.json()).toMatchObject({ members: ['concierge', 'garage'] });
  });

  it('renames a room that lost an agent, and lets the owner take that agent out', async () => {
    const group = await createGroup(pool, { name: 'Lost one', coordinator: 'concierge', members: ['ledger', 'uninstalled'] });
    const renamed = await send('PATCH', `/api/groups/${group.id}`, { name: 'Found' });
    expect(renamed.status).toBe(200);
    const tidied = await send('PATCH', `/api/groups/${group.id}`, { members: ['concierge', 'ledger'] });
    expect(await tidied.json()).toMatchObject({ name: 'Found', members: ['concierge', 'ledger'] });
  });

  it('guards delete, restore and clear with the session and the CSRF pair', async () => {
    const group = await room('Guarded writes');
    for (const [method, path] of [['DELETE', `/api/groups/${group.id}`], ['POST', `/api/groups/${group.id}/restore`], ['POST', `/api/groups/${group.id}/clear`]] as const) {
      expect((await send(method, path, undefined, { csrf: null })).status).toBe(403);
      expect((await send(method, path, undefined, { origin: 'http://evil.example' })).status).toBe(403);
    }
    // Without the session cookie at all.
    const bare = await fetch(`${base}/api/groups/${group.id}`, { method: 'DELETE', headers: { origin: base } });
    expect([401, 403]).toContain(bare.status);
    expect((await send('GET', `/api/groups/${group.id}`)).status).toBe(200);
  });
});
