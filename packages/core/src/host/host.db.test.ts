/**
 * `ctx.buddi`, built by core for each plugin (docs/specs/plugin-host-api.md).
 *
 * What the spec promises, checked where it lives: the six always-present
 * areas and only the declared ones beside them; one host per plugin, however
 * many plugins share a run's context; the files and accounts scopes; the
 * transaction's search path; an undeclared host logged, not refused. The
 * database is created by this suite, named after this process, and dropped.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { ToolRegistry } from '../registry.js';
import { runSources } from '../sources/run.js';
import type { PluginManifest, ToolContext } from '../tools.js';
import type { ProviderAccountsAccess } from '../provider-accounts.js';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from './build.js';
import type { BuddiHost } from './types.js';
import { BlockedError } from '../plugin/url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_host_${process.pid}`;

/** A plugin whose one tool hands back the host it was given. */
function plugin(name: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    schema: name,
    migrationsDir: '',
    tools: [
      {
        name: `${name}.host`,
        description: 'hand back ctx.buddi',
        tier: 'auto',
        input: z.object({}),
        execute: async (_input: unknown, ctx: ToolContext) => ctx.buddi,
      },
    ],
    ...extra,
  };
}

suite('ctx.buddi', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  const now = new Date('2026-09-24T03:30:00Z');

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => now,
    timezone: 'America/New_York',
    agentId: 'assistant',
    ...over,
  });

  async function hostOf(registry: ToolRegistry, tool: string, over: Partial<ToolContext> = {}): Promise<BuddiHost> {
    const result = await registry.invoke(tool, {}, ctx(over));
    if (!result.ok) throw new Error(result.message);
    return result.output as BuddiHost;
  }

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
    await pool.query('create schema if not exists weather');
    await pool.query('create table weather.readings (id serial primary key, at text)');
    dataDir = mkdtempSync(path.join(tmpdir(), 'buddi-host-'));
  }, 120_000);

  afterEach(() => resetPluginHost());

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives a plugin with no uses only the always-present areas', async () => {
    const registry = new ToolRegistry();
    registry.register(plugin('weather'));
    const host = await hostOf(registry, 'weather.host');
    expect(host.version).toBe('1.0');
    expect(host.plugin).toBe('weather');
    for (const area of ['owner', 'clock', 'db', 'dir', 'approvals', 'pages'] as const) {
      expect(host[area], area).toBeDefined();
    }
    for (const area of ['http', 'accounts', 'files', 'memory', 'proposals', 'schedule', 'secrets'] as const) {
      expect(host[area], area).toBeUndefined();
    }
    expect(host.owner.id).toBe('owner');
    expect(host.clock.today()).toBe('2026-09-23');
  });

  it('builds each plugin its own host from one shared context', async () => {
    const registry = new ToolRegistry();
    registry.register(plugin('weather'));
    registry.register(plugin('garden', { uses: ['files', 'http'] }));
    const shared = ctx();
    const a = await registry.invoke('weather.host', {}, shared);
    const b = await registry.invoke('garden.host', {}, shared);
    if (!a.ok || !b.ok) throw new Error('invoke failed');
    expect((a.output as BuddiHost).plugin).toBe('weather');
    expect((b.output as BuddiHost).plugin).toBe('garden');
    expect((b.output as BuddiHost).files).toBeDefined();
    expect((b.output as BuddiHost).http).toBeDefined();
    // The caller's context is not written to.
    expect(shared.buddi).toBeUndefined();
  });

  it('refuses at register() an area this build does not have', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(plugin('weather', { uses: ['telepathy' as never] }))).toThrow(
      /plugin weather's manifest uses names "telepathy"/,
    );
    expect(registry.manifests()).toEqual([]);
  });

  it('runs a transaction with the plugin schema first on the search path', async () => {
    const host = createPluginHost(hostBindingOf(plugin('weather')), ctx());
    const count = await host.db.transaction(async (tx) => {
      await tx.query(`insert into readings (at) values ($1)`, ['dawn']);
      return (await tx.query<{ n: number }>('select count(*)::int as n from readings')).rows[0]?.n;
    });
    expect(count).toBe(1);
    await expect(
      host.db.transaction(async (tx) => {
        await tx.query(`insert into readings (at) values ('dusk')`);
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect((await host.db.query('select at from weather.readings')).rows).toEqual([{ at: 'dawn' }]);
  });

  it('says how many rows a statement touched, outside a transaction and in one', async () => {
    const host = createPluginHost(hostBindingOf(plugin('weather')), ctx());
    await host.db.query(`insert into weather.readings (at) values ('first'), ('second')`);
    const inside = await host.db.transaction((tx) => tx.query(`update readings set at = at || '!' where at in ('first', 'second')`));
    expect(inside.rowCount).toBe(2);
    expect((await host.db.query(`delete from weather.readings where at = 'dusk'`)).rowCount).toBe(0);
  });

  it('keeps a directory of the plugin its own', () => {
    configurePluginHost({ env: { BUDDI_DATA_DIR: dataDir } });
    const host = createPluginHost(hostBindingOf(plugin('weather')), ctx());
    expect(host.dir.path).toBe(path.join(dataDir, 'plugins-data', 'weather'));
  });

  it('scopes files to what the plugin saved and what its conversation was handed', async () => {
    configurePluginHost({ env: { BUDDI_DATA_DIR: dataDir } });
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('assistant') returning id`);
    const conversationId = rows[0].id as string;
    const garden = createPluginHost(hostBindingOf(plugin('garden', { uses: ['files'] })), ctx());
    const saved = await garden.files!.save({ bytes: Buffer.from('seeds'), mime: 'text/plain', filename: 'seeds.txt' });
    expect(saved).not.toHaveProperty('storagePath');
    expect((await garden.files!.read(saved.id)).toString()).toBe('seeds');

    const other = createPluginHost(hostBindingOf(plugin('other', { uses: ['files'] })), ctx());
    expect(await other.files!.get(saved.id)).toBeNull();
    await expect(other.files!.read(saved.id)).rejects.toThrow(/no file/);

    // Handed into the conversation the other plugin's tool is running in.
    await pool.query(
      `insert into core.artifact_uses (artifact_id, conversation_id, kind) values ($1, $2, 'uploaded')`,
      [saved.id, conversationId],
    );
    const inConversation = createPluginHost(
      hostBindingOf(plugin('other', { uses: ['files'] })),
      ctx({ conversationId }),
    );
    expect((await inConversation.files!.get(saved.id))?.filename).toBe('seeds.txt');

    const library = createPluginHost(hostBindingOf(plugin('finance', { uses: ['files:library'] })), ctx());
    expect((await library.files!.list()).map((f) => f.id)).toContain(saved.id);
    expect((await other.files!.list()).map((f) => f.id)).not.toContain(saved.id);
  });

  it('resolves only an account the owner bound, and only the owner binds', async () => {
    await pool.query(
      `insert into core.provider_accounts (id, label, kind, auth, base_url, default_model)
       values ('work', 'Work', 'openai', 'api-key', 'https://api.openai.com/v1', 'gpt-image-1')`,
    );
    const resolved: string[] = [];
    const providerAccounts: ProviderAccountsAccess = {
      list: () => [{ id: 'work', label: 'Work', kind: 'openai', enabled: true, configured: true, defaultModel: 'x' }],
      resolve: async (id, model) => {
        resolved.push(id);
        return { kind: 'openai', baseUrl: 'https://api.openai.com/v1', credentialKind: 'api-key', secret: 'k', model };
      },
      withCodexProfile: async () => {
        throw new Error('not here');
      },
    };
    const binding = hostBindingOf(plugin('image', { uses: ['accounts'] }));
    const asAgent = createPluginHost(binding, ctx({ providerAccounts }));
    await expect(asAgent.accounts!.resolve('work', 'gpt-image-1')).rejects.toThrow(/has not given image/);
    await expect(asAgent.accounts!.bind('work')).rejects.toThrow(/Only the owner/);

    const asOwner = createPluginHost(binding, ctx({ providerAccounts, agentId: 'owner' }));
    await expect(asOwner.accounts!.bind('nope')).rejects.toThrow(/no model account/);
    await asOwner.accounts!.bind('work');
    await asAgent.accounts!.resolve('work', 'gpt-image-1');
    expect(resolved).toEqual(['work']);
    expect(asAgent.accounts!.list()[0]).not.toHaveProperty('secret');
  });

  it('logs a request to an undeclared host once, and sends it on the shared transport', async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    configurePluginHost({
      log: (line) => lines.push(line),
      httpTransport: () => async (url) => {
        sent.push(url);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          text: async () => '',
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    });
    const binding = hostBindingOf(
      plugin('weather', { uses: ['http'], network: [{ host: '*.open-meteo.com', why: 'forecasts' }] }),
    );
    const host = createPluginHost(binding, ctx());
    await host.http!.request({ url: 'https://api.open-meteo.com/v1/forecast' });
    await host.http!.request({ url: 'https://example.com/a' });
    await host.http!.request({ url: 'https://example.com/b' });
    expect(sent).toHaveLength(3);
    expect(lines).toEqual(['[weather] a request to example.com, which its manifest does not declare under network']);
  });

  it('refuses a URL the address rules refuse, before anything is sent, and resolves through the guard', async () => {
    const lookups: unknown[] = [];
    configurePluginHost({
      httpTransport: ({ lookup }) => {
        lookups.push(lookup);
        return async () => {
          throw new Error('nothing should be sent');
        };
      },
    });
    const host = createPluginHost(hostBindingOf(plugin('weather', { uses: ['http'] })), ctx());
    await expect(host.http!.request({ url: 'http://127.0.0.1:4317/api/session' })).rejects.toBeInstanceOf(BlockedError);
    await expect(host.http!.request({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toBeInstanceOf(BlockedError);
    expect(lookups).toEqual([]);
    await expect(host.http!.request({ url: 'https://example.com/' })).rejects.toThrow('nothing should be sent');
    expect(lookups).toHaveLength(1);
    expect(typeof lookups[0]).toBe('function');
  });

  it('answers approvals for its own tools only', async () => {
    const host = createPluginHost(hostBindingOf(plugin('weather')), ctx({ conversationId: undefined }));
    await expect(host.approvals.standing('email.send')).rejects.toThrow(/not one of its own tools/);
    expect(await host.approvals.standing('weather.host')).toBeNull();
    await expect(host.approvals.approvedInConversation('email.send', '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /not one of its own tools/,
    );
  });

  it('counts only its own open proposals, and reads reminders by one context key', async () => {
    const host = createPluginHost(hostBindingOf(plugin('email', { uses: ['proposals', 'schedule'] })), ctx());
    expect(await host.proposals!.countOpen()).toBe(0);
    await pool.query(
      `insert into core.reminders (agent_id, due_at, text, context)
       values ('assistant', '2026-09-25T14:00:00Z', 'the dentist', '{"threadId":"t1"}')`,
    );
    expect(
      await host.schedule!.remindersFor({ contextKey: 'threadId', values: ['t1', 't2'] }, ['2026-09-25', '2026-09-26']),
    ).toEqual([{ value: 't1', day: '2026-09-25' }]);
  });

  it('hands a source the host of the plugin that ships it', async () => {
    let seen: BuddiHost | undefined;
    const manifest = plugin('email', {
      uses: ['schedule'],
      sources: [{ id: 'email.poll', description: 'poll', every: 60, poll: async (c) => void (seen = c.buddi) }],
    });
    await runSources(pool, [manifest], { now, timezone: 'UTC', enqueueRun: async () => {} });
    expect(seen?.plugin).toBe('email');
    expect(seen?.schedule).toBeDefined();
  });
});
