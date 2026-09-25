/**
 * `buddi mcp`, end to end: an MCP client talking to the server over an
 * in-memory transport, the server talking to a real dashboard on loopback,
 * the dashboard on a throwaway database (docs/mcp.md §5).
 *
 * What is asserted, one family at a time:
 *   - the tools are listed, and the reads answer with what the routes serve;
 *   - a write raises one approval card, attributed to the client, and returns
 *     the new state when the owner approves it;
 *   - a rejected write changes nothing and says so;
 *   - a write nobody decides returns `{ pending }` after ten (fake) minutes,
 *     with progress on the way, and the card stays open;
 *   - granting a hand-only tool is refused with the tool picker's sentence and
 *     raises no card;
 *   - no read's output contains a seeded secret;
 *   - `buddi.ask` runs a turn on a stubbed model, is attributed to the client,
 *     and waits through an approval the turn hits.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPool, ensureOwner, type PluginManifest, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { demoPagesManifest } from '@buddi/core/testing/pages';
import {
  bindPlatformTools,
  createToolRegistry,
  createWebApp,
  loadGatewayCatalog,
  migrateInstalled,
  reloadableCatalog,
} from '@buddi/gateway';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayClient } from './gateway-client.js';
import { knownSecrets, REDACTED } from './secrets.js';
import { createMcpServer } from './server.js';
import { TOOLS } from './tools.js';

type ProviderAccounts = NonNullable<Parameters<typeof createWebApp>[0]['providerAccounts']>;

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_mcp_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const CLIENT = 'claude-code';

/* ------------------------------------------------------------------ *
 * Seeded secrets: each one planted where some read could reach it.
 * ------------------------------------------------------------------ */

const SEED = {
  anthropic: 'sk-ant-api03-SEEDseedSEEDseed0123456789abcdefABCDEF',
  telegram: '7412589630:AAHseedSEEDseedSEEDseedSEEDseed12345',
  dbPassword: 'hunter2-seed-db-pass',
  vault: 'vault-seed-value-q8Zr41xLp0',
  oauth: 'ya29.a0SeedOauthAccessTokenValue123456',
};
const SECRET_ENV: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: SEED.anthropic,
  TELEGRAM_BOT_TOKEN: SEED.telegram,
  DATABASE_URL: `postgres://buddi:${SEED.dbPassword}@127.0.0.1:5432/buddi`,
  // A vault entry hydrated into the environment, as `hydrateSecrets` does.
  GMAIL_APP_PASSWORD: SEED.vault,
};

/* ------------------------------------------------------------------ *
 * A stubbed model and a gated tool for the advisor to hit
 * ------------------------------------------------------------------ */

type Reply = { content: unknown[]; stopReason: string; usage: { input: number; output: number }; model: string };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 10, output: 5 }, model: 'fake' });
const call = (id: string, name: string, input: unknown): Reply => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: { input: 10, output: 5 },
  model: 'fake',
});
const script: Reply[] = [];
const provider = {
  capabilities: {},
  async complete(): Promise<Reply> {
    return script.shift() ?? say('done');
  },
};

const sent: string[] = [];
/** A figure only the sensitive block carries, to prove it never left. */
const BALANCE = '12,345.67';
const demoManifest: PluginManifest = {
  // The pages fixture's screens and queries, so pages_list has a real tree to summarize.
  ...demoPagesManifest,
  name: 'demo',
  version: '1.0.0',
  schema: 'demo',
  migrationsDir: '',
  // `settings` stands in for a balance: marked sensitive, as finance marks its reads.
  queries: (demoPagesManifest.queries ?? []).map((q) => (q.name === 'settings' ? { ...q, sensitive: true } : q)),
  home: [
    { id: 'demo.money', title: 'Money', produce: async () => ({ id: 'demo.money', title: 'Money', stats: [{ label: 'Cash', value: BALANCE }], rows: [], sensitive: true }) },
    { id: 'demo.car', title: 'Car', produce: async () => ({ id: 'demo.car', title: 'Car', stats: [{ label: 'Mileage', value: '42,000' }], rows: [] }) },
  ],
  tools: [
    ...(demoPagesManifest.tools ?? []),
    {
      name: 'demo.pay',
      description: 'Pay a bill.',
      tier: 'gated',
      input: z.object({ to: z.string() }),
      describe: (input: { to: string }) => ({ envelope: { to: input.to }, preview: `Pay ${input.to}` }),
      async execute(input: { to: string }) {
        sent.push(input.to);
        return { paid: input.to };
      },
    },
  ],
};

