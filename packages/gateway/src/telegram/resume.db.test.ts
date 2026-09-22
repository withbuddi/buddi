/**
 * The Telegram half of "a decided approval is the owner asking".
 *
 * Tapping Approve in a chat is the owner acting, in that chat, on that
 * conversation — so the run the tap wakes carries an owner request of its own
 * and a `session`-tier tool keeps working across the approval. Before this,
 * the resumed run was handed the bare context and the next narrowed call came
 * straight back as `session-not-authorized`.
 *
 * `host.exec` is the tool here because it is the one whose completion resumes
 * an *interactive* Telegram turn (`TelegramApprovals`); the surface is started
 * for real, so what is exercised is the wiring and not a restatement of it.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completeOnboarding,
  createPool,
  ensureOwner,
  roleProblemMessage,
  runMigrations,
  ToolRegistry,
  type ToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { approvalCallbackData } from './approvals.js';
import { startTelegram, type TelegramHandle } from './main.js';
import type { TelegramApi } from './api.js';
import type { AgentCatalog, CatalogAgent } from './types.js';
import { manifest as memoryManifest } from '@buddi/tool-memory';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_tg_resume_${process.pid}`;

const AGENT_ID = 'ledger-agent';
const OWNER_CHAT = '4242';

/** Every call the `session`-tier tool actually reached, with the context it saw. */
const sessionCalls: Array<{ what: string; ctx: ToolContext }> = [];

const PROVIDER = {
  kind: 'anthropic' as const,
  credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
  model: 'claude-test',
};

const TOOLS = ['host.exec', 'demo.session'];

function agent(): CatalogAgent {
  return {
    id: AGENT_ID,
    handle: 'ledger',
    name: 'Ledger',
    description: 'A test agent.',
    isDefault: true,
    roles: [],
    source: 'example',
    providerKind: 'anthropic',
    available: true,
    availability: { ok: true },
    skills: [],
    file: `${AGENT_ID}/agent.md`,
    model: 'claude-test',
    tools: TOOLS,
    maxTurns: 4,
    language: 'mirror',
    provider: PROVIDER,
    systemPromptTemplate: 'Ledger.',
    definition: () => ({
      id: AGENT_ID,
      name: 'Ledger',
      systemPrompt: 'Ledger.',
      tools: TOOLS,
      provider: PROVIDER,
      maxTurns: 4,
    }),
  } as CatalogAgent;
}

function fakeCatalog(): AgentCatalog {
  const one = agent();
  const summary = {
    id: one.id,
    handle: one.handle,
    name: one.name,
    description: one.description,
    isDefault: one.isDefault,
    roles: one.roles,
    source: one.source,
    providerKind: one.providerKind,
    available: one.available,
  };
  return {
    get: (id: string) => (id === one.id ? one : undefined),
    byHandle: (handle: string) => (handle.replace(/^@/, '').toLowerCase() === one.handle ? one : undefined),
    list: () => [summary],
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({
      ok: false as const,
      problem: { code: 'no-agent-for-role' as const, role, message: roleProblemMessage(role) },
    }),
    defaultAgent: () => one,
    resolve: () => one,
  } as unknown as AgentCatalog;
}

/** A scripted model: one entry per turn, so a test says exactly what it does. */
class ScriptedProvider implements RuntimeProvider {
  script: Array<() => CompletionResponse> = [];
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    const next = this.script.shift();
    if (next) return next();
    return {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'fake-model',
    };
  }
}

const call = (id: string, tool: string, input: unknown) => (): CompletionResponse => ({
  content: [{ type: 'tool_use', id, name: tool, input } as never],
  stopReason: 'tool_use',
  usage: { input: 1, output: 1 },
  model: 'fake-model',
});

/**
 * A Bot API that answers everything and reaches nothing. Polling resolves on
 * abort, so `stop()` returns instead of spinning.
 */
function fakeApi(sent: string[]): TelegramApi {
  const base: Record<string, unknown> = {
    getMe: async () => ({ id: 1, username: 'buddibot' }),
    getUpdates: (_offset: number | undefined, signal?: AbortSignal) =>
      new Promise<[]>((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true })),
    sendMessage: async (_chatId: string, text: string) => {
      sent.push(text);
      return 1;
    },
  };
  return new Proxy(base, {
    get: (target, prop) => target[prop as string] ?? (async () => undefined),
  }) as unknown as TelegramApi;
}

