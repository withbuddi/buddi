/**
 * The tips against Postgres: the facts read from what the installation holds,
 * and the routes over the wire, signed in, with the state kept in
 * `core.web_settings`. Own database, dropped after; skipped without one.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, readWebSetting, runMigrations, testDatabaseUrl, type CoreToolContext } from '@buddi/core/testing';
import { createToolRegistry, loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { mintTicket } from '../web/token.js';
import { createWebApp } from '../web/server.js';
import { csrfCookieName, portOf } from '../web/http.js';
import { readFacts, recordPageSeen, webSettingsStore, TIPS_PAGES_KEY } from './facts.js';
import { TIPS_STATE_KEY } from './route.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_tips_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const NOW = new Date('2026-09-28T10:00:00Z');

function agent(id: string, extra: string[] = []): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id[0]!.toUpperCase()}${id.slice(1)}`, `description: The ${id}.`,
    'provider: anthropic', 'model: claude-sonnet-5', 'tools: [system.*]', ...extra, '---', '', `You are ${id}.`, ''].join('\n');
}

suite('tips against Postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let server: ReturnType<typeof createWebApp>;
  let base: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);

    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-tips-'));
    mkdirSync(path.join(dir, 'agents', 'concierge'), { recursive: true });
    writeFileSync(path.join(dir, 'agents', 'concierge', 'agent.md'), agent('concierge', ['roles: [front-desk]', 'default: true']));
    const assets = path.join(dir, 'web');
    mkdirSync(assets);
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>buddi</title>');
    const env = {} as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
    const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: path.join(dir, 'agents'), env, registry }));
    server = createWebApp({
      pool,
      registry,
      catalog,
      ctx: { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' } as CoreToolContext,
      timezone: 'UTC',
      now: () => NOW,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      openAccess: false,
      token: TOKEN,
      env,
      assetsDir: assets,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  const factsNow = (agents: { id: string; roles?: string[] }[], plugins: string[] = [], mailbox = false) =>
    readFacts({ pool, now: () => NOW, agents: () => agents, plugins: () => plugins, mailboxSet: async () => mailbox });

  it('reads a fresh installation as first run, with nothing used', async () => {
    const f = await factsNow([{ id: 'concierge' }, { id: 'agent-father', roles: ['maker'] }]);
    expect(f).toMatchObject({
      firstRun: true, daysSinceInstall: 0, agents: 1, groups: 0, missions: 0, mailboxSet: false,
      voiceUsed: false, browserUsed: false, telegramPaired: false, speechInstalled: false,
    });
    expect([...f.toolsUsed]).toEqual([]);
  });

  it('reads what the installation holds', async () => {
    await pool.query(`insert into core.owner (id, created_at) values ('owner', $1) on conflict (id) do update set created_at = excluded.created_at`, [new Date('2026-09-18T09:00:00Z')]);
    await pool.query(`insert into core.onboarding (owner_id, state, started_at) values ('owner', 'done', $1)
                      on conflict (owner_id) do update set state = 'done', started_at = excluded.started_at`, [new Date('2026-09-18T09:00:00Z')]);
    await pool.query(`insert into core.groups (name, coordinator_agent_id) values ('Crew', 'concierge')`);
    await pool.query(`insert into core.groups (name, coordinator_agent_id, archived_at) values ('Old', 'concierge', now())`);
    await pool.query(`insert into core.missions (id, name, agent_id, prompt) values ('m1', 'Brief', 'planner', 'Brief me.')`);
    await pool.query(`insert into core.events (kind, payload) values ('tool.called', '{"name":"browser.act"}'), ('tool.called', '{"name":"memory.save"}')`);
    await pool.query(`insert into core.artifacts (kind, mime, size_bytes, sha256, storage_path, created_by)
                      values ('audio', 'audio/webm', 10, 'abc', 'artifacts/a.webm', 'owner')`);
    await pool.query(`insert into core.surface_identities (owner_id, surface, external_user_id) values ('owner', 'telegram', '42')`);
    await recordPageSeen(webSettingsStore(pool), 'settings/notifications', '2026-09-28');

    const f = await factsNow([{ id: 'concierge' }, { id: 'mail-triage' }], ['email', 'speech', 'browser'], true);
    expect(f).toMatchObject({
      firstRun: false, daysSinceInstall: 10, agents: 2, groups: 1, missions: 1, mailboxSet: true, mailAgent: true,
      speechInstalled: true, voiceUsed: true, browserUsed: true, telegramPaired: true,
    });
    expect([...f.toolsUsed].sort()).toEqual(['browser.act', 'memory.save']);
    expect([...f.pagesVisited]).toEqual(['settings/notifications']);
    expect(await readWebSetting(pool, TIPS_PAGES_KEY)).toEqual({ 'settings/notifications': '2026-09-28' });
  });

  it('reads the lock tip facts: no PIN, a second device remembered once seen, money connected', async () => {
    const session = (id: string, scope: string, via: string, address: string | null) => pool.query(
      `insert into core.dashboard_sessions (id_hash, scope, via, tailscale_address, ttl_ms, created_at, expires_at, last_seen_at)
       values ($1, $2, $3, $4, 3600000, now(), now() + interval '1 hour', now())`,
      [id.repeat(64).slice(0, 64), scope, via, address],
    );
    await session('a', 'local', 'local', null);
    expect(await factsNow([{ id: 'concierge' }])).toMatchObject({ pinSet: false, secondDevice: false, financeConnected: false });
    // The same Mac again is not a second device; a phone on the tailnet is.
    await session('b', 'local', 'local', null);
    expect((await factsNow([{ id: 'concierge' }])).secondDevice).toBe(false);
    await session('c', 'remote', 'tailscale', '100.64.0.7');
    expect((await factsNow([{ id: 'concierge' }])).secondDevice).toBe(true);
    // Remembered after the phone's session is gone.
    await pool.query(`delete from core.dashboard_sessions where tailscale_address is not null`);
    expect((await factsNow([{ id: 'concierge' }])).secondDevice).toBe(true);
    await pool.query(`insert into core.web_settings (key, value) values ('lock.pin', '{}'::jsonb) on conflict (key) do nothing`);
    expect((await factsNow([{ id: 'concierge' }])).pinSet).toBe(true);
    await pool.query(`delete from core.web_settings where key = 'lock.pin'`);
    await pool.query(`create schema if not exists finance; create table if not exists finance.accounts (id text)`);
    expect((await factsNow([{ id: 'concierge' }], ['finance'])).financeConnected).toBe(false);
    await pool.query(`insert into finance.accounts values ('checking')`);
    expect((await factsNow([{ id: 'concierge' }], ['finance'])).financeConnected).toBe(true);
    await pool.query(`drop schema finance cascade`);
    await pool.query(`delete from core.dashboard_sessions; delete from core.web_settings where key = 'tips.secondDevice'`);
  });

  it('serves the routes over the wire', async () => {
    const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { redirect: 'manual' });
    const jar = new Map<string, string>();
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = (pair as string).split('=');
      jar.set(name as string, value as string);
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = jar.get(csrfCookieName(portOf(new URL(base)))) as string;
    const call = async (method: string, route: string, body?: unknown) => {
      const r = await fetch(`${base}/api/tips${route}`, {
        method,
        headers: { cookie, 'x-buddi-csrf': csrf, origin: base, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as any };
    };

    expect((await fetch(`${base}/api/tips/current`)).status).toBe(401);
    // One agent past day three: the teammate tip.
    // Held since yesterday: every rule waits a day before it shows.
    await webSettingsStore(pool).write(TIPS_STATE_KEY, { 'second-agent': { firstHeld: '2026-09-27' } });
    expect((await call('GET', '/settings')).body).toEqual({ enabled: true });
    const current = await call('GET', '/current');
    expect(current.status).toBe(200);
    expect(current.body.tip?.id).toBe('second-agent');
    const state = await readWebSetting<Record<string, { shownAt?: string }>>(pool, TIPS_STATE_KEY);
    expect(state?.['second-agent']?.shownAt).toBe('2026-09-28');

    expect((await call('POST', '/second-agent/dismiss', {})).body).toEqual({ ok: true });
    expect((await call('GET', '/current')).body.tip).toBeNull();
    const listed = await call('GET', '');
    expect(listed.status).toBe(200);
    expect(listed.body.tips.find((t: any) => t.id === 'second-agent')).toMatchObject({ status: 'dismissed', dismissedAt: '2026-09-28' });
    expect((await call('POST', '/second-agent/restore', {})).body).toEqual({ ok: true });
    expect((await call('GET', '')).body.tips.find((t: any) => t.id === 'second-agent').status).toBe('shown');
    await call('POST', '/second-agent/dismiss', {});
    expect((await call('PUT', '/settings', { enabled: false })).body).toEqual({ enabled: false });
    expect((await call('GET', '/current')).body).toEqual({ tip: null, enabled: false });
    expect((await call('POST', '/seen-page', { page: 'home' })).status).toBe(200);
  });
});
