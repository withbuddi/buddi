/**
 * Settings → Connections over the wire (docs/connections.md): the four
 * screens' routes, the consent state bound to the dashboard session, the
 * callback page served before the gate, grants written into agent files
 * through the owner path, and disconnect taking them out again.
 *
 * Postgres for the connection rows (skipped without DATABASE_URL, own
 * database, dropped after); an in-process MCP server and authorization server
 * behind a fake transport. No socket leaves the process except to this
 * test's own dashboard on loopback.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryVault, createPool, runMigrations, testDatabaseUrl, type CoreToolContext } from '@buddi/core/testing';
import { createOAuthPort } from '@buddi/runtime';
import { bindConnections, manifest as connectionsManifest, vaultRefFor } from '@buddi/tool-mcp';
import { Fake, MCP_URL } from '@buddi/tool-mcp/testing';
import { createToolRegistry, loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { bindPlatformTools } from '../agents/platform.js';
import { mintTicket } from './token.js';
import { createWebApp } from './server.js';
import { csrfCookieName, portOf } from './http.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_connections_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';

function agent(id: string, extra: string[] = []): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id[0]!.toUpperCase()}${id.slice(1)}`, `description: The ${id}.`,
    'provider: anthropic', 'model: claude-sonnet-5', 'tools: [system.*]', ...extra, '---', '', `You are ${id}.`, ''].join('\n');
}

suite('connections routes', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let server: ReturnType<typeof createWebApp>;
  let base: string;
  const fake = new Fake({ auth: true, json: true });
  const vault = createMemoryVault();

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [connectionsManifest]);

    dir = mkdtempSync(path.join(tmpdir(), 'buddi-web-connections-'));
    for (const [id, extra] of [['concierge', ['roles: [front-desk]', 'default: true']], ['helper', []]] as const) {
      mkdirSync(path.join(dir, 'agents', id), { recursive: true });
      writeFileSync(path.join(dir, 'agents', id, 'agent.md'), agent(id, [...extra]));
    }
    const assets = path.join(dir, 'web');
    mkdirSync(assets);
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>buddi</title>');

    const env = { ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
    const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: path.join(dir, 'agents'), env, registry }));
    registry.onChange(() => catalog.reload());
    bindPlatformTools(registry, { catalog, reload: () => catalog.reload(), agentsDir: path.join(dir, 'agents') });
    const connections = bindConnections(registry.manifests(), { pool, vault, transport: fake.transport, oauth: createOAuthPort({ transport: fake.transport }), log: () => {} });
    server = createWebApp({
      pool,
      registry,
      catalog,
      ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      openAccess: false,
      token: TOKEN,
      env,
      assetsDir: assets,
      connections,
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

  const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
    const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { redirect: 'manual' });
    const jar = new Map<string, string>();
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = (pair as string).split('=');
      jar.set(name as string, value as string);
    }
    return { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), csrf: jar.get(csrfCookieName(portOf(new URL(base)))) as string };
  };

  const call = async (who: { cookie: string; csrf: string }, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}/api/connections${route}`, {
      method,
      headers: { cookie: who.cookie, 'x-buddi-csrf': who.csrf, origin: base, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const agentFile = (id: string): string => readFileSync(path.join(dir, 'agents', id, 'agent.md'), 'utf8');

  it('serves the callback page without a session, and nothing else', async () => {
    const page = await fetch(`${base}/connections/callback?code=x&state=y`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>buddi</title>');
    expect(page.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${base}/api/connections`)).status).toBe(401);
  });

  it('connects, signs in, reviews, grants and disconnects', async () => {
    const owner = await signIn();
    const other = await signIn();

    const listed = await call(owner, 'GET', '');
    expect(listed.status).toBe(200);
    expect(listed.body.catalog.map((c: { id: string }) => c.id)).toContain('github');
    expect(listed.body.agents.map((a: { id: string; frontDesk: boolean }) => [a.id, a.frontDesk])).toEqual([['concierge', true], ['helper', false]]);

    expect((await call(owner, 'POST', '', { url: 'npx -y some-server' })).body.error).toMatch(/remote servers over https/);
    const added = await call(owner, 'POST', '', { url: MCP_URL, name: 'Tracker' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ signIn: 'dynamic', connection: { state: 'pending-review', signedIn: false } });
    const id = added.body.connection.id as string;

    const consent = await call(owner, 'POST', `/${id}/consent`, {});
    expect(consent.status).toBe(200);
    expect(consent.body.redirectUri).toBe(`${base}/connections/callback`);
    const state = new URL(consent.body.authorizeUrl).searchParams.get('state')!;

    // Another dashboard session cannot land it; and the state is spent.
    expect((await call(other, 'POST', '/callback', { state, code: 'good-code' })).status).toBe(403);
    expect((await call(owner, 'POST', '/callback', { state, code: 'good-code' })).status).toBe(400);

    const again = await call(owner, 'POST', `/${id}/consent`, {});
    const state2 = new URL(again.body.authorizeUrl).searchParams.get('state')!;
    const landed = await call(owner, 'POST', '/callback', { state: state2, code: 'good-code' });
    expect(landed).toMatchObject({ status: 200, body: { id, reconnected: false } });
    expect(await vault.get(vaultRefFor(id))).not.toBeNull();

    const review = await call(owner, 'GET', `/${id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.tools.map((t: { fullName: string; tier: string }) => `${t.fullName}:${t.tier}`)).toEqual([
      'mcp.tracker.search_issues:auto', 'mcp.tracker.create_issue:gated', 'mcp.tracker.delete_repo:gated',
    ]);
    expect((await call(owner, 'POST', `/${id}/grant`, { agents: ['concierge'] })).status).toBe(409);
    const kept = await call(owner, 'POST', `/${id}/review`, { slug: review.body.slug, hash: review.body.hash });
    expect(kept).toMatchObject({ status: 200, body: { state: 'connected', grant: 'mcp.tracker.*', toolCount: 3 } });

    const granted = await call(owner, 'POST', `/${id}/grant`, { agents: ['concierge'] });
    expect(granted).toMatchObject({ status: 200, body: { granted: ['concierge'], failed: [] } });
    expect(agentFile('concierge')).toMatch(/tools: \[.*mcp\.tracker\.\*.*\]/);
    expect(agentFile('helper')).not.toContain('mcp.tracker');
    expect((await call(owner, 'GET', `/${id}`)).body.agents).toEqual(['concierge']);

    const gone = await call(owner, 'DELETE', `/${id}`);
    expect(gone).toMatchObject({ status: 200, body: { touched: ['concierge'] } });
    expect(agentFile('concierge')).not.toContain('mcp.tracker');
    expect(await vault.get(vaultRefFor(id))).toBeNull();
    expect((await call(owner, 'GET', '')).body.connections).toEqual([]);
  });
});
