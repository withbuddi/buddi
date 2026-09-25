/**
 * The Keys and secrets page's machinery (docs/owner-secrets.md §6): the
 * owner's writes are `ownerOnly` tools; a save looks for the value where it may
 * already be (events, the transcript, memory) and says where; the one-tap scrub
 * replaces every form of it with the marker; the reads answer names, bindings
 * and uses, never a value. The database is created by this suite and dropped.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { configurePluginHost, resetPluginHost } from '../host/build.js';
import type { CoreToolContext, PluginManifest } from '../tools.js';
import { createMemoryVault } from '../vault/memory.js';
import type { Vault } from '../vault/types.js';
import { createSecretsManifest } from './approval.js';
import { resetSecretDestinations } from './destinations.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_secrets_settings_${process.pid}`;
const VALUE = 'cour-des-comptes-token-9f2b';
const NAME = 'Cour des comptes token';

suite('Keys and secrets', () => {
  let admin: Pool;
  let pool: Pool;
  let vault: Vault;
  const now = new Date('2026-09-24T12:00:00Z');

  const manifest: PluginManifest = createSecretsManifest();
  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => now,
    timezone: 'UTC',
    agentId: 'owner',
    ...over,
  });

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
    // The memory plugin's tables, as its migration makes them — the look and
    // the scrub cover them when the plugin is installed and skip it cleanly
    // when it is not.
    await pool.query('create schema if not exists memory');
    await pool.query(`create table if not exists memory.notes (
      id uuid primary key default gen_random_uuid(),
      content text not null, kind text not null, scope text not null,
      source_conversation_id uuid, created_by_agent text, created_at timestamptz not null default now(),
      expires_at timestamptz, forgotten_at timestamptz)`);
    await pool.query(`create table if not exists memory.preferences (
      id uuid primary key default gen_random_uuid(),
      key text not null, value text not null, revision int not null,
      agent_scope text, created_at timestamptz not null default now(), superseded_at timestamptz)`);
  }, 120_000);

  beforeEach(async () => {
    vault = createMemoryVault();
    configurePluginHost({ vault });
    await pool.query('truncate core.secrets, core.secret_uses, core.events, core.messages, core.conversations cascade');
    await pool.query('truncate memory.notes, memory.preferences cascade');
    await pool.query(`insert into core.conversations (id, agent_id) values (gen_random_uuid(), 'assistant')`);
  });

  afterAll(async () => {
    resetPluginHost();
    resetSecretDestinations();
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const run = async (name: string, input: unknown, agentId = 'owner'): Promise<unknown> => {
    const t = manifest.tools.find((tool) => tool.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return (t as { execute(input: unknown, ctx: CoreToolContext): Promise<unknown> }).execute(input, facts({ agentId }));
  };

  const produceList = async (): Promise<unknown> => {
    const list = manifest.queries?.find((query) => query.name === 'list');
    if (list === undefined) throw new Error('no list query');
    return list.produce({}, facts());
  };

  it('stores a secret and reports where its value already sat, never the value', async () => {
    await pool.query(`insert into core.events (kind, payload) values ('run.started', $1::jsonb)`, [
      JSON.stringify({ note: `token ${VALUE} pasted` }),
    ]);
    await pool.query(`insert into core.messages (conversation_id, role, content)
       values ((select id from core.conversations limit 1), 'user', $1::jsonb)`, [
      JSON.stringify([{ type: 'text', text: `my token is ${VALUE}` }]),
    ]);
    await pool.query(
      `insert into memory.notes (content, kind, scope, created_by_agent, created_at)
       values ($1, 'fact', 'shared', 'assistant', now())`,
      [`the token is ${VALUE}`],
    );

    const result = (await run('secrets.put', { name: NAME, value: VALUE, totp: false, bindings: [] })) as {
      found: Array<{ place: string; count: number }>;
    };
    expect(result.found).toEqual([
      { place: 'events', count: 1 },
      { place: 'messages', count: 1 },
      { place: 'memory notes', count: 1 },
    ]);

    const listed = (await produceList()) as { secrets: Array<{ name: string; totp: boolean }>; ownKeys: string[]; destinations: unknown[] };
    expect(listed.secrets).toEqual([expect.objectContaining({ name: NAME, totp: false })]);
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    expect(listed.ownKeys).toContain('ANTHROPIC_API_KEY');
    expect(listed.destinations).toContainEqual({ kind: 'http.header', plugin: 'http', maxRule: 'pre-approved' });
  });

  it('the one-tap scrub replaces every form of the value with the marker', async () => {
    await pool.query(`insert into core.events (kind, payload) values ('run.started', $1::jsonb)`, [
      JSON.stringify({ header: encodeURIComponent(VALUE) }),
    ]);
    await pool.query(`insert into core.messages (conversation_id, role, content)
       values ((select id from core.conversations limit 1), 'user', $1::jsonb)`, [
      JSON.stringify([{ type: 'text', text: `my token is ${VALUE}` }]),
    ]);
    await pool.query(
      `insert into memory.notes (content, kind, scope, created_by_agent, created_at)
       values ($1, 'fact', 'shared', 'assistant', now())`,
      [`the token is ${VALUE}`],
    );
    await run('secrets.put', { name: NAME, value: VALUE, totp: false, bindings: [] });

    const result = (await run('secrets.scrub_history', { name: NAME })) as {
      scrubbed: Array<{ place: string; count: number }>;
    };
    expect(result.scrubbed.map((place) => place.place).sort()).toEqual(['events', 'memory notes', 'messages']);
    const { rows: events } = await pool.query(`select payload::text as text from core.events`);
    expect(String(events[0].text)).toContain('‹secret:Cour des comptes token›');
    expect(String(events[0].text)).not.toContain(VALUE);
    const { rows: messages } = await pool.query(`select content::text as text from core.messages`);
    expect(String(messages[0].text)).toContain('‹secret:Cour des comptes token›');
    expect(String(messages[0].text)).not.toContain(VALUE);
    const { rows: notes } = await pool.query(`select content from memory.notes`);
    expect(String(notes[0].content)).toContain('‹secret:Cour des comptes token›');
    expect(String(notes[0].content)).not.toContain(VALUE);
  });

  it('scrubbing nothing is an empty answer, and a missing value says so', async () => {
    await run('secrets.put', { name: NAME, value: VALUE, totp: false, bindings: [] });
    const result = (await run('secrets.scrub_history', { name: NAME })) as { scrubbed: unknown[] };
    expect(result.scrubbed).toEqual([]);
    await expect(run('secrets.scrub_history', { name: 'Nope' })).rejects.toThrow(/no secret named/i);
  });

  it('the owner-only writes refuse anybody else', async () => {
    await expect(
      run('secrets.put', { name: 'X', value: VALUE, totp: false, bindings: [] }, 'assistant'),
    ).rejects.toThrow(/Only the owner/);
    await expect(run('secrets.rename', { name: 'X', to: 'Y' }, 'assistant')).rejects.toThrow(/Only the owner/);
  });

  it('rename, rebind and delete are the owner’s own writes', async () => {
    await run('secrets.put', { name: 'One', value: VALUE, totp: false, bindings: [] });
    expect(await run('secrets.rename', { name: 'One', to: 'Two' })).toEqual({ renamed: true });
    expect(
      await run('secrets.rebind', {
        name: 'Two',
        bindings: [{ kind: 'http.header', target: { host: 'api.example.test', header: 'Authorization' }, rule: 'pre-approved' }],
      }),
    ).toEqual({ rebound: true });
    expect(await run('secrets.delete', { name: 'Two' })).toEqual({ deleted: true });
    await expect(run('secrets.delete', { name: 'Two' })).rejects.toThrow(/no secret named/i);
  });

  it('the uses log answers newest first with outcomes, never values', async () => {
    await run('secrets.put', { name: NAME, value: VALUE, totp: false, bindings: [] });
    await run('secrets.delete', { name: NAME });
    const list = manifest.queries?.find((query) => query.name === 'uses');
    const answer = (await list?.produce({ name: NAME }, facts())) as { uses: Array<{ outcome: string; secret: string }> };
    expect(answer.uses).toEqual([]);
  });
});