const agentFile = (id: string, handle: string, name: string, tools: string, extra = ''): string =>
  [
    '---',
    `id: ${id}`,
    `handle: ${handle}`,
    `name: ${name}`,
    `description: ${name}, for the MCP suite`,
    'provider: anthropic',
    'model: claude-sonnet-5',
    `tools: ${tools}`,
    'maxTurns: 6',
    extra,
    '---',
    '',
    `You are ${name}. Keep ${SEED.vault} to yourself.`,
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');

/* ------------------------------------------------------------------ *
 * The fake clock: every sleep advances it and yields for real
 * ------------------------------------------------------------------ */

let fakeNow = Date.parse('2026-09-23T09:00:00Z');
const sleep = async (ms: number): Promise<void> => {
  fakeNow += ms;
  await new Promise((resolve) => setTimeout(resolve, 5));
};

suite('buddi mcp', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let server: ReturnType<typeof createWebApp>;
  let base: string;
  let owner: GatewayClient;
  let client: Client;

  const tool = async (name: string, args: Record<string, unknown> = {}, onprogress?: (p: { message?: string }) => void) => {
    const result = (await client.callTool({ name, arguments: args }, undefined, onprogress ? { onprogress } : undefined)) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content.map((c) => c.text).join('\n');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // a sentence, not JSON
    }
    return { text, json, isError: result.isError === true };
  };

  /** The one pending card for a tool, once it exists. */
  const pendingCard = async (toolName: string): Promise<{ id: string; preview: string; envelope: any }> => {
    for (let i = 0; i < 200; i += 1) {
      const { pending } = await owner.get<{ pending: Array<{ id: string; tool: string; preview: string; envelope: unknown }> }>('/api/approvals');
      const found = pending.filter((a) => a.tool === toolName);
      if (found.length > 0) {
        expect(found).toHaveLength(1);
        return found[0] as { id: string; preview: string; envelope: any };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no pending ${toolName}`);
  };

  const decide = (id: string, decision: 'approve' | 'reject') => owner.post(`/api/approvals/${id}/${decision}`, {});

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrateInstalled(pool, {});
    await ensureOwner(pool, 'owner');

    dir = mkdtempSync(path.join(tmpdir(), 'buddi-mcp-'));
    const agents = path.join(dir, 'agents');
    for (const [id, source] of Object.entries({
      developer: agentFile('developer', 'dev', 'Developer', '[]', 'default: true'),
      advisor: agentFile('advisor', 'advisor', 'Advisor', '[demo.pay]'),
    })) {
      mkdirSync(path.join(agents, id), { recursive: true });
      writeFileSync(path.join(agents, id, 'agent.md'), source);
    }
    const env = { ANTHROPIC_API_KEY: SEED.anthropic } as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
    registry.register(demoManifest);
    const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: agents, env, registry }));
    bindPlatformTools(registry, {
      catalog,
      reload: () => catalog.reload(),
      agentsDir: agents,
      skillsDir: path.join(dir, 'skills'),
      examplesDir: path.join(dir, 'examples'),
      setDefaultAgent: async () => {},
    });

    // An accounts service that, like a buggy route might, carries a token.
    const accounts = {
      refresh: async () => {},
      view: () => ({
        vault: { kind: 'memory', locked: false, advice: '' },
        accounts: [
          { id: 'acc-1', label: 'Work Claude', kind: 'anthropic', auth: 'anthropic-oauth', baseUrl: '', defaultModel: 'claude-sonnet-5', enabled: true, revision: 1, configured: true, assignedAgents: ['developer'], test: null, token: SEED.oauth, refreshToken: SEED.oauth },
        ],
        bindings: [{ agentId: 'developer', accountId: 'acc-1', model: 'claude-sonnet-5' }],
      }),
      assign: async () => ({ changed: ['account', 'model'] }),
    } as unknown as ProviderAccounts;

    const ctx = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as unknown as CoreToolContext;
    server = createWebApp({
      pool,
      registry,
      catalog,
      ctx,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      openAccess: true,
      token: TOKEN,
      env,
      providerAccounts: accounts,
      chat: { providerFor: () => provider as never },
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    owner = new GatewayClient({ baseUrl: base });

    // Secrets planted in what the reads serve: memory, the event log.
    await owner.post('/api/memory/preferences', { key: 'bank_login', value: `token ${SEED.telegram} and ${SEED.anthropic}`, scope: 'shared' });
    await pool.query(`insert into core.events (kind, payload) values ('seed.secret', $1::jsonb)`, [
      JSON.stringify({ token: SEED.oauth, note: `connect with postgres://buddi:${SEED.dbPassword}@db/buddi`, vault: SEED.vault }),
    ]);

    const mcp = createMcpServer({
      gateway: new GatewayClient({ baseUrl: base }),
      secrets: knownSecrets(SECRET_ENV),
      now: () => fakeNow,
      sleep,
      pollMs: 5_000,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    client = new Client({ name: CLIENT, version: '1.0.0' });
    await client.connect(clientSide);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      server ? server.close(() => resolve()) : resolve();
    });
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  it('lists every tool the spec names', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['buddi.overview', 'buddi.tools_list', 'buddi.agent_update', 'buddi.ask']));
  });

  it('reads: which tools @dev has, and what the picker offers', async () => {
    const { json, isError } = await tool('buddi.tools_list', { agent: '@dev' });
    expect(isError).toBe(false);
    expect(json.agent).toBe('developer');
    expect(json.granted).toEqual([]);
    expect(json.tools.find((t: any) => t.name === 'platform.create_agent')).toMatchObject({ granted: false, grantable: false });
    // No MCP request tool is ever offered to an agent.
    expect(json.tools.some((t: any) => t.name.startsWith('mcp.'))).toBe(false);

    const all = await tool('buddi.tools_list');
    expect(all.json.tools.find((t: any) => t.name === 'demo.pay')).toMatchObject({ plugin: 'demo', tier: 'gated' });

    const read = await tool('buddi.agent_read', { agent: 'advisor' });
    expect(read.json.profile.id).toBe('advisor');
    expect(read.json.file.persona).toContain('You are Advisor.');
    expect(read.json.file.frontmatter.handle).toBe('advisor');

    const agents = await tool('buddi.agents_list');
    expect(agents.json.agents.find((a: any) => a.id === 'developer').account).toMatchObject({ account: 'Work Claude', model: 'claude-sonnet-5' });

    const overview = await tool('buddi.overview');
    expect(overview.isError).toBe(false);
    expect(overview.json.agents.map((a: any) => a.id).sort()).toEqual(['advisor', 'developer']);
  });

  it('a write is one approval card, attributed, and returns the new grant once approved', async () => {
    const picked = (await tool('buddi.tools_list', { agent: 'dev' })).json.tools.find((t: any) => t.grantable && !t.granted && t.plugin !== 'demo');
    const call_ = tool('buddi.agent_update', { agent: '@dev', tools: [picked.name] });
    const card = await pendingCard('mcp.agent_update');
    expect(card.preview).toContain(`Requested through MCP (${CLIENT})`);
    expect(card.envelope.requestedThrough).toBe(`requested through MCP (${CLIENT})`);
    expect(card.envelope.change.toolsAfter).toEqual([picked.name]);
    // Nothing is written before the owner says so.
    expect(readFileSync(path.join(dir, 'agents', 'developer', 'agent.md'), 'utf8')).not.toContain(picked.name);

    expect((await decide(card.id, 'approve')).status).toBe(200);
    const { json, isError } = await call_;
    expect(isError).toBe(false);
    expect(json).toMatchObject({ state: 'succeeded', actionId: card.id, decidedVia: 'web' });
    expect(json.result.tools).toEqual([picked.name]);
    expect(readFileSync(path.join(dir, 'agents', 'developer', 'agent.md'), 'utf8')).toContain(picked.name);

    // Activity: the approval history says who asked.
    const history = await owner.get<{ recent: Array<{ id: string; preview: string; state: string }> }>('/api/approvals');
    expect(history.recent.find((a) => a.id === card.id)).toMatchObject({ state: 'succeeded' });
    expect(history.recent.find((a) => a.id === card.id)?.preview).toContain(`through MCP (${CLIENT})`);
  });

  it('a rejected write changes nothing and says so', async () => {
    const call_ = tool('buddi.default_agent', { agent: 'advisor' });
    const card = await pendingCard('mcp.default_agent');
    expect(card.preview).toContain('Make @advisor (advisor) the default agent');
    await decide(card.id, 'reject');
    const { json, isError } = await call_;
    expect(isError).toBe(false);
    expect(json).toMatchObject({ state: 'rejected', actionId: card.id });
    const agents = await owner.get<{ default: { defaultAgentId: string } }>('/api/agents');
    expect(agents.default.defaultAgentId).toBe('developer');
  });

  it('a write nobody decides returns { pending } after ten minutes, and the card stays open', async () => {
    const progress: string[] = [];
    const started = fakeNow;
    const { json, isError } = await tool('buddi.memory_edit', { op: 'set_preference', key: 'tone', value: 'brief' }, (p) => {
      if (p.message) progress.push(p.message);
    });
    expect(isError).toBe(false);
    expect(fakeNow - started).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(json.pending).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.preview).toContain('Remember the preference tone = "brief"');
    expect(progress[0]).toContain('Waiting for your approval');
    expect(progress.length).toBeGreaterThan(1);
    const { action } = await owner.get<{ action: { state: string; tool: string } }>(`/api/approvals/${json.pending}`);
    expect(action).toMatchObject({ state: 'pending', tool: 'mcp.memory_edit' });
    await decide(json.pending, 'reject');
  });

  it('granting a hand-only tool is refused with the tool picker\'s sentence, and raises no card', async () => {
    const { text, isError } = await tool('buddi.agent_update', { agent: 'dev', tools: ['platform.create_agent'] });
    expect(isError).toBe(true);
    expect(text).toContain('I cannot grant platform.create_agent to "developer"');
    expect(text).toContain('are not grantable through this tool at all');
    const { pending } = await owner.get<{ pending: Array<{ tool: string }> }>('/api/approvals');
    expect(pending.filter((a) => a.tool.startsWith('mcp.'))).toEqual([]);
  });

  it('overview names a sensitive Home block and leaves it out, unless asked', async () => {
    const plain = await tool('buddi.overview');
    expect(plain.isError).toBe(false);
    expect(plain.text).not.toContain(BALANCE);
    const home = plain.json.overview.home as Array<Record<string, unknown>>;
    expect(home.find((b) => b.id === 'demo.money')).toEqual({ id: 'demo.money', title: 'Money', sensitive: true, omitted: 'ask with includeSensitive' });
    expect(home.find((b) => b.id === 'demo.car')).toMatchObject({ title: 'Car', stats: [{ label: 'Mileage', value: '42,000' }] });

    const asked = await tool('buddi.overview', { includeSensitive: true });
    expect(asked.text).toContain(BALANCE);
    expect(asked.json.overview.home.find((b: any) => b.id === 'demo.money')).toMatchObject({ sensitive: true, stats: [{ label: 'Cash', value: BALANCE }] });
  });

  it('pages_list names each page and what it reads, not its layout', async () => {
    const { json, text } = await tool('buddi.pages_list');
    expect(Object.keys(json)).toEqual(['pages']);
    for (const page of json.pages) expect(Object.keys(page)).toEqual(['plugin', 'id', 'title', 'place', 'queries']);
    const board = json.pages.find((p: any) => p.id === 'board');
    expect(board).toMatchObject({ plugin: 'demo', place: 'rail' });
    expect(board.queries).toEqual(expect.arrayContaining([{ name: 'counts', params: {} }, { name: 'items', params: { state: 'string?' } }]));
    expect(text).not.toContain('list-detail');
    // The whole descriptor tree is several times this.
    const full = JSON.stringify(await owner.get('/api/pages'));
    expect(text.length).toBeLessThan(full.length / 3);
  });

  it('page_query names a sensitive query and leaves its data out, unless asked', async () => {
    const plain = await tool('buddi.page_query', { plugin: 'demo', query: 'settings' });
    expect(plain.isError).toBe(false);
    expect(plain.json).toEqual({ plugin: 'demo', query: 'settings', sensitive: true, omitted: 'ask with includeSensitive' });
    const asked = await tool('buddi.page_query', { plugin: 'demo', query: 'settings', includeSensitive: true });
    expect(asked.json).toEqual({ data: { everyMinutes: 15, keepDays: 30 } });
    // A query nobody marked comes back as it always did.
    expect((await tool('buddi.page_query', { plugin: 'demo', query: 'counts' })).json.data).toBeDefined();
    // And pages_list says which are sensitive.
    const listed = (await tool('buddi.pages_list')).json.pages.flatMap((p: any) => p.queries);
    expect(listed.find((q: any) => q.name === 'settings')).toMatchObject({ sensitive: true });
    expect(listed.find((q: any) => q.name === 'counts').sensitive).toBeUndefined();
  });

  it('no read returns a seeded secret', async () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      ['buddi.overview', {}],
      ['buddi.agents_list', {}],
      ['buddi.agent_read', { agent: 'developer' }],
      ['buddi.agent_read', { agent: 'advisor' }],
      ['buddi.tools_list', {}],
      ['buddi.tools_list', { agent: 'advisor' }],
      ['buddi.accounts_list', {}],
      ['buddi.pages_list', {}],
      ['buddi.proposals_list', {}],
      ['buddi.activity', {}],
      ['buddi.activity', { kind: 'seed.secret' }],
      ['buddi.memory_list', {}],
    ];
    expect(new Set(reads.map(([name]) => name)).size).toBe(TOOLS.filter((t) => !t.write && t.name !== 'buddi.page_query').length);
    let redacted = 0;
    for (const [name, args] of reads) {
      const { text, isError } = await tool(name, args);
      expect(isError, `${name}: ${text}`).toBe(false);
      for (const [what, secret] of Object.entries(SEED)) {
        expect(text.includes(secret), `${name} leaked the ${what} seed`).toBe(false);
      }
      if (text.includes(REDACTED)) redacted += 1;
    }
    // The seeds were there to be found: memory, the log, the accounts, the persona.
    expect(redacted).toBeGreaterThanOrEqual(4);
  });

  it('ask runs a turn on the agent, attributed to the client', async () => {
    script.push(say('Rent is due on the 1st, before payday.'));
    const { json, isError } = await tool('buddi.ask', { agent: '@advisor', message: 'What is due before payday?' });
    expect(isError).toBe(false);
    expect(json.answer).toBe('Rent is due on the 1st, before payday.');
    expect(json.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    const events = await owner.get<{ events: Array<{ kind: string; conversationId: string | null; payload: any }> }>('/api/events?kind=mcp.ask');
    expect(events.events.find((e) => e.conversationId === json.conversationId)?.payload).toMatchObject({ client: CLIENT, agentId: 'advisor' });
    const conversations = await owner.get<{ conversations: Array<{ id: string }> }>('/api/chat/advisor/conversations');
    expect(conversations.conversations.map((c) => c.id)).toContain(json.conversationId);
  });

  it('ask waits through an approval the turn hits, like any write', async () => {
    script.push(call('t1', 'demo.pay', { to: 'landlord' }), say('Paid the landlord.'));
    const progress: string[] = [];
    const call_ = tool('buddi.ask', { agent: 'advisor', message: 'Pay the landlord.' }, (p) => {
      if (p.message) progress.push(p.message);
    });
    const card = await pendingCard('demo.pay');
    await decide(card.id, 'approve');
    const { json, isError } = await call_;
    expect(isError).toBe(false);
    expect(sent).toEqual(['landlord']);
    expect(json.answer).toContain('Paid the landlord.');
    expect(progress.some((m) => m.includes('waiting for your approval'))).toBe(true);
  });
});
