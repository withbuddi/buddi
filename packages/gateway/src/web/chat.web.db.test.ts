/**
 * The browser as a talking surface, over the wire, against a throwaway database.
 *
 * Everything here is asserted as HTTP against a real server on a real port,
 * because every property that matters is a property of the *route*, not of a
 * function: a 202 that means "queued, watch the stream", a stream that replays
 * exactly from a cursor, a second message that waits instead of interleaving,
 * an approval that goes through the routes that already existed and leaves one
 * row in the effect ledger.
 *
 * And the gate, on every new route: no session, no CSRF, another Origin.
 *
 * Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  completeOnboarding,
  createPool,
  ensureOwner,
  migrate,
  roleProblemMessage,
  ToolRegistry,
  type AgentCatalog,
  type PluginManifest,
  type CoreToolContext,
} from '@buddi/core';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_OVERVIEW } from '../agents/roles.js';
import { createCoreArtifactStore } from '../telegram/attachments.js';
import { mintTicket } from './token.js';
import { startWebServer, type WebServer, type WebServerDeps } from './server.js';
import { csrfCookieName, portOf } from './http.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_webchat_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

/* ------------------------------------------------------------------ *
 * A two-tool plugin: one `auto` read, one `gated` effect.
 * ------------------------------------------------------------------ */

const sent: Array<{ to: string; actionId?: string }> = [];
/** Every call the `session`-tier tool actually reached, with the context it saw. */
const sessionCalls: Array<{ what: string; ctx: CoreToolContext }> = [];

const demoManifest: PluginManifest = {
  name: 'demo',
  version: '1.0.0',
  schema: 'demo',
  migrationsDir: '',
  tools: [
    {
      name: 'demo.read',
      description: 'Read a thing.',
      tier: 'auto',
      input: z.object({ what: z.string() }),
      async execute(input: { what: string }) {
        return { read: input.what };
      },
    },
    {
      name: 'demo.send',
      description: 'Send a thing.',
      tier: 'gated',
      input: z.object({ to: z.string(), body: z.string() }),
      describe: (input) => ({
        envelope: { to: input.to, body: input.body },
        preview: `Send "${input.body}" to ${input.to}`,
      }),
      async execute(input: { to: string; body: string }, ctx: CoreToolContext) {
        sent.push({ to: input.to, ...(ctx.actionId ? { actionId: ctx.actionId } : {}) });
        return { delivered: true };
      },
    },
    {
      // The shape the developer plugin's tools have: declared `session`, so
      // nothing but a live owner request in a top-level run may reach it.
      name: 'demo.session',
      description: 'Only reachable while the owner is asking.',
      tier: 'session',
      input: z.object({ what: z.string() }),
      async execute(input: { what: string }, ctx: CoreToolContext) {
        sessionCalls.push({ what: input.what, ctx });
        return { did: input.what };
      },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * A scripted provider. Each turn takes the next script entry, so a test
 * says exactly what the model does and the loop is otherwise real.
 * ------------------------------------------------------------------ */

type Turn = (req: CompletionRequest) => CompletionResponse;

const say = (text: string): Turn => () => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { input: 10, output: 5 },
  model: 'fake-model',
});

const call = (id: string, name: string, input: unknown): Turn => () => ({
  content: [{ type: 'tool_use', id, name, input } as never],
  stopReason: 'tool_use',
  usage: { input: 10, output: 5 },
  model: 'fake-model',
});

class ScriptedProvider implements RuntimeProvider {
  script: Turn[] = [];
  /** Held open by a test that wants a run in flight it can cancel. */
  block: (() => void) | null = null;
  readonly seen: CompletionRequest[] = [];

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // The loop appends to the very array it hands over, so what is recorded
    // has to be a copy — otherwise every request looks like the last one.
    this.seen.push(JSON.parse(JSON.stringify(req)) as CompletionRequest);
    if (this.block) {
      await new Promise<void>((resolve, reject) => {
        this.block = resolve;
        req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
      });
    }
    const next = this.script.shift();
    if (!next) return say('done')(req);
    return next(req);
  }
}

const provider = new ScriptedProvider();

/* ------------------------------------------------------------------ *
 * One agent, no files on disk.
 * ------------------------------------------------------------------ */

const AGENT_ID = 'demo-agent';

const fakeCatalog = (): AgentCatalog => {
  const agent = {
    id: AGENT_ID,
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
    tools: ['demo.read', 'demo.send', 'demo.session'],
    maxTurns: 6,
    language: 'mirror' as const,
    provider: {
      kind: 'anthropic' as const,
      model: 'claude-test',
      credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
    },
    skills: [],
    systemPromptTemplate: 'you are a demo',
    definition: () => ({
      id: AGENT_ID,
      name: 'Demo',
      systemPrompt: 'you are a demo',
      tools: ['demo.read', 'demo.send', 'demo.session'],
      provider: {
        kind: 'anthropic' as const,
        model: 'claude-test',
        credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
      },
      maxTurns: 6,
    }),
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
    byHandle: (handle: string) => (handle === agent.handle ? (agent as never) : undefined),
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
 * A cookie-aware client, with an SSE reader.
 * ------------------------------------------------------------------ */

interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

class Client {
  readonly cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  get csrf(): string {
    return this.cookies.get(csrfCookieName(portOf(new URL(this.base)))) ?? '';
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

  async json<T>(path: string, expected = 200): Promise<T> {
    const res = await this.get(path);
    expect(res.status, `GET ${path}`).toBe(expected);
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

  /** Upload one file as a browser would. */
  async upload(
    path: string,
    file: { name: string; type: string; bytes: Buffer },
    opts: { csrf?: string | null; origin?: string | null } = {},
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
    const headers: Record<string, string> = {};
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf !== null) headers['x-buddi-csrf'] = csrf;
    const origin = opts.origin === undefined ? this.base : opts.origin;
    if (origin !== null) headers.origin = origin;
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
      headers: { ...this.header(), ...headers },
    });
    this.absorb(res);
    return res;
  }

  /**
   * Open a stream and collect frames until `until` is satisfied (or the clock
   * runs out). Returns the events and closes the connection.
   */
  async stream(
    path: string,
    until: (events: SseEvent[]) => boolean,
    timeoutMs = 15_000,
  ): Promise<SseEvent[]> {
    const controller = new AbortController();
    const res = await fetch(`${this.base}${path}`, {
      headers: this.header(),
      signal: controller.signal,
    });
    expect(res.status, `stream ${path}`).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const events: SseEvent[] = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline) {
        const read = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
          ),
        ]);
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const frame: SseEvent = { event: '', data: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          if (frame.event !== '') events.push(frame);
          split = buffer.indexOf('\n\n');
        }
        if (until(events)) break;
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    return events;
  }
}

/* ------------------------------------------------------------------ */