suite('a Telegram approval wakes the run as an owner request', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let provider: ScriptedProvider;
  let handle: TelegramHandle;
  let sent: string[];
  let conversationId: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memoryManifest]);
    await ensureOwner(pool, 'owner');
    await completeOnboarding(pool, 'fixture');
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-tg-resume-'));
  }, 60_000);

  afterAll(async () => {
    await handle?.stop();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query('truncate core.effect_attempts, core.approvals, core.actions cascade');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
    sessionCalls.length = 0;
    sent = [];
    provider = new ScriptedProvider();

    registry = new ToolRegistry();
    registry.register({
      name: 'fixture',
      version: '1.0.0',
      schema: 'fixture',
      migrationsDir: '',
      tools: [
        {
          // Named for the real one: its *completion* is what resumes an
          // interactive Telegram turn, and that is the path under test.
          name: 'host.exec',
          description: 'Run something on the host.',
          tier: 'gated',
          input: z.object({ command: z.string() }),
          describe: (input: { command: string }) => ({
            envelope: { command: input.command },
            preview: `Run ${input.command}`,
          }),
          async execute(input: { command: string }) {
            return { state: 'completed', stdout: input.command, exitCode: 0 };
          },
        },
        {
          // The shape the developer plugin's tools have.
          name: 'demo.session',
          description: 'Only reachable while the owner is asking.',
          tier: 'session',
          input: z.object({ what: z.string() }),
          async execute(input: { what: string }, toolCtx: ToolContext) {
            sessionCalls.push({ what: input.what, ctx: toolCtx });
            return { did: input.what };
          },
        },
      ],
    });

    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ($1) returning id`,
      [AGENT_ID],
    );
    conversationId = rows[0].id as string;
    ctx = {
      db: pool,
      ownerId: 'owner',
      agentId: AGENT_ID,
      conversationId,
      now: () => new Date(),
      timezone: 'UTC',
    };

    await handle?.stop();
    handle = await startTelegram({
      pool,
      registry,
      catalog: fakeCatalog(),
      provider,
      ctx,
      env: {
        TELEGRAM_OWNER_USER_ID: OWNER_CHAT,
        TELEGRAM_OWNER_CHAT_ID: OWNER_CHAT,
        BUDDI_DATA_DIR: dir,
        BUDDI_VAULT: 'memory',
      },
      now: () => new Date(),
      api: fakeApi(sent),
      jobs: null,
      log: () => {},
    } as never);
  });

  /** Propose the gated call the owner will decide, exactly as a run would. */
  const propose = async (): Promise<string> => {
    const result = await registry.invoke('host.exec', { command: 'printf worked' }, ctx);
    if (result.ok || result.reason !== 'approval-required') throw new Error('expected an approval');
    return result.actionId;
  };

  const tapApprove = async (actionId: string): Promise<void> => {
    await handle.approvals.handleCallback({
      id: 'c1',
      data: approvalCallbackData(actionId, 'approve'),
      from: { id: Number(OWNER_CHAT), first_name: 'Owner' },
      message: { message_id: 1, date: 0, chat: { id: Number(OWNER_CHAT), type: 'private' } },
    } as never);
  };

  it('lets a session tool run in the turn the tap resumes', async () => {
    const actionId = await propose();
    provider.script = [call('t2', 'demo.session', { what: 'narrow' })];

    await tapApprove(actionId);

    expect(sessionCalls).toHaveLength(1);
    const seen = sessionCalls[0] as { what: string; ctx: ToolContext };
    expect(seen.what).toBe('narrow');
    // Nothing holds the words of the turn the action came from, so the request
    // is named after the decision itself.
    expect(seen.ctx.ownerRequest?.text).toBe('approved host.exec');
    expect(seen.ctx.ownerRequest?.expiresAt).toBeGreaterThan(Date.now());
    expect(seen.ctx.sessionTools).toContain('demo.session');
  });

  it('does not extend that standing to a delegate', async () => {
    const actionId = await propose();
    provider.script = [call('t2', 'demo.session', { what: 'narrow' })];
    await tapApprove(actionId);
    const seen = (sessionCalls[0] as { ctx: ToolContext }).ctx;

    sessionCalls.length = 0;
    // Same context, one step down: the owner's standing is the owner's.
    const delegated = await registry.invoke(
      'demo.session',
      { what: 'narrow' },
      { ...seen, delegationDepth: 1 },
    );
    expect(delegated).toMatchObject({ ok: false, reason: 'session-not-authorized' });
    expect(sessionCalls).toHaveLength(0);
  });
});
