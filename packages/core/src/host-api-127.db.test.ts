/**
 * Host API 1.27 against Postgres: `optional` plugins and `plugins.has`, core's
 * own call to an export for a mission's `context`, a mission's `context` and
 * `reportMax` kept on its row, and a notification's voice note.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';
import { ToolRegistry } from './registry.js';
import type { CoreToolContext, PluginManifest } from './tools.js';
import { resetPluginHost } from './host/build.js';
import type { BuddiHost } from './host/types.js';
import { getMission, setMissionExtras, upsertMission } from './scheduler/missions.js';
import { clearChannels, registerChannel } from './notifications/channels.js';
import { notifyOwner } from './notifications/notify.js';
import type { DeliverableMessage } from './notifications/types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_host127_${process.pid}`;

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
        execute: async (_input: unknown, ctx: CoreToolContext) => ctx.buddi,
      },
    ],
    ...extra,
  };
}

suite('host API 1.27 (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const now = new Date('2026-10-03T07:00:00Z');
  const ctx = (): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => now, timezone: 'Europe/Paris', agentId: 'anchor' });
  async function hostOf(registry: ToolRegistry, tool: string): Promise<BuddiHost> {
    const result = await registry.invoke(tool, {}, ctx());
    if (!result.ok) throw new Error(result.message);
    return result.output as BuddiHost;
  }

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterEach(() => {
    resetPluginHost();
    clearChannels();
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const voice = {
    params: z.object({ text: z.string() }).strict(),
    async produce(params: { text: string }, c: CoreToolContext) {
      return { said: params.text, by: c.buddi!.plugin };
    },
  };

  it('optional: has() says whether the plugin is there in range, and call() reaches it while it is', async () => {
    const r = new ToolRegistry();
    r.register(plugin('news', { optional: { speech: '^0.1.3' } }));
    const host = await hostOf(r, 'news.host');
    expect(host.plugins!.has!('speech')).toBe(false);
    await expect(host.plugins!.call('speech', 'voice', { text: 'hi' })).rejects.toThrow(/speech is not loaded/);
    r.register(plugin('speech', { version: '0.1.4', exports: { voice } }));
    expect(host.plugins!.has!('speech')).toBe(true);
    expect(await host.plugins!.call('speech', 'voice', { text: 'hi' })).toEqual({ said: 'hi', by: 'speech' });
    // A name it did not declare is never there, loaded or not.
    expect(host.plugins!.has!('news')).toBe(false);
    r.unregister('speech');
    r.register(plugin('speech', { version: '0.2.0', exports: { voice } }));
    expect(host.plugins!.has!('speech')).toBe(false);
    await expect(host.plugins!.call('speech', 'voice', { text: 'hi' })).rejects.toThrow(/needs speech \^0\.1\.3, and 0\.2\.0 is installed/);
  });

  it('a plugin with nothing optional and nothing required still has no plugins area', async () => {
    const r = new ToolRegistry();
    r.register(plugin('lonely'));
    expect((await hostOf(r, 'lonely.host')).plugins).toBeUndefined();
  });

  it('core calls an export for a mission context with the target\'s read-only host and its own params', async () => {
    const r = new ToolRegistry();
    const material = {
      params: z.object({ edition: z.enum(['morning', 'evening']) }).strict(),
      async produce(params: { edition: string }, c: CoreToolContext) {
        const { rows } = await c.buddi!.db.query<{ n: number }>('select 2 as n');
        return { edition: params.edition, n: rows[0]!.n, plugin: c.buddi!.plugin };
      },
    };
    r.register(plugin('news', { exports: { material } }));
    expect(await r.callExportAsCore('news', 'material', { edition: 'morning' }, ctx())).toEqual({ edition: 'morning', n: 2, plugin: 'news' });
    await expect(r.callExportAsCore('news', 'material', { edition: 'noon' }, ctx())).rejects.toThrow(/edition/);
    await expect(r.callExportAsCore('news', 'nothing', {}, ctx())).rejects.toThrow(/exports no "nothing"/);
    await expect(r.callExportAsCore('absent', 'material', {}, ctx())).rejects.toThrow(/absent is not loaded/);
  });

  it('keeps a mission\'s context and reportMax, and an update changes only them', async () => {
    const saved = await upsertMission(pool, {
      id: 'agent:anchor:morning',
      name: 'Morning edition',
      agentId: 'anchor',
      prompt: 'Write the morning edition.',
      context: { plugin: 'news', export: 'edition_material', args: { edition: 'morning' } },
      reportMax: 3800,
    });
    expect(saved).toMatchObject({ context: { plugin: 'news', export: 'edition_material', args: { edition: 'morning' } }, reportMax: 3800 });
    await pool.query(`update core.missions set prompt = 'The owner changed it.' where id = $1`, [saved.id]);
    await setMissionExtras(pool, saved.id, { context: null, reportMax: 5000 });
    expect(await getMission(pool, saved.id)).toMatchObject({ prompt: 'The owner changed it.', context: null, reportMax: 5000 });
    const plain = await upsertMission(pool, { id: 'plain', name: 'Plain', agentId: 'anchor', prompt: 'p' });
    expect(plain).toMatchObject({ context: null, reportMax: null });
  });

  it('carries a report\'s voice note to the channel, and never folds a message that has one', async () => {
    const delivered: DeliverableMessage[] = [];
    registerChannel({ kind: 'test.voice', can: { offers: false, attachments: true, markdown: false }, describe: () => ({ label: 'Test' }), deliver: async (m) => { delivered.push(m); return { id: 'x' }; } });
    const audio = '7c1b0a52-6f0e-4b8e-9d55-1e0f2a3b4c5d';
    const result = await notifyOwner(pool, { now: () => now, timezone: 'Europe/Paris' }, {
      kind: 'recap', urgency: 'now', title: 'Morning edition', text: 'Six stories.', audio, link: { route: '#/p/news/stories' },
    });
    const { rows } = await pool.query(`select audio::text as audio, link from core.owner_notifications where id = $1`, [result.id]);
    expect(rows[0]).toEqual({ audio, link: '#/p/news/stories' });
    expect(delivered.at(-1)).toMatchObject({ audio, link: { route: '#/p/news/stories' } });
    // Not an id: dropped rather than stored.
    const bad = await notifyOwner(pool, { now: () => now, timezone: 'Europe/Paris' }, { kind: 'recap', urgency: 'now', title: 'Again', audio: '../x' });
    expect((await pool.query(`select audio from core.owner_notifications where id = $1`, [bad.id])).rows[0].audio).toBeNull();
  });
});
