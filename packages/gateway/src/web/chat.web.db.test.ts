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
  type ToolContext,
} from '@buddi/core';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_OVERVIEW } from '../agents/roles.js';
import { createCoreArtifactStore } from '../telegram/attachments.js';
import { mintTicket } from './token.js';
import { startWebServer, type WebServer } from './server.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_webchat_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

/* ------------------------------------------------------------------ *
 * A two-tool plugin: one `auto` read, one `gated` effect.
 * ------------------------------------------------------------------ */

const sent: Array<{ to: string; actionId?: string }> = [];

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
      async execute(input: { to: string; body: string }, ctx: ToolContext) {
        sent.push({ to: input.to, ...(ctx.actionId ? { actionId: ctx.actionId } : {}) });
        return { delivered: true };
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
      await new Promise<void>((resolve) => {
        this.block = resolve;
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
    tools: ['demo.read', 'demo.send'],
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
      tools: ['demo.read', 'demo.send'],
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
  let ctx: ToolContext;
  let base: string;

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

    web = await startWebServer({
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
    });
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

  it('refuses a file the runtime cannot use, naming what it can', async () => {
    const client = await signedIn();
    const res = await client.upload('/api/chat/attachments', {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes: Buffer.from('not really a video'),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as any;
    expect(body.error).toContain('clip.mp4');
    expect(body.error).toMatch(/PDFs/);
    expect(body.error).toMatch(/images/);
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

  /* ---------------- cancel ---------------- */

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
   * Deliberately last in the file: ten failed authentications is exactly the
   * rate limiter's per-address budget, so a test that needs to sign in must
   * not run after this one.
   */
  it('refuses every chat route without a session', async () => {
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
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        ...(method === 'POST'
          ? { headers: { origin: base, 'x-buddi-csrf': 'anything' }, body: '{}' }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.text()).toBe('');
    }
  });

});