suite('the dashboard chat API', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let registry: ToolRegistry;
  let ctx: CoreToolContext;
  let base: string;

  /**
   * One server, started the way the composition root starts it. A function
   * rather than a single instance because the rate limiter and the session
   * store live in *this process's* memory: a test about being refused needs a
   * server of its own, or it spends a budget the other tests are counting on.
   */
  const startServer = async (over: Partial<WebServerDeps> = {}): Promise<WebServer> =>
    startWebServer({
      pool,
      registry,
      catalog: fakeCatalog(),
      ctx,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      jobs: undefined,
      log: () => {},
      chat: {
        providerFor: () => provider,
        artifacts: createCoreArtifactStore({ pool, env: process.env }),
      },
      ...over,
    });

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
    ctx = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    await ensureOwner(pool, 'owner');

    web = await startServer();
    base = `http://127.0.0.1:${web.port}`;
  }, 60_000);

  afterAll(async () => {
    await web?.chat?.drain();
    await web?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    sessionCalls.length = 0;
    provider.script = [];
    provider.block = null;
    provider.seen.length = 0;
    await pool.query('truncate core.effect_attempts, core.approvals, core.actions cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
    await pool.query('truncate core.artifacts cascade');
    // Onboarding is claimed once per installation, and a first-run turn is not
    // what these tests are about — so it starts already finished. Idempotent,
    // like every accessor in that module.
    await completeOnboarding(pool, 'test');
  });

  const signedIn = async (): Promise<Client> => {
    const client = new Client(base);
    const res = await client.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`);
    expect(res.status).toBe(302);
    return client;
  };

  /** Wait until the conversation's last run has closed. */
  const settled = async (conversationId: string, runs = 1): Promise<void> => {
    for (let i = 0; i < 300; i += 1) {
      const { rows } = await pool.query(
        `select count(*)::int as n from core.events
          where conversation_id = $1::uuid and kind in ('run.finished', 'chat.run.failed')`,
        [conversationId],
      );
      if (Number(rows[0].n) >= runs) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`conversation ${conversationId} never settled`);
  };

  /* ---------------- reads ---------------- */

  it('lists the agents a message may be addressed to, and the default', async () => {
    const client = await signedIn();
    const body = await client.json<any>('/api/chat/agents');
    expect(body.defaultAgentId).toBe(AGENT_ID);
    expect(body.agents[0]).toMatchObject({
      id: AGENT_ID,
      handle: 'demo',
      available: true,
      roles: [ROLE_OVERVIEW],
      provider: 'anthropic',
      model: 'claude-test',
    });
  });

  it('serves the installed plugins view descriptors, and nothing a plugin did not declare', async () => {
    const client = await signedIn();
    const body = await client.json<any>('/api/chat/views');
    // The demo plugin declares none, so the page falls back to `structured`.
    expect(Array.isArray(body.views)).toBe(true);
    expect(body.views).toHaveLength(0);
  });

  /* ---------------- sending ---------------- */

  it('accepts a message with 202, creates the conversation, and answers on the stream', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.read', { what: 'the ledger' }), say('I read it.')];

    const res = await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'read the ledger' });
    expect(res.status).toBe(202);
    const { conversationId, runId } = (await res.json()) as any;
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    await settled(conversationId);

    // The stream replays the whole run from the beginning of the log.
    const events = await client.stream(
      `/api/chat/conversations/${conversationId}/stream?since=0`,
      (all) => all.some((e) => e.event === 'run.finished'),
    );
    const names = events.filter((e) => e.event !== 'ping').map((e) => e.event);
    expect(names).toEqual([
      'message.appended',
      'run.started',
      'tool.called',
      'tool.result',
      'message.appended',
      'run.finished',
    ]);

    const started = events.find((e) => e.event === 'run.started');
    expect(started?.data).toMatchObject({ agentId: AGENT_ID, runId, surface: 'web' });
    expect(events.find((e) => e.event === 'tool.called')?.data).toMatchObject({
      name: 'demo.read',
      input: { what: 'the ledger' },
    });
    expect(events.find((e) => e.event === 'tool.result')?.data).toMatchObject({
      name: 'demo.read',
      ok: true,
    });
    expect(events.find((e) => e.event === 'run.finished')?.data).toMatchObject({
      stopped: 'end_turn',
      turns: 2,
      usage: { input: 20, output: 10 },
    });
    // Every event carries the log id it came from, so a reconnect is exact.
    expect(events.filter((e) => e.event !== 'ping').every((e) => /^\d+$/.test(e.id ?? ''))).toBe(true);
  });

  it('replays from ?since and loses nothing across a reconnect', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.read', { what: 'a' }), say('done')];
    const first = (await (await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'go' })).json()) as any;
    await settled(first.conversationId);

    const all = await client.stream(
      `/api/chat/conversations/${first.conversationId}/stream?since=0`,
      (e) => e.some((x) => x.event === 'run.finished'),
    );
    const real = all.filter((e) => e.event !== 'ping');
    const cut = real[2] as SseEvent;

    // Reconnect from the third event: exactly the tail, and nothing before it.
    const resumed = await client.stream(
      `/api/chat/conversations/${first.conversationId}/stream?since=${cut.id}`,
      (e) => e.some((x) => x.event === 'run.finished'),
    );
    expect(resumed.filter((e) => e.event !== 'ping').map((e) => e.id)).toEqual(
      real.slice(3).map((e) => e.id),
    );

    // `Last-Event-ID` is the same cursor by another name.
    const viaHeader = await client.stream(
      `/api/chat/conversations/${first.conversationId}/stream`,
      (e) => e.some((x) => x.event === 'run.finished'),
      2_000,
    );
    // With no cursor at all the stream starts from now, so a finished run is
    // not replayed — only the opening ping arrives.
    expect(viaHeader.every((e) => e.event === 'ping')).toBe(true);
  });

  it('queues a second message instead of interleaving it', async () => {
    const client = await signedIn();
    provider.script = [say('first answer'), say('second answer')];

    const first = (await (await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'one' })).json()) as any;
    // The first turn is over before the second is sent: a message that lands
    // while a run is still going is delivered *inside* that run (the same
    // runId, by design), which on a slow machine is what this used to race.
    await settled(first.conversationId, 1);
    const second = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, {
        conversationId: first.conversationId,
        text: 'two',
      })
    ).json()) as any;
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.runId).not.toBe(first.runId);

    await settled(first.conversationId, 2);
    await web.chat?.drain();

    // The runs do not overlap: the second starts after the first finished.
    const { rows } = await pool.query(
      `select kind, payload->>'runId' as run_id, id from core.events
        where conversation_id = $1::uuid and kind in ('run.started', 'run.finished')
        order by id asc`,
      [first.conversationId],
    );
    expect(rows.map((r) => [r.kind, r.run_id])).toEqual([
      ['run.started', first.runId],
      ['run.finished', first.runId],
      ['run.started', second.runId],
      ['run.finished', second.runId],
    ]);

    // And the second run saw the first turn in its history, in order.
    const transcript = await client.json<any>(`/api/chat/conversations/${first.conversationId}`);
    const texts = transcript.messages.flatMap((m: any) =>
      m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text),
    );
    expect(texts).toEqual(['one', 'first answer', 'two', 'second answer']);
  });

  /* ---------------- the transcript ---------------- */

  it('reads back a transcript with the tool name joined onto its result', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.read', { what: 'x' }), say('there it is')];
    const { conversationId } = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'look' })
    ).json()) as any;
    await settled(conversationId);

    const transcript = await client.json<any>(`/api/chat/conversations/${conversationId}`);
    expect(transcript).toMatchObject({ conversationId, agentId: AGENT_ID });

    const blocks = transcript.messages.flatMap((m: any) => m.blocks);
    const use = blocks.find((b: any) => b.type === 'tool_use');
    const result = blocks.find((b: any) => b.type === 'tool_result');
    expect(use).toMatchObject({ id: 't1', name: 'demo.read', input: { what: 'x' } });
    // The join: the result carries the name of the call it answers.
    expect(result).toMatchObject({ toolUseId: 't1', name: 'demo.read', ok: true, output: { read: 'x' } });

    expect(transcript.runs).toHaveLength(1);
    expect(transcript.runs[0]).toMatchObject({
      stopped: 'end_turn',
      surface: 'web',
      turns: 2,
      usage: { input: 20, output: 10 },
    });
    expect(transcript.usage).toEqual({ input: 20, output: 10 });

    // The conversation shows up in the agent's own list, with its opening line.
    const listed = await client.json<any>(`/api/chat/${AGENT_ID}/conversations`);
    expect(listed.conversations[0]).toMatchObject({ id: conversationId, preview: 'look', messageCount: 4 });

    expect(
      (await client.get('/api/chat/conversations/00000000-0000-0000-0000-000000000000')).status,
    ).toBe(404);
  });

  it('opens a fresh conversation on request, and refuses one that belongs elsewhere', async () => {
    const client = await signedIn();
    const created = await client.post(`/api/chat/${AGENT_ID}/conversations`);
    expect(created.status).toBe(200);
    const { conversationId } = (await created.json()) as any;
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ('somebody-else') returning id`,
    );
    const foreign = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      conversationId: String(rows[0].id),
      text: 'hello',
    });
    expect(foreign.status).toBe(409);

    expect((await client.post('/api/chat/nope/conversations')).status).toBe(404);
    expect((await client.post(`/api/chat/${AGENT_ID}/messages`, { text: '   ' })).status).toBe(400);
  });

  /* ---------------- how long a conversation lasts ---------------- */

  /*
   * The dashboard's own version of the runaway: the page opens on this agent's
   * most recent conversation, which is the right thing to *draw* at rest and
   * the wrong thing to *continue* when the most recent one is yesterday's. The
   * SQL is exercised here rather than against a fake, because the rule reads a
   * transcript and the sum of its sizes.
   */
  it('continues a live conversation, and answers into it', async () => {
    const client = await signedIn();
    provider.script = [say('One.'), say('Two.')];
    const first = await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'any new mail?' });
    const { conversationId } = (await first.json()) as any;
    await settled(conversationId);

    const second = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      conversationId,
      text: 'and the other one?',
    });
    const body = (await second.json()) as any;
    expect(body.conversationId).toBe(conversationId);
    expect(body.boundary).toBeUndefined();
    await settled(conversationId, 2);
  });

  it('starts a fresh conversation for a message the next morning, and says nothing about it', async () => {
    const client = await signedIn();
    provider.script = [say('One.'), say('Two.')];
    const first = await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'any new mail?' });
    const { conversationId } = (await first.json()) as any;
    await settled(conversationId);

    // The owner closes the laptop and comes back after breakfast.
    await pool.query(
      `update core.messages set created_at = now() - interval '14 hours'
        where conversation_id = $1::uuid`,
      [conversationId],
    );

    const second = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      conversationId,
      text: 'any new mail?',
    });
    const body = (await second.json()) as any;
    expect(body.conversationId).not.toBe(conversationId);
    // The page follows the new id and is told nothing else: no note to print
    // above a thread whose emptiness costs the owner nothing.
    expect(body.boundary).toBeUndefined();
    await settled(body.conversationId);

    // Nothing of yesterday was replayed, and the boundary is on the record.
    const sentMessages = provider.seen.at(-1)?.messages ?? [];
    expect(sentMessages).toHaveLength(1);
    const { rows } = await pool.query(
      `select payload from core.events
        where conversation_id = $1::uuid and kind = 'chat.conversation.started'`,
      [body.conversationId],
    );
    expect(rows[0]?.payload).toMatchObject({
      reason: 'idle',
      previousConversationId: conversationId,
    });
  });

  it('does not resurrect a failed turn when the next message arrives', async () => {
    const client = await signedIn();
    const boom = new Error('fetch failed');
    provider.script = [
      () => {
        throw boom;
      },
      say('Here is the Dorothée draft.'),
    ];

    const first = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      text: 'draft a response to Parfait Sedjro',
    });
    const { conversationId } = (await first.json()) as any;
    await settled(conversationId);

    const second = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      conversationId,
      text: 'can you draft a reply to the mail of Dorothee Tabiou?',
    });
    expect(((await second.json()) as any).conversationId).toBe(conversationId);
    await settled(conversationId, 2);

    // The dead question is still in the record, followed by the turn that says
    // it failed — so the run that succeeded was never asked to answer it.
    const history = provider.seen.at(-1)?.messages ?? [];
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(history[1])).toContain('This turn failed before I could answer');
  });

  /* ---------------- attachments ---------------- */

  it('stores an uploaded file and hands it to the next message', async () => {
    const client = await signedIn();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await client.upload('/api/chat/attachments', {
      name: 'receipt.png',
      type: 'image/png',
      bytes: png,
    });
    expect(res.status).toBe(200);
    const stored = (await res.json()) as any;
    expect(stored).toMatchObject({
      filename: 'receipt.png',
      mime: 'image/png',
      kind: 'image',
      sizeBytes: png.length,
    });
    expect(stored.artifactId).toMatch(/^[0-9a-f-]{36}$/);

    // It is a real artifact row, stored by core, not a record this route kept.
    const { rows } = await pool.query(
      `select source_surface, size_bytes from core.artifacts where id = $1::uuid`,
      [stored.artifactId],
    );
    expect(rows[0]).toMatchObject({ source_surface: 'web' });

    provider.script = [say('I can see it.')];
    const sentMessage = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, {
        text: 'what is this?',
        attachmentIds: [stored.artifactId],
      })
    ).json()) as any;
    await settled(sentMessage.conversationId);

    // The run actually received the file: the reference is in the stored turn,
    // and the bytes were hydrated into what the provider was sent.
    const transcript = await client.json<any>(
      `/api/chat/conversations/${sentMessage.conversationId}`,
    );
    const attachment = transcript.messages[0].blocks.find((b: any) => b.type === 'attachment');
    expect(attachment).toMatchObject({
      artifactId: stored.artifactId,
      filename: 'receipt.png',
      mime: 'image/png',
      kind: 'image',
    });
    const firstUserTurn = provider.seen[0]?.messages.at(-1) as any;
    const image = firstUserTurn.content.find((b: any) => b.type === 'image');
    expect(image).toMatchObject({ mime: 'image/png', data: png.toString('base64') });
    // The note naming the artifact id rides along, so the agent can fetch it.
    expect(JSON.stringify(firstUserTurn)).toContain(stored.artifactId);
    // And the persisted turn holds the reference, never the bytes.
    const { rows: stored_turn } = await pool.query(
      `select content from core.messages
        where conversation_id = $1::uuid and role = 'user'
        order by created_at asc limit 1`,
      [sentMessage.conversationId],
    );
    expect(JSON.stringify(stored_turn[0].content)).not.toContain(png.toString('base64'));
  });

  it('keeps a file the model cannot look at, so the agent can reach it by tool', async () => {
    const client = await signedIn();
    const res = await client.upload('/api/chat/attachments', {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes: Buffer.from('not really a video'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ filename: 'clip.mp4', mime: 'video/mp4' });
  });

  it('refuses a message naming an attachment that does not exist', async () => {
    const client = await signedIn();
    const res = await client.post(`/api/chat/${AGENT_ID}/messages`, {
      text: 'here',
      attachmentIds: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(res.status).toBe(404);
  });

  /* ---------------- approvals ---------------- */

  it('stops on a gated tool, and approving through the existing route resumes the run', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.send', { to: 'a@example.test', body: 'hi' })];

    const { conversationId } = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'send it' })
    ).json()) as any;
    await settled(conversationId);

    const events = await client.stream(
      `/api/chat/conversations/${conversationId}/stream?since=0`,
      (e) => e.some((x) => x.event === 'awaiting-approval'),
    );
    const waiting = events.find((e) => e.event === 'awaiting-approval');
    expect(waiting).toBeDefined();
    const actionId = waiting?.data.actionId as string;
    expect(actionId).toMatch(/^[0-9a-f-]{36}$/);
    // The run ended as suspended, not as finished work.
    expect(events.find((e) => e.event === 'run.finished')?.data).toMatchObject({
      stopped: 'awaiting-approval',
    });

    // The single-action read the canvas draws from: the whole envelope, and the
    // preview the tool rendered.
    const one = await client.json<any>(`/api/approvals/${actionId}`);
    expect(one.action).toMatchObject({
      id: actionId,
      tool: 'demo.send',
      state: 'pending',
      preview: 'Send "hi" to a@example.test',
      envelope: { to: 'a@example.test', body: 'hi' },
    });

    // Approving goes through the route that already existed. No second path.
    provider.script = [say('sent it')];
    const decided = await client.post(`/api/approvals/${actionId}/approve`);
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as any).action.state).toBe('succeeded');
    expect(sent).toEqual([{ to: 'a@example.test', actionId }]);

    // Exactly one effect-ledger row, as on every other surface.
    const { rows: ledger } = await pool.query(
      `select attempt, state from core.effect_attempts where action_id = $1 order by attempt`,
      [actionId],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].state).toBe('succeeded');

    // And it was the dashboard that decided it.
    const { rows: approval } = await pool.query(
      `select decided_via from core.approvals where action_id = $1`,
      [actionId],
    );
    expect(approval[0].decided_via).toBe('web');

    expect((await client.get('/api/approvals/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  /**
   * The run a decision wakes is still the owner asking.
   *
   * Deciding an approval is the owner acting, at this keyboard, in this
   * conversation — so the resumed run carries an owner request of its own and a
   * `session` tool keeps working across the approval. Before this, the resumed
   * run was handed the bare context and the very next narrow call came back
   * `session-not-authorized`.
   */
  it('gives the run resumed by an approval an owner request, so a session tool still works', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.send', { to: 'a@example.test', body: 'hi' })];
    const { conversationId } = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'send it, then look' })
    ).json()) as any;
    await settled(conversationId);

    const { rows } = await pool.query(`select id from core.actions order by created_at desc limit 1`);
    const actionId = rows[0].id as string;

    // The resumed run narrows straight into the session tool.
    provider.script = [call('t2', 'demo.session', { what: 'narrow' }), say('looked.')];
    expect((await client.post(`/api/approvals/${actionId}/approve`)).status).toBe(200);
    await settled(conversationId, 2);

    expect(sessionCalls).toHaveLength(1);
    const seen = sessionCalls[0] as { what: string; ctx: CoreToolContext };
    expect(seen.what).toBe('narrow');
    // No record holds the words of the turn the action came from, so the
    // request is named after the decision itself.
    expect(seen.ctx.ownerRequest?.text).toBe('approved demo.send');
    expect(seen.ctx.ownerRequest?.expiresAt).toBeGreaterThan(Date.now());
    expect(seen.ctx.sessionTools).toContain('demo.session');
    // It ran: the model got an output, not a refusal.
    const results = provider.seen.at(-1)?.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content : []) ?? [];
    expect(results.some((b: any) => b.type === 'tool_result' && JSON.stringify(b).includes('narrow'))).toBe(true);
  });

  /**
   * And it stays the *owner's* standing. A delegate inherits the conversation
   * but never the request: same context, one step down, still refused.
   */
  it('does not let a delegate of the resumed run reach the session tool', async () => {
    const client = await signedIn();
    provider.script = [call('t1', 'demo.send', { to: 'a@example.test', body: 'hi' })];
    const { conversationId } = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'send it' })
    ).json()) as any;
    await settled(conversationId);
    const { rows } = await pool.query(`select id from core.actions order by created_at desc limit 1`);
    provider.script = [call('t2', 'demo.session', { what: 'narrow' }), say('looked.')];
    expect((await client.post(`/api/approvals/${rows[0].id}/approve`)).status).toBe(200);
    await settled(conversationId, 2);
    const seen = (sessionCalls[0] as { ctx: CoreToolContext }).ctx;

    sessionCalls.length = 0;
    const delegated = await registry.invoke('demo.session', { what: 'narrow' }, { ...seen, delegationDepth: 1 });
    expect(delegated).toMatchObject({ ok: false, reason: 'session-not-authorized' });
    expect(sessionCalls).toHaveLength(0);
  });

  /* ---------------- offered actions ---------------- */

  /**
   * The dashboard half of offers in a live conversation.
   *
   * Everything here is the *same* mechanism the unattended path already had —
   * `core.offers`, the atomic claim, the take route — and the only new thing is
   * that an interactive turn can declare a set. So what these tests are really
   * about is the three rules that keep it honest: the chips belong to the turn
   * that offered them, one of them can be taken exactly once however many
   * surfaces are looking, and taking one authorizes nothing.
   */
  /**
   * The dashboard used to show *nothing* when a turn failed: the spinner
   * stopped and that was the whole message. The page never sees the raw error
   * either — `error` is the cause chain, for the record, and `message` is what
   * a person reads.
   */
  describe('a turn that fails', () => {
    const failing = (err: unknown): Turn => () => {
      throw err;
    };

    it('says something human on the stream, keeps the cause chain for the record', async () => {
      const client = await signedIn();
      provider.script = [
        failing(
          Object.assign(
            new TypeError('fetch failed', {
              cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
            }),
            { type: 'transport_error', status: 0 },
          ),
        ),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply to Parfait' })
      ).json()) as any;
      await settled(conversationId);

      const { rows } = await pool.query(
        `select payload from core.events
          where conversation_id = $1::uuid and kind = 'chat.run.failed'`,
        [conversationId],
      );
      const payload = rows[0].payload as Record<string, string>;
      expect(payload.message).toContain("couldn't reach the model");
      expect(payload.message).not.toContain('fetch failed');
      expect(payload.failureClass).toBe('transient');
      expect(payload.error).toContain('UND_ERR_SOCKET');
    });

    it('leaves a "Try again" chip that carries the owner\u2019s own words', async () => {
      const client = await signedIn();
      provider.script = [
        failing(Object.assign(new Error('fetch failed'), { type: 'transport_error', status: 0 })),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'what is due today?' })
      ).json()) as any;
      await settled(conversationId);

      const offers = ((await client.json<any>(`/api/chat/conversations/${conversationId}`))
        .offers ?? []) as any[];
      expect(offers.map((o) => o.label)).toEqual(['Try again']);
      expect(offers[0].prompt).toBe('what is due today?');
    });

    it('offers nothing when the turn had already called a tool', async () => {
      const client = await signedIn();
      provider.script = [
        call('t-read', 'demo.read', { what: 'the ledger' }),
        failing(Object.assign(new Error('fetch failed'), { type: 'transport_error', status: 0 })),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'read it for me' })
      ).json()) as any;
      await settled(conversationId);

      const view = await client.json<any>(`/api/chat/conversations/${conversationId}`);
      expect(view.offers ?? []).toEqual([]);
      const { rows } = await pool.query(
        `select payload from core.events
          where conversation_id = $1::uuid and kind = 'chat.run.failed'`,
        [conversationId],
      );
      expect((rows[0].payload as Record<string, string>).message).toContain('one step');
    });
  });

  describe('offered actions', () => {
    const declare = (actions: { label: string; prompt: string }[]) =>
      call('t-offer', 'conversation.offer', { actions });

    const offersOf = async (client: Client, conversationId: string): Promise<any[]> =>
      ((await client.json<any>(`/api/chat/conversations/${conversationId}`)).offers ?? []);

    it('reads back what the turn offered, and takes one exactly once', async () => {
      const client = await signedIn();
      provider.script = [
        declare([
          { label: 'Send it', prompt: 'send the reply I drafted to Dorothée' },
          { label: 'Edit the draft', prompt: 'change the second paragraph of that reply' },
        ]),
        say("The draft is ready. It hasn't been sent."),
      ];

      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply to Dorothée' })
      ).json()) as any;
      await settled(conversationId);

      const offers = await offersOf(client, conversationId);
      expect(offers.map((o) => o.label)).toEqual(['Send it', 'Edit the draft']);
      // The prompt rides along: the owner can read what a chip will ask before
      // they click it, which is the whole reason it is safe to click.
      expect(offers[0].prompt).toBe('send the reply I drafted to Dorothée');

      // Claim-once, across two surfaces: a thumb on Telegram gets there first.
      const { rows: claimed } = await pool.query(
        `update core.offers set taken_at = now(), taken_via = 'telegram' where id = $1 returning id`,
        [offers[0].id],
      );
      expect(claimed).toHaveLength(1);
      const second = await client.post(`/api/offers/${offers[0].id}/take`);
      expect(second.status).toBe(409);
      expect(((await second.json()) as any).error).toMatch(/already/i);

      // The other one is still on the table, and the dashboard can take it.
      const taken = await client.post(`/api/offers/${offers[1].id}/take`);
      expect(taken.status).toBe(200);
      expect(((await taken.json()) as any).label).toBe('Edit the draft');
      expect(await offersOf(client, conversationId)).toHaveLength(0);
    });

    it('takes a chip in the open thread as a turn of it, and queues nothing', async () => {
      const client = await signedIn();
      provider.script = [
        declare([{ label: 'Send it', prompt: 'send the reply I drafted to Dorothée' }]),
        say("The draft is ready. It hasn't been sent."),
        say('Sent.'),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply to Dorothée' })
      ).json()) as any;
      await settled(conversationId);
      const [offer] = await offersOf(client, conversationId);

      // Clicked in the conversation that offered it: the page says where it is,
      // and the take runs there rather than queueing a run whose answer arrives
      // somewhere the owner is not looking.
      const res = await client.post(`/api/offers/${offer.id}/take`, { conversationId });
      expect(res.status).toBe(200);
      const took = (await res.json()) as any;
      expect(took).toMatchObject({ label: 'Send it', jobId: null, conversationId });
      expect(took.runId).toMatch(/^[0-9a-f-]{36}$/);
      await settled(conversationId, 2);

      // The transcript shows what the owner *did*: the chip's label, stamped
      // with where it came from, with the sentence the agent wrote behind it.
      const view = await client.json<any>(`/api/chat/conversations/${conversationId}`);
      const turn = (view.messages as any[]).find((m: any) => m.speaker === 'offer:Send it');
      expect(turn).toBeDefined();
      expect(turn.role).toBe('user');
      expect(turn.blocks[0].text).toBe('send the reply I drafted to Dorothée');
      // And the answer to it is in the same thread, under it.
      const texts = (view.messages as any[])
        .filter((m: any) => m.role === 'assistant')
        .flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text));
      expect(texts).toContain('Sent.');

      // Nothing was queued: no job row, and no job stamped on the offer.
      const { rows } = await pool.query('select taken_via, taken_job_id from core.offers where id = $1', [offer.id]);
      expect(rows[0].taken_via).toBe('web');
      expect(rows[0].taken_job_id).toBeNull();
      const { rows: jobs } = await pool.query(
        'select count(*)::int as n from core.jobs where dedup_key = $1',
        [`offer:${offer.id}`],
      );
      expect(jobs[0].n).toBe(0);
      // The chip is gone from the thread: taken, not still on the table.
      expect(await offersOf(client, conversationId)).toEqual([]);
    });

    it('refuses an expired chip with a sentence the page can show', async () => {
      const client = await signedIn();
      provider.script = [
        declare([{ label: 'Send it', prompt: 'send the reply I drafted' }]),
        say('Drafted.'),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply' })
      ).json()) as any;
      await settled(conversationId);
      const [offer] = await offersOf(client, conversationId);

      // A week later, on a page that has been open all along.
      await pool.query(
        "update core.offers set expires_at = now() - interval '1 minute' where id = $1",
        [offer.id],
      );
      // It is not offered any more...
      expect(await offersOf(client, conversationId)).toEqual([]);
      // ...and clicking the one the page still holds says so, in words.
      const late = await client.post(`/api/offers/${offer.id}/take`, { conversationId });
      expect(late.status).toBe(409);
      expect(((await late.json()) as any).error).toBe('This offer has expired.');
      // Nothing ran: the transcript is the one turn it always was.
      const view = await client.json<any>(`/api/chat/conversations/${conversationId}`);
      expect(
        (view.messages as any[]).some(
          (m: any) => typeof m.speaker === 'string' && m.speaker.startsWith('offer:'),
        ),
      ).toBe(false);
    });

    it('adds nothing to a turn that offered nothing', async () => {
      const client = await signedIn();
      // The database's own clock, for a column the database stamps: what this
      // test asserts is that *its* turn wrote no offer, not that the table is
      // empty. A whole-table count would be a claim about its neighbours.
      const { rows: clock } = await pool.query<{ now: Date }>(
        'select clock_timestamp() as now',
      );
      const before = new Date(clock[0]!.now);
      provider.script = [say('Nothing due.')];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'anything due?' })
      ).json()) as any;
      await settled(conversationId);
      expect(await offersOf(client, conversationId)).toEqual([]);
      const { rows } = await pool.query(
        `select count(*)::int as n from core.offers
          where created_at > $1::timestamptz
            and (conversation_id is null or conversation_id = $2::uuid)`,
        [before.toISOString(), conversationId],
      );
      expect(rows[0].n).toBe(0);
    });

    it('lapses them when the conversation moves on, and a late click is refused', async () => {
      const client = await signedIn();
      provider.script = [
        declare([{ label: 'Send it', prompt: 'send the reply I drafted' }]),
        say('Drafted.'),
        say('Sure — something else.'),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply' })
      ).json()) as any;
      await settled(conversationId);
      const [offer] = await offersOf(client, conversationId);
      expect(offer.label).toBe('Send it');

      // The owner ignores the chip and says something else. An offer belongs to
      // the turn that made it, so the next turn retires it.
      await client.post(`/api/chat/${AGENT_ID}/messages`, { conversationId, text: 'never mind' });
      await settled(conversationId, 2);

      expect(await offersOf(client, conversationId)).toEqual([]);
      const late = await client.post(`/api/offers/${offer.id}/take`);
      expect(late.status).toBe(409);
      // Lapsed, which is what happened: they moved on. Not "expired" — the
      // clock had nothing to do with it — and not "already taken".
      expect(((await late.json()) as any).error).toMatch(/lapsed/i);
      // Recorded, not deleted: the row is still there, unclaimed, with why.
      const { rows } = await pool.query(
        'select taken_at, lapse_reason from core.offers where id = $1',
        [offer.id],
      );
      expect(rows[0].taken_at).toBeNull();
      expect(rows[0].lapse_reason).toBe('owner-moved-on');
    });

    it('takes a tapped "Send it" through the ordinary approval, with the whole body', async () => {
      const client = await signedIn();
      provider.script = [
        declare([{ label: 'Send it', prompt: 'send the reply I drafted to dorothee@example.test' }]),
        say("The draft is ready. It hasn't been sent."),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft a reply' })
      ).json()) as any;
      await settled(conversationId);
      const [offer] = await offersOf(client, conversationId);

      // Taking it claims the row and hands the run the prompt the *agent*
      // wrote. Nothing in the request could have carried a prompt of its own.
      expect((await client.post(`/api/offers/${offer.id}/take`)).status).toBe(200);
      const { rows: row } = await pool.query('select prompt, taken_via from core.offers where id = $1', [
        offer.id,
      ]);
      expect(row[0].prompt).toBe('send the reply I drafted to dorothee@example.test');
      expect(row[0].taken_via).toBe('web');

      // And that prompt, run, is an ordinary run: `demo.send` is gated, so it
      // stops dead and the owner is shown every recipient and the whole body.
      // Nothing was delivered by the tap.
      provider.script = [
        call('t-send', 'demo.send', {
          to: 'dorothee@example.test',
          body: 'Dear Dorothée, thank you for letting me know.',
        }),
      ];
      const { conversationId: runConversation } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: row[0].prompt })
      ).json()) as any;
      await settled(runConversation);

      const { rows: actions } = await pool.query(
        `select a.id, a.tool, a.preview, a.envelope, ap.state
           from core.actions a join core.approvals ap on ap.action_id = a.id
          order by a.created_at desc limit 1`,
      );
      expect(actions[0]).toMatchObject({ tool: 'demo.send', state: 'pending' });
      expect(actions[0].preview).toBe(
        'Send "Dear Dorothée, thank you for letting me know." to dorothee@example.test',
      );
      expect(actions[0].envelope).toEqual({
        to: 'dorothee@example.test',
        body: 'Dear Dorothée, thank you for letting me know.',
      });
      expect(sent).toEqual([]);
    });
  });

  /* ---------------- cancel ---------------- */

  /* ---------------- who is waiting on the owner ---------------- */

  /**
   * The agent rail draws a badge, and this is the whole definition behind it.
   *
   * The rule being protected is the *negative* one: activity earns nothing. A
   * turn that called six tools and answered is not a claim on anybody's
   * attention, and a dot that is always lit is a dot the owner learns to stop
   * reading. Only a suspended run and a held question count, and both clear
   * themselves — one when it is decided, the other when the owner writes back.
   */
  describe('who is waiting on the owner', () => {
    const attention = async (client: Client): Promise<any> =>
      client.json<any>('/api/chat/attention');

    it('says nothing about an agent that merely did some work', async () => {
      const client = await signedIn();
      provider.script = [call('t1', 'demo.read', { what: 'ledger' }), say('forty of them')];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'triage' })
      ).json()) as any;
      await settled(conversationId);

      expect((await attention(client)).agents).toEqual([]);
    });

    it('badges the agent whose run is suspended, and clears it when decided', async () => {
      const client = await signedIn();
      provider.script = [call('t1', 'demo.send', { to: 'a@example.test', body: 'hi' })];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'send it' })
      ).json()) as any;
      await settled(conversationId);

      const waiting = await attention(client);
      expect(waiting.agents).toHaveLength(1);
      expect(waiting.agents[0]).toMatchObject({ agentId: AGENT_ID, approvals: 1, question: null });
      expect(typeof waiting.agents[0].oldestApprovalAt).toBe('string');

      const { rows } = await pool.query(`select id from core.actions limit 1`);
      provider.script = [say('sent it')];
      expect((await client.post(`/api/approvals/${rows[0].id}/approve`)).status).toBe(200);

      // Decided is decided: the face goes quiet without anything sweeping it.
      expect((await attention(client)).agents).toEqual([]);
    });

    it('badges an agent holding a question, and clears it on the next message', async () => {
      const client = await signedIn();
      provider.script = [
        call('q1', 'conversation.ask', { question: 'Which card should I pay from?' }),
        say('Which card should I pay from?'),
      ];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'pay the bill' })
      ).json()) as any;
      await settled(conversationId);

      const held = await attention(client);
      expect(held.agents).toHaveLength(1);
      expect(held.agents[0]).toMatchObject({ agentId: AGENT_ID, approvals: 0 });
      expect(held.agents[0].question).toMatchObject({ conversationId });

      provider.script = [say('done')];
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'the blue one', conversationId });
      await settled(conversationId, 2);

      expect((await attention(client)).agents).toEqual([]);
    });

    it('pushes a frame on the attention stream when a claim appears', async () => {
      const client = await signedIn();
      provider.script = [call('t1', 'demo.send', { to: 'b@example.test', body: 'hi' })];
      const { conversationId } = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'send it' })
      ).json()) as any;
      await settled(conversationId);

      // `?since=0` replays the whole log, which is how a page that connects
      // after the fact is still told. The frame carries no payload on purpose:
      // it means "ask again", and the endpoint is the single definition.
      const frames = await client.stream('/api/chat/attention/stream?since=0', (e) =>
        e.some((x) => x.event === 'attention'),
      );
      expect(frames.filter((f) => f.event === 'attention').length).toBeGreaterThan(0);
    });

    it('refuses both attention routes without a session when the gate is closed', async () => {
      // Open on loopback, these routes answer instead of refusing — the gate
      // that stops an anonymous stranger is the closed one, driven here through
      // the same seam production never passes.
      const gated = await startServer({ openAccess: false });
      const gatedBase = `http://127.0.0.1:${gated.port}`;
      try {
        const anonymous = new Client(gatedBase);
        expect((await anonymous.get('/api/chat/attention')).status).toBe(401);
        expect((await anonymous.get('/api/chat/attention/stream')).status).toBe(401);
      } finally {
        await gated.close();
      }
    });
  });

  /* ---------------- a word in edgeways ---------------- */

  /**
   * The composer no longer refuses while the agent works. What it sends is
   * not a second run and it is not a `core.messages` row either — a row
   * written mid-tool-call would sit between a `tool_use` and its result, and
   * no provider will replay that. It waits in `core.pending_input`, with a
   * state of its own, until the run can take it into the turn that carries
   * the tool results, or until nobody takes it and it becomes the next turn.
   */
  describe('a message sent while the agent is working', () => {
    /** Wait until the provider has been called `n` times. */
    const calls = async (n: number): Promise<void> => {
      for (let i = 0; i < 400 && provider.seen.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(provider.seen.length).toBeGreaterThanOrEqual(n);
    };

    const pendingRows = async (conversationId: string): Promise<any[]> => {
      const { rows } = await pool.query(
        `select id, text, state, run_id, received_at, message_id from core.pending_input
          where conversation_id = $1::uuid order by received_at asc, id asc`,
        [conversationId],
      );
      return rows;
    };

    it('waits in its own table, rides in the tool-results turn, and is marked delivered after the model sees it', async () => {
      const client = await signedIn();
      provider.script = [call('t1', 'demo.read', { what: 'the ledger' }), say('In euros: 12.')];
      provider.block = () => {};

      const first = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'what did we spend?' })
      ).json()) as any;
      await calls(1);

      // Not a refusal and not a second run: the same run id comes back, with
      // the id of the row the message is while it waits.
      const res = await client.post(`/api/chat/${AGENT_ID}/messages`, {
        conversationId: first.conversationId,
        text: 'in euros, please',
      });
      expect(res.status).toBe(202);
      const queued = (await res.json()) as any;
      expect(queued).toMatchObject({ conversationId: first.conversationId, runId: first.runId, queued: true });
      expect(queued.pendingId).toMatch(/^[0-9a-f-]{36}$/);

      // Waiting, and nothing has been written to the transcript.
      expect(await pendingRows(first.conversationId)).toMatchObject([{ state: 'pending', text: 'in euros, please' }]);
      const { rows: early } = await pool.query(
        `select count(*)::int as n from core.messages where conversation_id = $1::uuid and content::text like '%in euros%'`,
        [first.conversationId],
      );
      expect(early[0].n).toBe(0);

      // The page sees it at the end of the thread, by its own id, marked.
      const midRun = await client.json<any>(`/api/chat/conversations/${first.conversationId}`);
      expect(midRun.messages.at(-1)).toMatchObject({
        id: queued.pendingId,
        role: 'user',
        speaker: 'owner:interjection',
        blocks: [{ type: 'text', text: 'in euros, please' }],
      });

      provider.block?.();
      await calls(2);
      provider.block?.();
      await settled(first.conversationId);

      // One run, and the second model step carries it *inside* the
      // tool-results turn: results first, the owner's addition after, and no
      // two user messages in a row anywhere in the request.
      const { rows: runs } = await pool.query(
        `select count(*)::int as n from core.events where conversation_id = $1::uuid and kind = 'run.started'`,
        [first.conversationId],
      );
      expect(runs[0].n).toBe(1);
      const sent = provider.seen[1]!.messages as any[];
      const last = sent.at(-1);
      expect(last.role).toBe('user');
      expect(last.content[0].type).toBe('tool_result');
      expect(JSON.stringify(last.content[1])).toContain('the owner adds: in euros, please');
      for (let i = 1; i < sent.length; i += 1) expect(sent[i].role).not.toBe(sent[i - 1].role);

      // Delivered only once a model was shown it, and pointed at the turn
      // that carries it.
      const after = await pendingRows(first.conversationId);
      expect(after[0].state).toBe('delivered');
      expect(after[0].message_id).not.toBeNull();
      const { rows: carrier } = await pool.query(
        `select content from core.messages where id = $1::uuid`,
        [after[0].message_id],
      );
      const blocks = carrier[0].content as any[];
      expect(blocks[0].type).toBe('tool_result');
      expect(blocks.at(-1)).toEqual({ type: 'text', text: 'in euros, please' });
      // And the owner's words are in the thread once, not twice.
      const transcript = await client.json<any>(`/api/chat/conversations/${first.conversationId}`);
      const said = JSON.stringify(transcript.messages).split('in euros, please').length - 1;
      expect(said).toBe(1);
    });

    it('refuses a file in a plain sentence rather than queueing it', async () => {
      const client = await signedIn();
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const stored = (await (
        await client.upload('/api/chat/attachments', { name: 'receipt.png', type: 'image/png', bytes: png })
      ).json()) as any;

      provider.script = [say('done')];
      provider.block = () => {};
      const first = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'hold on' })
      ).json()) as any;
      await calls(1);

      const res = await client.post(`/api/chat/${AGENT_ID}/messages`, {
        conversationId: first.conversationId,
        text: 'and this receipt',
        attachmentIds: [stored.artifactId],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toBe('Send files once the agent has answered.');
      // Nothing was queued: a refused message is not waiting anywhere.
      expect(await pendingRows(first.conversationId)).toHaveLength(0);

      provider.block?.();
      await settled(first.conversationId);
    });

    it('goes out as the next turn when the owner stops the run, joined in order into one new turn', async () => {
      const client = await signedIn();
      provider.script = [say('never said'), say('Yes — cancelled.')];
      provider.block = () => {};
      const first = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'draft the email' })
      ).json()) as any;
      await calls(1);

      for (const text of ['wait', 'do the other one first']) {
        const res = await client.post(`/api/chat/${AGENT_ID}/messages`, {
          conversationId: first.conversationId,
          text,
        });
        expect(((await res.json()) as any).queued).toBe(true);
      }
      const waiting = await pendingRows(first.conversationId);
      const receipts = waiting.map((r: any) => new Date(r.received_at).toISOString());

      // Stop still means stop: the run ends, and what was queued is the turn
      // that follows it — one turn, in the order it was typed.
      expect((await client.post(`/api/chat/conversations/${first.conversationId}/cancel`)).status).toBe(200);
      provider.block?.();
      provider.block = null;
      await web.chat?.drain();
      await settled(first.conversationId, 2);

      expect(JSON.stringify(provider.seen.at(-1)!.messages)).toContain('wait\\n\\ndo the other one first');
      // One new canonical turn carries both, and the queue rows point at it
      // with the time they were actually said left untouched.
      const promoted = await pendingRows(first.conversationId);
      expect(promoted.map((r: any) => r.state)).toEqual(['promoted', 'promoted']);
      expect(promoted.map((r: any) => new Date(r.received_at).toISOString())).toEqual(receipts);
      expect(new Set(promoted.map((r: any) => String(r.message_id))).size).toBe(1);
      const { rows: owner } = await pool.query(
        `select content from core.messages where id = $1::uuid`,
        [promoted[0].message_id],
      );
      expect(owner[0].content).toEqual([{ type: 'text', text: 'wait\n\ndo the other one first' }]);
      // Said once: the run that answered it did not write it again.
      const { rows: copies } = await pool.query(
        `select count(*)::int as n from core.messages
          where conversation_id = $1::uuid and role = 'user' and content::text like '%do the other one first%'`,
        [first.conversationId],
      );
      expect(copies[0].n).toBe(1);
    });

    it('answers what the owner said to a run that did not survive the restart', async () => {
      const client = await signedIn();
      provider.script = [say('anything')];
      const started = (await (
        await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'hello' })
      ).json()) as any;
      await settled(started.conversationId);

      // A row left behind by a run this process no longer has: what a crash
      // mid-run leaves in the table.
      await pool.query(
        `insert into core.pending_input (conversation_id, run_id, text, state)
         values ($1::uuid, null, 'and the other account?', 'leased')`,
        [started.conversationId],
      );

      provider.script = [say('Both, then.')];
      const recovered = await web.chat!.recoverPendingInput();
      expect(recovered).toBe(1);
      await web.chat?.drain();
      await settled(started.conversationId, 2);

      expect(JSON.stringify(provider.seen.at(-1)!.messages)).toContain('and the other account?');
      const rows = await pendingRows(started.conversationId);
      expect(rows.map((r: any) => r.state)).toEqual(['promoted']);
    });
  });

  it('cancels a run in flight, and says so on the stream', async () => {
    const client = await signedIn();
    // Hold the provider open so there is something to cancel.
    provider.block = () => {};
    const { conversationId, runId } = (await (
      await client.post(`/api/chat/${AGENT_ID}/messages`, { text: 'wait for me' })
    ).json()) as any;

    // Wait until the run is genuinely in flight.
    for (let i = 0; i < 200 && provider.seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(provider.seen.length).toBe(1);

    const cancelled = await client.post(`/api/chat/conversations/${conversationId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true });

    await settled(conversationId);
    const events = await client.stream(
      `/api/chat/conversations/${conversationId}/stream?since=0`,
      (e) => e.some((x) => x.event === 'run.finished'),
    );
    expect(events.find((e) => e.event === 'run.finished')?.data).toMatchObject({
      runId,
      stopped: 'cancelled',
    });

    // Nothing to cancel is `false`, not an error.
    const again = await client.post(`/api/chat/conversations/${conversationId}/cancel`);
    expect(await again.json()).toEqual({ cancelled: false });

    // Let the abandoned run finish so it cannot leak into the next test.
    provider.block?.();
    provider.block = null;
    await web.chat?.drain();
  });

  /* ---------------- the gate ---------------- */

  it('refuses every chat write without CSRF and from a foreign origin', async () => {
    const client = await signedIn();
    const writes: Array<[string, unknown]> = [
      [`/api/chat/${AGENT_ID}/messages`, { text: 'hello' }],
      [`/api/chat/${AGENT_ID}/conversations`, {}],
      ['/api/chat/conversations/00000000-0000-0000-0000-000000000000/cancel', {}],
    ];
    for (const [path, body] of writes) {
      expect((await client.post(path, body, { csrf: null })).status, path).toBe(403);
      expect((await client.post(path, body, { csrf: 'wrong' })).status, path).toBe(403);
      expect((await client.post(path, body, { origin: 'http://evil.test' })).status, path).toBe(403);
      expect((await client.post(path, body, { origin: null })).status, path).toBe(403);
    }

    // The upload is a write too, and takes the same gate — checked separately
    // because it is the one route that does not read a JSON body.
    const file = { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('hi') };
    expect((await client.upload('/api/chat/attachments', file, { csrf: null })).status).toBe(403);
    expect(
      (await client.upload('/api/chat/attachments', file, { origin: 'http://evil.test' })).status,
    ).toBe(403);

    // No CORS header is ever offered for any of it.
    const peek = await client.get('/api/chat/agents', { headers: { origin: 'http://evil.test' } });
    expect(peek.headers.get('access-control-allow-origin')).toBeNull();
  });
  /*
   * Ten failed authentications is exactly the rate limiter's per-address
   * budget, and the limiter lives in this process's memory, per server. So this
   * test gets a server of its own: the budget it spends is nobody else's, and
   * the file no longer depends on this test running last.
   */
  it('refuses every chat route without a session', async () => {
    const gated = await startServer({ openAccess: false });
    const gatedBase = `http://127.0.0.1:${gated.port}`;
    try {
      for (const [method, path] of [
        ['GET', '/api/chat/agents'],
        ['GET', '/api/chat/views'],
        ['GET', `/api/chat/${AGENT_ID}/conversations`],
        ['GET', '/api/chat/conversations/00000000-0000-0000-0000-000000000000'],
        ['GET', '/api/chat/conversations/00000000-0000-0000-0000-000000000000/stream'],
        ['GET', '/api/approvals/00000000-0000-0000-0000-000000000000'],
        ['POST', `/api/chat/${AGENT_ID}/messages`],
        ['POST', `/api/chat/${AGENT_ID}/conversations`],
        ['POST', '/api/chat/attachments'],
        ['POST', '/api/chat/conversations/00000000-0000-0000-0000-000000000000/cancel'],
      ] as const) {
        const res = await fetch(`${gatedBase}${path}`, {
          method,
          redirect: 'manual',
          ...(method === 'POST'
            ? { headers: { origin: gatedBase, 'x-buddi-csrf': 'anything' }, body: '{}' }
            : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await res.text()).toBe('');
      }
    } finally {
      await gated.close();
    }
  });

});
