/**
 * The dashboard's HTTP surface, against a throwaway database.
 *
 * The security properties are the point, so they are asserted as *behaviour*
 * over the wire rather than as calls into the module:
 *
 *   - a request without a session gets 401 and an empty body;
 *   - a ticket exchanges once, and the very same ticket is refused after;
 *   - a write without the CSRF header, or from another Origin, is refused;
 *   - approving through the API leaves exactly the effect-ledger rows the
 *     Telegram path leaves, because it is the same core call;
 *   - a paused installation claims nothing, whoever paused it.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  claimJob,
  createPool,
  enqueue,
  ensureOwner,
  migrate,
  pairSurfaceIdentity,
  ToolRegistry,
  upsertMission,
  setSchedule,
  createReminder,
  offerActions,
  roleProblemMessage,
  type AgentCatalog,
  type PluginManifest,
  type ToolContext,
} from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_OVERVIEW } from '../agents/roles.js';
import { TelegramApprovals } from '../telegram/approvals.js';
import { SURFACE } from '../telegram/surface.js';
import { webAssetsDir } from './config.js';
import { mintTicket } from './token.js';
import { startWebServer, type WebServer, type WebServerDeps } from './server.js';
import { LOCAL_SESSION_TTL_MS, REMOTE_SESSION_TTL_MS } from './sessions.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_web_test_${process.pid}`;

const TOKEN = 'a-test-dashboard-token-long-enough';
/**
 * One clock for the whole suite, and it is the wall clock.
 *
 * The tool context and the web server must agree about "now" or the suite is a
 * time bomb: an action is proposed on the context's clock and expires 24h later
 * (`DEFAULT_APPROVAL_TTL_MS`), while `decideApproval` expires it against the
 * server's. A frozen date here decided fine on the day it was written and
 * started answering 409 "already expired" the next.
 */
const now = () => new Date();

/* ------------------------------------------------------------------ *
 * A one-tool plugin: `demo.send` is gated, so it exercises the whole
 * action / approval / effect-ledger path with nothing real behind it.
 * ------------------------------------------------------------------ */

const sent: Array<{ to: string; actionId?: string }> = [];

const demoManifest: PluginManifest = {
  name: 'demo',
  version: '1.0.0',
  schema: 'demo',
  migrationsDir: '',
  tools: [
    {
      name: 'demo.send',
      description: 'Send a thing.',
      tier: 'gated',
      input: z.object({ to: z.string(), body: z.string() }),
      describe: (input) => ({
        envelope: { to: input.to, body: input.body },
        preview: `Send "${input.body}" to ${input.to}`,
      }),
      async execute(input: { to: string; body: string }, ctx: ToolContext) {
        sent.push({ to: input.to, ...(ctx.actionId ? { actionId: ctx.actionId } : {}) });
        return { delivered: true };
      },
    },
  ],
};

/**
 * The catalog the agents endpoint reads. One agent, no files on disk and no
 * search path: the suite must not depend on this machine having a private
 * agents directory. The agent claims the `overview` role, so the money block's
 * role gate is satisfied and `available: false` can only mean the one thing
 * this installation is actually missing — a plugin that reports balances.
 */
const fakeCatalog = (): AgentCatalog => {
  const agent = {
    id: 'demo-agent',
    handle: 'demo',
    name: 'Demo',
    description: 'A test agent.',
    isDefault: true,
    roles: [ROLE_OVERVIEW],
    source: 'private' as const,
    providerKind: 'anthropic' as const,
    available: true,
    availability: { ok: true as const },
    file: '/agents/demo/agent.md',
    model: 'claude-test',
    tools: ['demo.send'],
    maxTurns: 4,
    language: 'mirror' as const,
    provider: {
      kind: 'anthropic' as const,
      model: 'claude-test',
      credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
    },
    skills: [{ name: 'house-rules', provenance: 'shared' as const, file: '/skills/house.md' }],
    systemPromptTemplate: 'you are a demo',
    definition: () => {
      throw new Error('not used');
    },
  };
  const summary = {
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    description: agent.description,
    isDefault: agent.isDefault,
    roles: [...agent.roles],
    source: agent.source,
    providerKind: agent.providerKind,
    available: agent.available,
  };
  return {
    get: (id: string) => (id === agent.id ? (agent as never) : undefined),
    byHandle: () => agent as never,
    list: () => [summary],
    agentsWithRole: (role: string) =>
      agent.roles.includes(role.trim().toLowerCase()) ? [agent as never] : [],
    agentForRole: (role: string) =>
      agent.roles.includes(role.trim().toLowerCase())
        ? { ok: true, agent: agent as never }
        : {
            ok: false,
            problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) },
          },
    defaultAgent: () => agent as never,
    resolve: () => agent as never,
  };
};

