/**
 * An approval raised inside a delegation, end to end over the wire.
 *
 * @playground delegates to @art (the Illustrator); @art's `pic.draw` is gated
 * on its first use in the delegation's family of conversations, exactly the
 * rule the image plugin's `image.generate` follows. What is asserted:
 *
 *  - the approval is in the root conversation's dock, labelled with who asked,
 *    and still in @art's own thread; both agents' faces are badged;
 *  - the asker's run is paused on it (`awaiting-approval`), not handed an
 *    empty answer, and no process holds anything open while it waits;
 *  - deciding it from the root is the one decision: @art carries on, and its
 *    real answer resumes @playground as the result of its `agent.delegate`;
 *  - a rejection, and an expiry, come back to the asker as failures with why;
 *  - a second delegation from the same conversation is not asked again.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { bindDelegation, createDelegationManifest } from '../agents/delegation.js';
import { mintTicket } from './token.js';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName, portOf } from './http.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_delegation_web_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

/* ---------------- a picture tool, gated on its first use in the family ---------------- */

const drawn: string[] = [];

/**
 * The image plugin's rule, verbatim in shape: gated until the owner approved
 * one in this conversation, where a delegated colleague's conversation counts
 * as the one that delegated to it — and its siblings with it.
 */
async function approvedInFamily(db: CoreToolContext['db'], conversationId: string): Promise<boolean> {
  const { rows } = await db.query(
    `with root as (
       select coalesce(
         (select e.conversation_id from core.events e
           where e.kind = 'delegation.started' and e.payload->>'conversationId' = $1::text
           order by e.created_at limit 1),
         $1::uuid) as id
     ), family as (
       select id from root
       union
       select (e.payload->>'conversationId')::uuid from core.events e, root
        where e.kind = 'delegation.started' and e.conversation_id = root.id
     )
     select exists (
       select 1 from core.actions a join core.approvals p on p.action_id = a.id
        where a.tool = 'pic.draw' and a.conversation_id in (select id from family)
          and p.state in ('approved', 'executing', 'succeeded', 'failed', 'unknown')
     ) as approved`,
    [conversationId],
  );
  return (rows[0] as { approved: boolean }).approved;
}

const picManifest: PluginManifest = {
  name: 'pic',
  version: '1.0.0',
  schema: 'pic',
  migrationsDir: '',
  tools: [
    {
      name: 'pic.draw',
      description: 'Draw a picture.',
      tier: 'auto',
      async tierFor(_input: unknown, ctx: CoreToolContext) {
        return { tier: ctx.conversationId && (await approvedInFamily(ctx.db, ctx.conversationId)) ? 'auto' : 'gated' };
      },
      input: z.object({ prompt: z.string() }),
      describe: (input: { prompt: string }) => ({ envelope: { prompt: input.prompt }, preview: `Draw "${input.prompt}"` }),
      async execute(input: { prompt: string }) {
        drawn.push(input.prompt);
        return { picture: `pic-${drawn.length}` };
      },
    } as never,
  ],
};

/* ---------------- scripted providers, one per agent ---------------- */

type Turn = (req: CompletionRequest) => CompletionResponse;
const say = (text: string): Turn => () => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'fake' });
const call = (id: string, name: string, input: unknown): Turn => () => ({
  content: [{ type: 'tool_use', id, name, input } as never], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'fake',
});

class ScriptedProvider implements RuntimeProvider {
  script: Turn[] = [];
  readonly seen: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(JSON.parse(JSON.stringify(req)) as CompletionRequest);
    return (this.script.shift() ?? say('done'))(req);
  }
  /** Every text the model was sent, flattened: what it read. */
  read(): string {
    return JSON.stringify(this.seen.at(-1)?.messages ?? []);
  }
}

const providers: Record<string, ScriptedProvider> = { playground: new ScriptedProvider(), illustrator: new ScriptedProvider() };

/* ---------------- two agents ---------------- */

function agentOf(id: string, handle: string, name: string, tools: string[]): any {
  const definition = () => ({
    id, name, systemPrompt: `you are ${name}`, tools,
    provider: { kind: 'anthropic' as const, model: 'claude-test', credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' } },
    maxTurns: 6,
  });
  return {
    id, handle, name, description: 'A test agent.', isDefault: id === 'playground', roles: [], source: 'private', providerKind: 'anthropic',
    available: true, availability: { ok: true }, file: `/agents/${id}/agent.md`, model: 'claude-test', tools, maxTurns: 6, language: 'mirror',
    provider: definition().provider, skills: [], systemPromptTemplate: '', definition,
  };
}

const AGENTS = [
  agentOf('playground', 'playground', 'Playground', ['agent.delegate']),
  agentOf('illustrator', 'art', 'Illustrator', ['pic.draw']),
];

const catalog = (): AgentCatalog => ({
  get: (id: string) => AGENTS.find((a) => a.id === id),
  byHandle: (handle: string) => AGENTS.find((a) => a.handle === handle),
  list: () => AGENTS.map((a) => ({ id: a.id, handle: a.handle, name: a.name, description: a.description, isDefault: a.isDefault, roles: [], source: a.source, providerKind: a.providerKind, available: true })),
  agentsWithRole: () => [],
  agentForRole: (role: string) => ({ ok: false, problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) } }),
  defaultAgent: () => AGENTS[0],
  resolve: () => AGENTS[0],
}) as never;

