/**
 * A room whose coordinator is not buddi: the coordinator asks the room's own
 * members (membership is the grant, for this room only), and an @mention of
 * a member always reaches it — by handle, id or one-word name.
 *
 * The bug this pins (RmpxjQ2ePS): "researcher may not ask anchor: allowed
 * none", and "@anchor" unanswered because Anchor's handle was not "anchor".
 *
 * Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  completeOnboarding,
  createGroup,
  createPool,
  ensureOwner,
  migrate,
  readGroupTurns,
  roleProblemMessage,
  ToolRegistry,
  type AgentCatalog,
  type CoreToolContext,
} from '@buddi/core';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedTestDatabaseUrl } from '@buddi/core/testing';
import { startWebServer, type WebServer } from './server.js';

// Isolated: an explicit DATABASE_URL only, never the dev database (55433), the memory vault.
const databaseUrl = isolatedTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_group_runs_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

type Turn = (req: CompletionRequest) => CompletionResponse;
const say = (text: string): Turn => () => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 10, output: 5 }, model: 'fake-model' });
const call = (id: string, name: string, input: unknown): Turn => () => ({ content: [{ type: 'tool_use', id, name, input } as never], stopReason: 'tool_use', usage: { input: 10, output: 5 }, model: 'fake-model' });

/** One scripted provider per agent, so a test says exactly who does what. */
class Scripted implements RuntimeProvider {
  script: Turn[] = [];
  readonly seen: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(JSON.parse(JSON.stringify(req)) as CompletionRequest);
    return (this.script.shift() ?? say('done'))(req);
  }
}

/** The researcher coordinates; Anchor (handle `news-anchor`) and Scout are its room. No delegation file anywhere. */
const ROSTER = [
  { id: 'researcher', handle: 'researcher', name: 'Researcher' },
  { id: 'anchor', handle: 'news-anchor', name: 'Anchor' },
  { id: 'scout', handle: 'scout', name: 'Scout' },
];
const providers = new Map(ROSTER.map((a) => [a.id, new Scripted()]));

const fakeCatalog = (): AgentCatalog => {
  const full = (a: (typeof ROSTER)[number]): never => ({
    ...a, description: 'A test agent.', isDefault: false, roles: [], source: 'private', providerKind: 'anthropic', available: true, availability: { ok: true },
    file: `/agents/${a.id}/agent.md`, model: 'claude-test', tools: [], maxTurns: 6, language: 'mirror', skills: [], systemPromptTemplate: `you are ${a.name}`,
    provider: { kind: 'anthropic', model: 'claude-test', credential: { kind: 'api-key', env: 'TEST_ANTHROPIC_KEY' } },
    definition: () => ({ id: a.id, name: a.name, systemPrompt: `you are ${a.name}`, tools: [], provider: { kind: 'anthropic', model: 'claude-test', credential: { kind: 'api-key', env: 'TEST_ANTHROPIC_KEY' } }, maxTurns: 6 }),
  }) as never;
  return {
    get: (id: string) => { const a = ROSTER.find((r) => r.id === id); return a ? full(a) : undefined; },
    byHandle: (handle: string) => { const a = ROSTER.find((r) => r.handle === handle.replace(/^@/, '').toLowerCase()); return a ? full(a) : undefined; },
    list: () => ROSTER.map((a) => ({ id: a.id, handle: a.handle, name: a.name, description: 'A test agent.', isDefault: false, roles: [], source: 'private' as const, providerKind: 'anthropic' as const, available: true })),
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({ ok: false as const, problem: { code: 'no-agent-for-role' as const, role, message: roleProblemMessage(role) } }),
    defaultAgent: () => full(ROSTER[0]!),
    resolve: () => full(ROSTER[0]!),
  };
};

/** Every text an agent put in the room, by speaker. */
async function said(pool: Pool, conversationId: string): Promise<Array<{ speaker: string | null; text: string }>> {
  return (await readGroupTurns(pool, conversationId))
    .filter((t) => t.role === 'assistant')
    .map((t) => ({ speaker: t.speaker, text: t.content.map((b) => (b.type === 'text' ? b.text : '')).join('') }))
    .filter((t) => t.text !== '');
}

suite('a room coordinated by an agent other than buddi', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;

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
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool, registry: new ToolRegistry(), catalog: fakeCatalog(), ctx, timezone: 'UTC', now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: TOKEN, log: () => {},
      chat: { providerFor: (agent) => providers.get(agent.id)! },
    });
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

  beforeEach(() => {
    for (const p of providers.values()) { p.script = []; p.seen.length = 0; }
  });

  it('lets the coordinator ask its own members, with no delegation allowlist written anywhere', async () => {
    const group = await createGroup(pool, { name: 'Newsroom', coordinator: 'researcher', members: ['anchor', 'scout'] });
    providers.get('researcher')!.script = [call('t1', 'group.ask', { agent: 'news-anchor', request: 'What leads tonight?' }), say('Anchor has the lead.')];
    providers.get('anchor')!.script = [say('The harbour story leads.')];
    const sent = await web.chat!.sendToGroup({ groupId: group.id, text: 'What leads tonight?' });
    expect(sent.ok).toBe(true);
    await web.chat!.drain();
    const conversationId = (sent as { conversationId: string }).conversationId;
    // The ask went through: the member ran, and the coordinator saw what it said, not a refusal.
    expect(providers.get('anchor')!.seen).toHaveLength(1);
    const toolResult = JSON.stringify(providers.get('researcher')!.seen[1]?.messages.at(-1));
    expect(toolResult).toContain('@news-anchor said');
    expect(toolResult).not.toMatch(/may not ask|refused/);
    expect(await said(pool, conversationId)).toContainEqual({ speaker: 'anchor', text: 'The harbour story leads.' });
  });

  it('reaches a member the owner @mentions by its id or name, even when its handle differs', async () => {
    const group = await createGroup(pool, { name: 'Desk', coordinator: 'researcher', members: ['anchor', 'scout'] });
    providers.get('anchor')!.script = [say('Here, on it.')];
    providers.get('scout')!.script = [say('Scout too.')];
    providers.get('researcher')!.script = [say('Both answered.')];
    const sent = await web.chat!.sendToGroup({ groupId: group.id, text: '@anchor and @Scout, are you there?' });
    expect(sent.ok).toBe(true);
    await web.chat!.drain();
    const room = await said(pool, (sent as { conversationId: string }).conversationId);
    expect(room).toContainEqual({ speaker: 'anchor', text: 'Here, on it.' });
    expect(room).toContainEqual({ speaker: 'scout', text: 'Scout too.' });
    // In the order named, then the coordinator concludes.
    expect(room.map((t) => t.speaker)).toEqual(['anchor', 'scout', 'researcher']);
  });
});
