/**
 * The files a Telegram run sends back are the files it made: a tool result
 * that names a file it only read (a program read, `source: true`) or saved
 * again unchanged is not sent. Before, every "change my document" round
 * re-sent the old version first.
 *
 * The surface is started for real, with a scripted model and a fake Bot
 * API; the store records which files the run asked to send.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  completeOnboarding,
  createPool,
  ensureOwner,
  pairSurfaceIdentity,
  roleProblemMessage,
  runMigrations,
  saveArtifact,
  ToolRegistry,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { startTelegram, type TelegramHandle } from './main.js';
import type { TelegramApi } from './api.js';
import type { AgentCatalog, CatalogAgent } from './types.js';
import { createCoreArtifactStore, type ArtifactStore } from './attachments.js';
import { manifest as memoryManifest } from '@buddi/tool-memory';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_tg_produced_${process.pid}`;

const AGENT_ID = 'writer-agent';
const OWNER_CHAT = '4343';
const TOOLS = ['fixture.compose'];
const PROVIDER = { kind: 'anthropic' as const, credential: { kind: 'api-key' as const, env: 'TEST_ANTHROPIC_KEY' }, model: 'claude-test' };

function catalog(): AgentCatalog {
  const one = {
    id: AGENT_ID, handle: 'writer', name: 'Writer', description: 'A test agent.', isDefault: true, roles: [],
    source: 'example', providerKind: 'anthropic', available: true, availability: { ok: true }, skills: [],
    file: `${AGENT_ID}/agent.md`, model: 'claude-test', tools: TOOLS, maxTurns: 6, language: 'mirror',
    provider: PROVIDER, systemPromptTemplate: 'Writer.',
    definition: () => ({ id: AGENT_ID, name: 'Writer', systemPrompt: 'Writer.', tools: TOOLS, provider: PROVIDER, maxTurns: 6 }),
  } as unknown as CatalogAgent;
  return {
    get: (id: string) => (id === one.id ? one : undefined),
    byHandle: (handle: string) => (handle.replace(/^@/, '').toLowerCase() === one.handle ? one : undefined),
    list: () => [{ id: one.id, handle: one.handle, name: one.name, description: one.description, isDefault: true, roles: [], source: one.source, providerKind: one.providerKind, available: true }],
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({ ok: false as const, problem: { code: 'no-agent-for-role' as const, role, message: roleProblemMessage(role) } }),
    defaultAgent: () => one,
    resolve: () => one,
  } as unknown as AgentCatalog;
}

class ScriptedProvider implements RuntimeProvider {
  script: Array<() => CompletionResponse> = [];
  async complete(): Promise<CompletionResponse> {
    const next = this.script.shift();
    if (next) return next();
    return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'fake-model' };
  }
}

const call = (id: string, input: unknown) => (): CompletionResponse => ({
  content: [{ type: 'tool_use', id, name: 'fixture.compose', input } as never],
  stopReason: 'tool_use',
  usage: { input: 1, output: 1 },
  model: 'fake-model',
});

/** A Bot API that delivers one owner message, then waits; every send is recorded. */
function fakeApi(sent: string[], text: string): TelegramApi {
  let delivered = false;
  const base: Record<string, unknown> = {
    getMe: async () => ({ id: 1, username: 'buddibot' }),
    getUpdates: (_offset: number | undefined, signal?: AbortSignal) => {
      if (!delivered) {
        delivered = true;
        return Promise.resolve([{
          update_id: 1,
          message: { message_id: 10, date: Math.floor(Date.now() / 1000), text, chat: { id: Number(OWNER_CHAT), type: 'private' }, from: { id: Number(OWNER_CHAT), first_name: 'Owner', is_bot: false } },
        }]);
      }
      return new Promise<[]>((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    },
    sendMessage: async (_chatId: string, said: string) => { sent.push(said); return 1; },
  };
  return new Proxy(base, { get: (target, prop) => target[prop as string] ?? (async () => undefined) }) as unknown as TelegramApi;
}

suite('a Telegram run sends back only the files it made', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let handle: TelegramHandle | undefined;

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
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-tg-produced-'));
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

  it('does not send a file the run only read the program of, or saved again unchanged', async () => {
    const env = { BUDDI_DATA_DIR: dir, BUDDI_VAULT: 'memory' };
    const old = await saveArtifact(pool, { bytes: Buffer.from('old letter'), mime: 'text/plain', filename: 'Letter.txt', createdBy: AGENT_ID, conversationId: null }, env);
    const fresh = await saveArtifact(pool, { bytes: Buffer.from('new letter'), mime: 'text/plain', filename: 'Letter v2.txt', createdBy: AGENT_ID, conversationId: null }, env);
    const outputs: Record<string, unknown> = {
      read: { source: true, fileId: old.fileId, version: 1, artifactId: old.id, kind: 'docx', library: 'docx', libraryVersion: '9', program: 'export default 1', note: 'The program of v1.' },
      same: { artifactId: old.id, fileId: old.fileId, version: 1, filename: 'Letter.txt', mime: 'text/plain', unchanged: true, note: 'nothing new was saved' },
      save: { artifactId: fresh.id, fileId: fresh.fileId, version: 1, filename: 'Letter v2.txt', mime: 'text/plain', note: 'Saved' },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'fixture', version: '1.0.0', schema: 'fixture', migrationsDir: '',
      tools: [{
        name: 'fixture.compose', description: 'Read, keep or save a document.', tier: 'auto', producesArtifacts: true,
        input: z.object({ step: z.enum(['read', 'same', 'save']) }),
        async execute(input: { step: string }) { return outputs[input.step]; },
      }],
    });
    const provider = new ScriptedProvider();
    provider.script = [call('t1', { step: 'read' }), call('t2', { step: 'same' }), call('t3', { step: 'save' })];
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ($1) returning id`, [AGENT_ID]);
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', agentId: AGENT_ID, conversationId: String(rows[0].id), now: () => new Date(), timezone: 'UTC' };
    // The files the run asks to send, by id; nothing is sent from here.
    const asked: string[] = [];
    const real = createCoreArtifactStore({ pool, env });
    const artifacts: ArtifactStore = { ...real, describe: async (id) => { asked.push(id); return null; } };
    const sent: string[] = [];
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: OWNER_CHAT, externalChatId: OWNER_CHAT, pairedVia: 'code' });
    handle = await startTelegram({
      pool, registry, catalog: catalog(), provider, ctx, env, artifacts,
      now: () => new Date(), api: fakeApi(sent, 'change my letter'), jobs: null, log: () => {},
    } as never);

    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 20_000, interval: 50 });
    expect(provider.script).toHaveLength(0);
    expect(asked).toEqual([fresh.id]);
  }, 60_000);
});