/* ---------------- a signed-in client ---------------- */

class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async get(p: string, init: RequestInit = {}): Promise<Response> {
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.base}${p}`, { redirect: 'manual', ...init, headers: { ...(jar ? { cookie: jar } : {}), ...(init.headers ?? {}) } });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) this.cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
    return res;
  }
  async json<T>(p: string): Promise<T> {
    const res = await this.get(p);
    expect(res.status, `GET ${p}`).toBe(200);
    return (await res.json()) as T;
  }
  post(p: string, body: unknown = {}): Promise<Response> {
    return this.get(p, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-buddi-csrf': this.cookies.get(csrfCookieName(portOf(new URL(this.base)))) ?? '', origin: this.base },
    });
  }
}

suite('an approval inside a delegation', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let client: Client;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    await completeOnboarding(pool, 'test');

    const agentsDir = mkdtempSync(path.join(tmpdir(), 'buddi-delegation-'));
    mkdirSync(path.join(agentsDir, 'playground'));
    writeFileSync(path.join(agentsDir, 'playground', 'delegates.json'), JSON.stringify(['illustrator']));

    const registry = new ToolRegistry();
    registry.register(picManifest);
    registry.register(createDelegationManifest(registry, { agentsDir }));
    const cat = catalog();
    bindDelegation(registry, { catalog: cat as never, provider: providers.playground!, providerFor: (agent) => providers[agent.id]! });
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool, registry, catalog: cat, ctx, timezone: 'UTC', now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: TOKEN, jobs: undefined, log: () => {},
      chat: { providerFor: (agent) => providers[agent.id]! },
    });
    client = new Client(`http://127.0.0.1:${web.port}`);
    expect((await client.get(`/?t=${encodeURIComponent(mintTicket(TOKEN))}`)).status).toBe(302);
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
    drawn.length = 0;
    for (const p of Object.values(providers)) { p.script = []; p.seen.length = 0; }
    await pool.query('truncate core.effect_attempts, core.approvals, core.actions cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
  });

  /** Wait until a conversation has closed `runs` runs. */
  const settled = async (conversationId: string, runs = 1): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const { rows } = await pool.query(
        `select count(*)::int as n from core.events where conversation_id = $1::uuid and kind in ('run.finished', 'chat.run.failed')`,
        [conversationId],
      );
      if (Number(rows[0].n) >= runs) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`conversation ${conversationId} never settled`);
  };

  /** @playground asks @art for a picture; @art's call stops on the approval. */
  const delegateAndPause = async (): Promise<{ root: string; colleague: string; actionId: string }> => {
    providers.playground!.script = [call('d1', 'agent.delegate', { agent: 'illustrator', task: 'draw a fisherman' })];
    providers.illustrator!.script = [call('p1', 'pic.draw', { prompt: 'a fisherman' })];
    const { conversationId: root } = (await (await client.post('/api/chat/playground/messages', { text: 'a picture, please' })).json()) as any;
    await settled(root);
    const { rows } = await pool.query(`select id, conversation_id from core.actions where tool = 'pic.draw'`);
    expect(rows).toHaveLength(1);
    return { root, colleague: String(rows[0].conversation_id), actionId: String(rows[0].id) };
  };

  const blocksOf = async (conversationId: string): Promise<any[]> =>
    (await client.json<any>(`/api/chat/conversations/${conversationId}`)).messages.flatMap((m: any) => m.blocks);

  it('shows the colleague\'s approval in the root dock, pauses the asker on it, and badges both agents', async () => {
    const { root, colleague, actionId } = await delegateAndPause();

    // The asker's run stopped on the colleague's action — it did not get "".
    const { rows: finished } = await pool.query(
      `select payload from core.events where conversation_id = $1 and kind = 'run.finished'`, [root]);
    expect(finished[0].payload).toMatchObject({ stopped: 'awaiting-approval', actionId });
    expect(providers.playground!.seen).toHaveLength(1);

    const transcript = await client.json<any>(`/api/chat/conversations/${root}`);
    expect(transcript.delegatedApprovals).toEqual([
      { approvalId: actionId, toolUseId: 'd1', tool: 'pic.draw', chain: ['illustrator', 'playground'] },
    ]);
    const result = transcript.messages.flatMap((m: any) => m.blocks).find((b: any) => b.type === 'tool_result' && b.toolUseId === 'd1');
    expect(result).toMatchObject({ name: 'agent.delegate', delegation: { state: 'waiting', approvalId: actionId } });
    expect(result.output).toMatchObject({ status: 'awaiting-approval', waitingOn: { action: actionId, tool: 'pic.draw' } });

    // Still in @art's own thread, as its own gate.
    const own = (await blocksOf(colleague)).find((b: any) => b.type === 'tool_result' && b.toolUseId === 'p1');
    expect(own).toMatchObject({ approval: { id: actionId, state: 'pending' } });

    const attention = await client.json<any>('/api/chat/attention');
    const byAgent = Object.fromEntries(attention.agents.map((a: any) => [a.agentId, a.approvals]));
    expect(byAgent).toEqual({ illustrator: 1, playground: 1 });
  });

  it('decided from the root, the colleague carries on and its real answer resumes the asker; a second picture is not asked again', async () => {
    const { root, colleague, actionId } = await delegateAndPause();

    providers.illustrator!.script = [say('Drew it: pic-1.')];
    providers.playground!.script = [say('Here is your fisherman.')];
    const decided = await client.post(`/api/approvals/${actionId}/approve`);
    expect(decided.status).toBe(200);
    await settled(colleague, 2);
    await settled(root, 2);
    expect(drawn).toEqual(['a fisherman']);

    // The asker was handed the colleague's answer as its deferred result.
    const read = providers.playground!.read();
    expect(read).toContain(`tool result (deferred) for action ${actionId}: succeeded`);
    expect(read).toContain('Drew it: pic-1.');

    const transcript = await client.json<any>(`/api/chat/conversations/${root}`);
    expect(transcript.delegatedApprovals).toBeUndefined();
    const blocks = transcript.messages.flatMap((m: any) => m.blocks);
    expect(blocks.find((b: any) => b.type === 'tool_result' && b.toolUseId === 'd1')).toMatchObject({
      ok: true, output: { status: 'answered', text: 'Drew it: pic-1.' },
    });
    expect(blocks.find((b: any) => b.type === 'tool_result' && b.toolUseId === 'd1').delegation).toBeUndefined();
    expect(blocks.some((b: any) => b.type === 'text' && b.text === 'Here is your fisherman.')).toBe(true);
    expect((await client.json<any>('/api/chat/attention')).agents).toEqual([]);

    // The same conversation asks again: a new colleague conversation, the
    // same family, and no second card.
    providers.playground!.script = [call('d2', 'agent.delegate', { agent: 'illustrator', task: 'another one' }), say('And another.')];
    providers.illustrator!.script = [call('p2', 'pic.draw', { prompt: 'a boat' }), say('Drew it: pic-2.')];
    expect((await client.post('/api/chat/playground/messages', { text: 'one more', conversationId: root })).status).toBe(202);
    await settled(root, 3);
    const { rows: actions } = await pool.query(`select count(*)::int as n from core.actions`);
    expect(actions[0].n).toBe(1);
    expect(drawn).toEqual(['a fisherman', 'a boat']);
    const again = (await blocksOf(root)).find((b: any) => b.type === 'tool_result' && b.toolUseId === 'd2');
    expect(again).toMatchObject({ ok: true, output: { status: 'answered', text: 'Drew it: pic-2.' } });
  });

  it('returns a rejection to the asker as a failure with the reason', async () => {
    const { root, colleague, actionId } = await delegateAndPause();
    providers.illustrator!.script = [say('The owner said no, so no picture.')];
    providers.playground!.script = [say('@art was not allowed to draw it.')];
    expect((await client.post(`/api/approvals/${actionId}/reject`)).status).toBe(200);
    await settled(colleague, 2);
    await settled(root, 2);
    expect(drawn).toEqual([]);

    const read = providers.playground!.read();
    expect(read).toContain(`tool result (deferred) for action ${actionId}: failed`);
    expect(read).toContain("The delegation failed: the owner rejected @art's pic.draw.");
    expect(read).toContain('The owner said no, so no picture.');
    const result = (await blocksOf(root)).find((b: any) => b.type === 'tool_result' && b.toolUseId === 'd1');
    expect(result).toMatchObject({ ok: false, output: { status: 'failed' } });
    expect(String(result.error)).toContain('rejected');
  });

  it('returns an expiry to the asker as a failure: the approval\'s own lifetime bounds the wait', async () => {
    const { root, colleague, actionId } = await delegateAndPause();
    await pool.query(`update core.actions set expires_at = now() - interval '1 minute' where id = $1`, [actionId]);
    providers.illustrator!.script = [say('Nobody decided, so no picture.')];
    providers.playground!.script = [say('The request lapsed.')];
    expect(await web.chat!.sweepExpiredDelegations()).toBe(1);
    await settled(colleague, 2);
    await settled(root, 2);
    const read = providers.playground!.read();
    expect(read).toContain(`tool result (deferred) for action ${actionId}: failed`);
    expect(read).toContain("did not decide @art's pic.draw before it expired");
    // Swept once is swept: nothing resumes a second time.
    expect(await web.chat!.sweepExpiredDelegations()).toBe(0);
  });
});