/* ------------------------------------------------------------------ *
 * A tiny cookie-aware client. `fetch` keeps no jar of its own.
 * ------------------------------------------------------------------ */

class Client {
  readonly cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  get csrf(): string {
    return this.cookies.get('buddi_csrf') ?? '';
  }

  header(): Record<string, string> {
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return jar === '' ? {} : { cookie: jar };
  }

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) this.cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
  }

  async get(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { ...this.header(), ...(init.headers ?? {}) },
    });
    this.absorb(res);
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.get(path);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  async post(
    path: string,
    body: unknown = {},
    opts: { csrf?: string | null; origin?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf !== null) headers['x-buddi-csrf'] = csrf;
    const origin = opts.origin === undefined ? this.base : opts.origin;
    if (origin !== null) headers.origin = origin;
    return this.get(path, { method: 'POST', body: JSON.stringify(body), headers });
  }
}

/* ------------------------------------------------------------------ */

suite('the dashboard API', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let closed: WebServer;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let base: string;
  let closedBase: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });

    registry = new ToolRegistry();
    registry.register(demoManifest);
    ctx = { db: pool, ownerId: 'owner', now, timezone: 'UTC' };

    await ensureOwner(pool, 'owner');
    await pairSurfaceIdentity(pool, {
      surface: SURFACE,
      externalUserId: '4242',
      externalChatId: '4242',
      pairedVia: 'env',
    });

    web = await startWebServer({
      pool,
      registry,
      catalog: fakeCatalog(),
      ctx,
      timezone: 'UTC',
      now,
      // Port 0: the OS picks one, so the suite never fights a running service.
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;

    // The gate has two settings, and a loopback-bound socket cannot be reached
    // from anywhere else, so the closed one is driven through the same test
    // seam production never passes: the binding itself decides in the wild.
    closed = await startWebServer({
      pool,
      registry,
      catalog: fakeCatalog(),
      ctx,
      timezone: 'UTC',
      now,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: false,
      log: () => {},
    });
    closedBase = `http://127.0.0.1:${closed.port}`;
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await closed?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    await pool.query('truncate core.effect_attempts, core.approvals, core.actions cascade');
    await pool.query('truncate core.jobs cascade');
    await pool.query(`update core.system_flags set value = 'false'::jsonb where key = 'paused'`);
  });

  /** A client that has exchanged a fresh ticket for a session. */
  const signedIn = async (): Promise<Client> => {
    const client = new Client(base);
    const res = await client.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
    expect(res.status).toBe(302);
    expect(client.cookies.get('buddi_session')).toBeTruthy();
    return client;
  };

  /* ---------------- authentication ---------------- */

  it('serves a request with no session and no ticket, and hands it a session for free', async () => {
    // Open on loopback: the binding is the credential, so a bookmark that has
    // never been here before, and this machine's curl, both just work.
    const client = new Client(base);
    const first = await client.get('/api/session');
    expect(first.status).toBe(200);
    const minted = first.headers.getSetCookie();
    expect(minted.some((c) => c.startsWith('buddi_session=') && c.includes('HttpOnly'))).toBe(true);
    expect(minted.some((c) => c.startsWith('buddi_csrf=') && !c.includes('HttpOnly'))).toBe(true);

    // And the freely minted session is a real one: it can carry a write.
    const ok = await client.post('/api/pause', { paused: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ paused: true });
  });

  it('still refuses the first-ever write from a browser with no session yet', async () => {
    // The mint happens in this response, so the page cannot have echoed its
    // csrf pair back yet — and a cross-site writer is exactly this client.
    const res = await fetch(`${base}/api/pause`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-buddi-csrf': 'anything' },
      body: '{"paused":true}',
    });
    expect(res.status).toBe(403);
  });

  it('answers an unauthenticated request with 401 and nothing else when the gate is closed', async () => {
    for (const path of ['/', '/api/overview', '/api/events', '/assets/nope.js']) {
      const res = await fetch(`${closedBase}${path}`, { redirect: 'manual' });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
      expect(res.headers.get('www-authenticate')).toBeNull();
    }
  });

  it('exchanges a ticket once, for an HttpOnly session and a readable csrf cookie', async () => {
    const ticket = mintTicket(TOKEN);
    const client = new Client(base);
    const res = await client.get(`/?t=${encodeURIComponent(ticket)}`);

    expect(res.status).toBe(302);
    // The clean URL carries no trace of the ticket.
    expect(res.headers.get('location')).toBe('/');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('buddi_session=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.every((c) => c.includes('SameSite=Strict'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('buddi_csrf=') && !c.includes('HttpOnly'))).toBe(true);
    // Nothing in the response says anything about the token.
    expect(JSON.stringify(cookies)).not.toContain(TOKEN);

    // The session works...
    expect((await client.get('/api/overview')).status).toBe(200);
    // ...and the ticket does not, a second time.
    const replay = await new Client(base).get(`/?t=${encodeURIComponent(ticket)}`);
    expect(replay.status).toBe(401);
    expect(await replay.text()).toBe('');
  });

  it('refuses a forged, malformed or expired ticket', async () => {
    for (const ticket of [
      mintTicket('some-other-token'),
      'not-a-ticket',
      mintTicket(TOKEN, new Date(Date.now() - 600_000), 1_000),
    ]) {
      const res = await new Client(base).get(`/?t=${encodeURIComponent(ticket)}`);
      expect(res.status).toBe(401);
    }
  });

  it('emits no CORS header and refuses a preflight', async () => {
    const res = await fetch(`${base}/api/overview`, { method: 'OPTIONS' });
    expect(res.status).toBe(405);
    const get = await fetch(`${base}/api/overview`, { headers: { origin: 'http://evil.test' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });

  /* ---------------- CSRF and Origin ---------------- */

  it('refuses a write without the csrf header, with the wrong one, or from another origin', async () => {
    const client = await signedIn();

    expect((await client.post('/api/pause', { paused: true }, { csrf: null })).status).toBe(403);
    expect((await client.post('/api/pause', { paused: true }, { csrf: 'wrong' })).status).toBe(403);
    expect(
      (await client.post('/api/pause', { paused: true }, { origin: 'http://evil.test' })).status,
    ).toBe(403);
    expect((await client.post('/api/pause', { paused: true }, { origin: null })).status).toBe(403);

    // ...and accepts the real thing.
    const ok = await client.post('/api/pause', { paused: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ paused: true });
  });

  it('refuses a write with no session at all', async () => {
    const res = await fetch(`${closedBase}/api/pause`, {
      method: 'POST',
      headers: { origin: closedBase, 'content-type': 'application/json', 'x-buddi-csrf': 'anything' },
      body: '{"paused":true}',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  /* ---------------- reads ---------------- */

  it('answers every read endpoint with its documented shape', async () => {
    const client = await signedIn();

    const overview = await client.json<any>('/api/overview');
    expect(overview).toMatchObject({
      timezone: 'UTC',
      paused: false,
      // No plugin contributes a block here, so Home has none: not a money
      // block full of zeros, no block at all.
      home: [],
      approvals: { pending: expect.any(Number) },
      jobs: { pending: expect.any(Number), failed: expect.any(Number) },
      missions: { total: expect.any(Number) },
      reminders: { pending: expect.any(Number) },
      sentinels: { openUrgent: 0, openInfo: 0 },
    });
    expect(Array.isArray(overview.mail)).toBe(true);

    const events = await client.json<any>('/api/events?limit=5');
    expect(Array.isArray(events.events)).toBe(true);
    expect(events).toHaveProperty('nextCursor');
    expect(events).toHaveProperty('latest');

    expect(await client.json<any>('/api/events/kinds')).toHaveProperty('kinds');
    expect(await client.json<any>('/api/conversations')).toHaveProperty('conversations');
    expect(await client.json<any>('/api/missions')).toHaveProperty('missions');

    const jobs = await client.json<any>('/api/jobs');
    expect(jobs).toMatchObject({ jobs: expect.any(Array), counts: expect.any(Object), paused: false });

    const approvals = await client.json<any>('/api/approvals');
    expect(approvals).toMatchObject({ pending: expect.any(Array), recent: expect.any(Array) });

    expect(await client.json<any>('/api/reminders')).toHaveProperty('reminders');

    const sentinels = await client.json<any>('/api/sentinels');
    expect(sentinels).toMatchObject({
      installed: expect.any(Array),
      runs: expect.any(Array),
      open: expect.any(Array),
      resolved: expect.any(Array),
      digest: expect.any(Array),
    });

    const agents = await client.json<any>('/api/agents');
    expect(agents.agents[0]).toMatchObject({
      id: 'demo-agent',
      handle: 'demo',
      tools: ['demo.send'],
      provider: { kind: 'anthropic', credentialKind: 'api-key', credentialEnv: 'ANTHROPIC_API_KEY' },
    });
    // The credential *name* is reported; the credential never is.
    expect(JSON.stringify(agents)).not.toContain('secret');

    expect((await client.get('/api/nope')).status).toBe(404);
  });

  it('filters and pages the event log', async () => {
    const client = await signedIn();
    await pool.query(`insert into core.events (kind, payload) values ('web.test', '{"n":1}'::jsonb)`);
    await pool.query(`insert into core.events (kind, payload) values ('web.test', '{"n":2}'::jsonb)`);
    await pool.query(`insert into core.events (kind, payload) values ('other.kind', '{}'::jsonb)`);

    const filtered = await client.json<any>('/api/events?kind=web.test');
    expect(filtered.events).toHaveLength(2);
    // Newest first.
    expect(filtered.events[0].payload).toEqual({ n: 2 });

    const searched = await client.json<any>('/api/events?q=%22n%22%3A%201');
    expect(searched.events.every((e: any) => e.kind === 'web.test')).toBe(true);

    const page = await client.json<any>('/api/events?kind=web.test&limit=1');
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe(page.events[0].id);
    const next = await client.json<any>(`/api/events?kind=web.test&limit=1&before=${page.nextCursor}`);
    expect(next.events[0].payload).toEqual({ n: 1 });
  });

  it('reads a transcript with its tool calls and per-run token usage', async () => {
    const client = await signedIn();
    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ('demo-agent') returning id`,
    );
    const id = String(rows[0].id);
    await pool.query(
      `insert into core.messages (conversation_id, role, content) values ($1, 'user', $2::jsonb)`,
      [id, JSON.stringify([{ type: 'text', text: 'hello' }])],
    );
    await pool.query(
      `insert into core.messages (conversation_id, role, content) values ($1, 'assistant', $2::jsonb)`,
      [
        id,
        JSON.stringify([
          { type: 'text', text: 'looking' },
          { type: 'tool_use', id: 'tu1', name: 'demo.send', input: { to: 'x' } },
        ]),
      ],
    );
    await pool.query(
      `insert into core.messages (conversation_id, role, content) values ($1, 'user', $2::jsonb)`,
      [id, JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu1', content: '{"ok":true}' }])],
    );
    await pool.query(
      `insert into core.events (kind, conversation_id, payload) values ('run.started', $1, '{}'::jsonb)`,
      [id],
    );
    await pool.query(
      `insert into core.events (kind, conversation_id, payload)
       values ('run.finished', $1, '{"turns":2,"stopped":"end_turn","usage":{"input":120,"output":45}}'::jsonb)`,
      [id],
    );

    const transcript = await client.json<any>(`/api/conversations/${id}`);
    expect(transcript.agentId).toBe('demo-agent');
    expect(transcript.messages).toHaveLength(3);
    expect(transcript.messages[1].blocks[1]).toEqual({
      type: 'tool_use',
      name: 'demo.send',
      input: { to: 'x' },
    });
    expect(transcript.messages[2].blocks[0]).toMatchObject({ type: 'tool_result', isError: false });
    expect(transcript.runs).toHaveLength(1);
    expect(transcript.runs[0]).toMatchObject({ turns: 2, stopped: 'end_turn', usage: { input: 120, output: 45 } });
    expect(transcript.usage).toEqual({ input: 120, output: 45 });

    const listed = await client.json<any>('/api/conversations');
    expect(listed.conversations[0]).toMatchObject({ id, opening: 'hello', runs: 1 });

    expect((await client.get('/api/conversations/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('serves one action whole, so the approval canvas need not hunt in the list', async () => {
    const client = await signedIn();
    const id = await proposeAction('one@example.test');

    const body = await client.json<any>(`/api/approvals/${id}`);
    // The envelope the approval is bound to, and the preview the *tool* wrote:
    // what is approved has to be what is shown.
    expect(body.action).toMatchObject({
      id,
      tool: 'demo.send',
      state: 'pending',
      preview: 'Send "hello" to one@example.test',
      envelope: { to: 'one@example.test', body: 'hello' },
    });
    expect(typeof body.action.argsHash).toBe('string');
    expect(typeof body.action.expiresAt).toBe('string');

    // Same session gate as its neighbours, and an unknown id is a 404 rather
    // than an empty envelope.
    expect((await client.get('/api/approvals/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    // Anonymous on the *closed* gate: where a ticket is required, nothing of
    // this shape leaks without one.
    const anonymous = await fetch(`${closedBase}/api/approvals/${id}`, { redirect: 'manual' });
    expect(anonymous.status).toBe(401);
  });

  /* ---------------- writes ---------------- */

  it('approves through the API with exactly the effect the Telegram path has', async () => {
    const client = await signedIn();

    const viaWeb = await proposeAction('web@example.test');
    const viaTelegram = await proposeAction('telegram@example.test');

    // The dashboard decides one...
    const res = await client.post(`/api/approvals/${viaWeb}/approve`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.action.state).toBe('succeeded');
    expect(body.execution).toMatchObject({ state: 'succeeded' });

    // ...and Telegram decides the other, through its own surface.
    const telegram = new TelegramApprovals({
      api: {
        sendMessage: async () => 1,
        editMessageText: async () => {},
        answerCallbackQuery: async () => {},
      },
      pool,
      registry,
      ctx,
      timezone: 'UTC',
      log: () => {},
    });
    await telegram.handleCallback({
      id: 'cb1',
      from: { id: 4242 },
      message: { message_id: 1, chat: { id: 4242 } },
      data: `apr:${viaTelegram}:approve`,
    } as never);

    const ledger = async (actionId: string): Promise<any[]> => {
      const { rows } = await pool.query(
        `select attempt, state, envelope_hash, error from core.effect_attempts
          where action_id = $1 order by attempt`,
        [actionId],
      );
      return rows;
    };

    const webLedger = await ledger(viaWeb);
    const telegramLedger = await ledger(viaTelegram);
    expect(webLedger).toHaveLength(1);
    // Same shape, same count, same terminal state — the same code wrote both.
    expect(webLedger.map((r) => [r.attempt, r.state, r.error])).toEqual(
      telegramLedger.map((r) => [r.attempt, r.state, r.error]),
    );
    expect(webLedger[0].state).toBe('succeeded');

    // Both effects actually ran, each with its own action id as the key.
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.actionId))).toEqual(new Set([viaWeb, viaTelegram]));

    // And the decision is recorded as having come from the web.
    const { rows: decided } = await pool.query(
      `select decided_via, decided_by from core.approvals where action_id = $1`,
      [viaWeb],
    );
    expect(decided[0]).toMatchObject({ decided_via: 'web', decided_by: 'owner' });

    // The dashboard's own action is in the event log.
    const { rows: events } = await pool.query(
      `select count(*)::int as n from core.events
        where kind = 'approval.decided'
          and payload->>'decidedVia' = 'web'
          and payload->>'actionId' = $1`,
      [viaWeb],
    );
    expect(events[0].n).toBe(1);
  });

  it('rejects, and refuses to decide the same action twice', async () => {
    const client = await signedIn();
    const actionId = await proposeAction('nope@example.test');

    const first = await client.post(`/api/approvals/${actionId}/reject`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).action.state).toBe('rejected');
    expect(sent).toHaveLength(0);

    const second = await client.post(`/api/approvals/${actionId}/approve`);
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error).toMatch(/already rejected/);

    const missing = await client.post('/api/approvals/00000000-0000-0000-0000-000000000000/approve');
    expect(missing.status).toBe(404);
  });

  it('pauses the installation, and a paused queue claims nothing', async () => {
    const client = await signedIn();
    // `run_after` is supplied instead of being left to the database's own
    // `now()`: the two claims below are made at *this* process's clock, and the
    // database's runs a little ahead of it.
    await enqueue(pool, {
      kind: 'demo',
      payload: {},
      dedupKey: 'pause-test',
      runAfter: new Date(Date.now() - 60_000),
    });

    expect((await client.post('/api/pause', { paused: true })).status).toBe(200);
    expect(
      await claimJob(pool, { worker: 'w', kinds: ['demo'], now: new Date(), leaseMs: 1000 }),
    ).toBeNull();
    expect((await client.json<any>('/api/jobs')).paused).toBe(true);

    expect((await client.post('/api/pause', { paused: false })).status).toBe(200);
    const claimed = await claimJob(pool, {
      worker: 'w',
      kinds: ['demo'],
      now: new Date(),
      leaseMs: 1000,
    });
    expect(claimed?.kind).toBe('demo');

    expect((await client.post('/api/pause', { paused: 'yes' })).status).toBe(400);
  });

  it('retries and cancels jobs, and refuses the transitions the queue refuses', async () => {
    const client = await signedIn();
    const job = await enqueue(pool, { kind: 'demo', payload: {}, dedupKey: 'job-test' });

    // A pending job cannot be retried, but it can be cancelled.
    expect((await client.post(`/api/jobs/${job.id}/retry`)).status).toBe(409);
    const cancelled = await client.post(`/api/jobs/${job.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as any).job.state).toBe('cancelled');

    const retried = await client.post(`/api/jobs/${job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as any).job.state).toBe('pending');
  });

  it('enables, disables and re-schedules a mission', async () => {
    const client = await signedIn();
    await upsertMission(pool, {
      id: 'web-mission',
      name: 'Web mission',
      agentId: 'demo-agent',
      prompt: 'do the thing',
    });
    await setSchedule(pool, 'web-mission', {
      cron: '0 9 * * 5',
      timezone: 'UTC',
      misfirePolicy: 'coalesce',
    });

    const off = await client.post('/api/missions/web-mission/enabled', { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ id: 'web-mission', enabled: false });

    const rescheduled = await client.post('/api/missions/web-mission/schedule', {
      misfirePolicy: 'latest-only',
    });
    expect(rescheduled.status).toBe(200);
    const spec = (await rescheduled.json()) as any;
    // A new revision, with the cron carried over rather than reset.
    expect(spec).toMatchObject({ misfirePolicy: 'latest-only', cron: '0 9 * * 5', revision: 2 });

    expect((await client.post('/api/missions/web-mission/schedule', { misfirePolicy: 'nonsense' })).status).toBe(400);
    expect((await client.post('/api/missions/nope/enabled', { enabled: true })).status).toBe(404);

    const missions = await client.json<any>('/api/missions');
    const mission = missions.missions.find((m: any) => m.id === 'web-mission');
    expect(mission).toMatchObject({ enabled: false, schedule: { misfirePolicy: 'latest-only' } });
    // Disabled: no next run is claimed.
    expect(mission.nextRun).toBeNull();
  });

  it('cancels a pending reminder and refuses a decided one', async () => {
    const client = await signedIn();
    const created = await createReminder(pool, {
      agentId: 'demo-agent',
      dueAt: new Date(Date.now() + 3 * 60 * 60_000),
      text: 'look at the card',
      now: new Date(),
      timezone: 'UTC',
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.reminder.id : '';

    const res = await client.post(`/api/reminders/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, state: 'cancelled' });
    expect((await client.post(`/api/reminders/${id}/cancel`)).status).toBe(409);

    const listed = await client.json<any>('/api/reminders');
    expect(listed.reminders.find((r: any) => r.id === id).state).toBe('cancelled');
  });

  it('lists offered actions, and takes one exactly once', async () => {
    const client = await signedIn();
    const stored = await offerActions(pool, {
      agentId: 'demo-agent',
      actions: [
        { label: 'Draft a reply', prompt: 'Draft a reply to Dorothée and show it to me.' },
        { label: 'Remind me tomorrow', prompt: 'Remind me tomorrow about the CdC site.' },
      ],
      now: new Date(),
    });
    const id = stored[0]?.id as string;

    const listed = await client.json<any>('/api/offers');
    expect(listed.offers.map((o: any) => o.label).sort()).toEqual([
      'Draft a reply',
      'Remind me tomorrow',
    ]);
    // The prompt is shown, not hidden: the owner can read what a chip will ask
    // before they click it.
    expect(listed.offers.find((o: any) => o.id === id).prompt).toContain('Draft a reply to');

    const res = await client.post(`/api/offers/${id}/take`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, label: 'Draft a reply' });

    // A second click — or the same offer tapped on the phone — starts nothing.
    expect((await client.post(`/api/offers/${id}/take`)).status).toBe(409);
    expect((await client.post('/api/offers/00000000-0000-4000-8000-000000000000/take')).status).toBe(
      404,
    );

    const after = await client.json<any>('/api/offers');
    expect(after.offers.map((o: any) => o.label)).toEqual(['Remind me tomorrow']);
  });

  /**
   * The answer the owner did not have. 65 offers had piled up on his
   * installation because taking one was the only thing a click could do.
   */
  it('dismisses an offer, keeps it under the fold, and clears the rest in one go', async () => {
    const client = await signedIn();
    const stored = await offerActions(pool, {
      agentId: 'demo-agent',
      actions: [
        { label: 'Send it', prompt: 'Send the reply I drafted.' },
        { label: 'Edit it', prompt: 'Change the second paragraph.' },
      ],
      now: new Date(),
    });
    const id = stored[0]?.id as string;

    const res = await client.post(`/api/offers/${id}/dismiss`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id });

    const after = await client.json<any>('/api/offers');
    // Gone from what is on the table, and readable under the fold with why.
    expect(after.offers.map((o: any) => o.id)).not.toContain(id);
    expect(after.closed.find((o: any) => o.id === id)).toMatchObject({ label: 'Send it' });
    expect(after.closed.find((o: any) => o.id === id).dismissedAt).not.toBeNull();

    // Taking a dismissed offer is refused, in words the page can show.
    const late = await client.post(`/api/offers/${id}/take`);
    expect(late.status).toBe(409);
    expect(((await late.json()) as any).error).toMatch(/dismissed/i);

    // And what is on the table can be cleared in one act: the page sends the
    // ids it showed, and the count answered is exactly that many, never more.
    const shown = (await client.json<any>('/api/offers')).offers.map((o: any) => o.id);
    const all = await client.post('/api/offers/dismiss-all', { ids: shown });
    expect(all.status).toBe(200);
    expect(((await all.json()) as any).dismissed).toBe(shown.length);
    expect((await client.json<any>('/api/offers')).offers).toEqual([]);
  });

  /* ---------------- session lifetime ---------------- */

  /**
   * The properties the owner feels: a session he is using does not expire under
   * him, one he abandoned does, and a browser on the network gets neither the
   * long lifetime nor a way to ask for it.
   *
   * These run against their own servers — one with a deliberately tiny idle
   * lifetime so "used all day" fits in a few seconds, and one bound to every
   * interface so a genuinely non-loopback connection can be made.
   */
  describe('session lifetime', () => {
    /**
     * Four seconds stands in for a month, and the requests below are spaced
     * well inside it — the rule under test is the ratio, not the number, and a
     * loaded machine must not be able to turn a scheduling hiccup into a
     * failure.
     */
    const TINY_TTL_MS = 4_000;
    const USE_EVERY_MS = 1_200;

    const lan = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;

    const start = async (over: Partial<WebServerDeps>): Promise<WebServer> =>
      startWebServer({
        pool,
        registry,
        catalog: fakeCatalog(),
        ctx,
        timezone: 'UTC',
        now,
        config: { enabled: true, host: '127.0.0.1', port: 0 },
        token: TOKEN,
        log: () => {},
        ...over,
      } as WebServerDeps);

    const maxAge = (res: Response, name: string): number => {
      const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
      const match = /Max-Age=(\d+)/.exec(line ?? '');
      return match ? Number(match[1]) : -1;
    };

    it('gives a loopback browser weeks, and says so in the cookie', async () => {
      const client = new Client(base);
      const res = await client.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
      expect(res.status).toBe(302);
      expect(maxAge(res, 'buddi_session')).toBe(LOCAL_SESSION_TTL_MS / 1000);
      expect(maxAge(res, 'buddi_csrf')).toBe(LOCAL_SESSION_TTL_MS / 1000);
      // Still HttpOnly, still Strict, still no CORS — the lifetime is the only
      // thing that changed.
      expect(res.headers.getSetCookie().every((c) => c.includes('SameSite=Strict'))).toBe(true);
      const session = await client.json<{ scope: string }>('/api/session');
      expect(session.scope).toBe('local');
    });

    it('slides under use and still expires when idle', async () => {
      // The closed gate, where an expiry has someone to stop: on the open
      // loopback gate a lapsed session is re-minted invisibly, which is the
      // point of the open gate — idle time never logs the owner out.
      const server = await start({ sessionTtlMs: { local: TINY_TTL_MS }, openAccess: false });
      try {
        const client = new Client(`http://127.0.0.1:${server.port}`);
        const opened = await client.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
        expect(opened.status).toBe(302);
        expect(maxAge(opened, 'buddi_session')).toBe(Math.floor(TINY_TTL_MS / 1000));

        // Used steadily for longer than the whole idle lifetime. Under the old
        // rule the cookie was minted once and died on schedule regardless.
        let refreshed = 0;
        const rounds = Math.ceil((TINY_TTL_MS * 1.5) / USE_EVERY_MS);
        for (let i = 0; i < rounds; i += 1) {
          await new Promise((r) => setTimeout(r, USE_EVERY_MS));
          const res = await client.get('/api/session');
          expect(res.status).toBe(200);
          if (res.headers.getSetCookie().length > 0) refreshed += 1;
        }
        // Re-issued about once per half-life, not on every request...
        expect(refreshed).toBeGreaterThan(0);
        expect(refreshed).toBeLessThan(rounds);
        // ...and a request made straight after a refresh carries no new cookie.
        const immediate = await client.get('/api/session');
        expect(immediate.status).toBe(200);
        expect(immediate.headers.getSetCookie()).toEqual([]);

        // Then he walks away for longer than the idle lifetime.
        await new Promise((r) => setTimeout(r, TINY_TTL_MS + 800));
        const stale = await client.get('/api/session');
        expect(stale.status).toBe(401);
        expect(await stale.text()).toBe('');
      } finally {
        await server.close();
      }
    }, 40_000);

    it.skipIf(!lan)('gives a non-loopback browser hours, and no way to claim otherwise', async () => {
      const server = await start({ config: { enabled: true, host: '0.0.0.0', port: 0 } });
      try {
        const remote = new Client(`http://${lan as string}:${server.port}`);
        const res = await remote.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`, {
          // The lie: every header a client could use to claim it is local.
          headers: {
            'x-forwarded-for': '127.0.0.1',
            'x-real-ip': '127.0.0.1',
            forwarded: 'for=127.0.0.1;proto=http',
          },
        });
        expect(res.status).toBe(302);
        expect(maxAge(res, 'buddi_session')).toBe(REMOTE_SESSION_TTL_MS / 1000);
        const session = await remote.json<{ scope: string }>('/api/session');
        expect(session.scope).toBe('remote');

        // And a session established on loopback is not honoured from the
        // network even with its cookie in hand.
        const local = new Client(`http://127.0.0.1:${server.port}`);
        expect((await local.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`)).status).toBe(302);
        const stolen = await fetch(`http://${lan as string}:${server.port}/api/session`, {
          headers: {
            cookie: `buddi_session=${local.cookies.get('buddi_session') as string}`,
            'x-forwarded-for': '127.0.0.1',
          },
        });
        expect(stolen.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });

  /* ---------------- the built dashboard ---------------- */

  it('serves the built dashboard, and its API, on the port it bound', async () => {
    const index = path.join(webAssetsDir(), 'index.html');
    let built = '';
    try {
      built = readFileSync(index, 'utf8');
    } catch {
      // `pnpm -r build` has not run in this checkout.
    }
    const client = await signedIn();

    const page = await client.get('/');
    if (built === '') {
      expect(page.status).toBe(503);
      return;
    }
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('assets/');
    // No external request: nothing in the page points off this origin.
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);

    // An unknown path falls back to the page, so a reload on #/events works.
    expect((await client.get('/events')).status).toBe(200);

    // And the API answers on the same port.
    expect((await client.get('/api/overview')).status).toBe(200);
  });

  /* ---------------- helpers ---------------- */

  async function proposeAction(to: string): Promise<string> {
    const outcome = await registry.invoke(
      'demo.send',
      { to, body: 'hello' },
      { ...ctx, agentId: 'demo-agent' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== 'approval-required') throw new Error('expected a gate');
    return outcome.actionId;
  }
});
