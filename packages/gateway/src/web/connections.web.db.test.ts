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
import { registerHttpHeaderDestination, secretDestination } from '@buddi/core';
import { connectionSecrets } from '../owner-secrets.js';
import { createOAuthPort } from '@buddi/runtime';
import { bindConnections, manifest as connectionsManifest, vaultRefFor } from '@buddi/tool-mcp';
import { AS_ORIGIN, Fake, MCP_URL } from '@buddi/tool-mcp/testing';
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

    const env = {} as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
    const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: path.join(dir, 'agents'), env, registry }));
    registry.onChange(() => catalog.reload());
    bindPlatformTools(registry, { catalog, reload: () => catalog.reload(), agentsDir: path.join(dir, 'agents') });
    if (!secretDestination('http.header')) registerHttpHeaderDestination();
    const connections = bindConnections(registry.manifests(), { pool, vault, secrets: connectionSecrets(pool, vault), transport: fake.transport, oauth: createOAuthPort({ transport: fake.transport }), log: () => {},
      catalog: [{ id: 'tracker', name: 'Tracker', blurb: '', url: MCP_URL, verified: true, auth: { recommended: 'device', device: { clientId: 'buddi-app', deviceEndpoint: `${AS_ORIGIN}/device/code`, scopes: ['read'] } } }],
      sleep: () => new Promise((resolve) => setImmediate(resolve)) });
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
    const html = await page.text();
    expect(html).toContain('<title>buddi</title>');
    // The build's assets are relative; on this nested path they need the root.
    expect(html).toContain('<base href="/" />');
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

    // A consent `buddi connections add` started is owned by the CLI: it lands
    // in whichever owner session the callback page opens in, and only once.
    const cli = await call(owner, 'POST', `/${id}/consent`, { cli: true });
    const cliState = new URL(cli.body.authorizeUrl).searchParams.get('state')!;
    expect(await call(other, 'POST', '/callback', { state: cliState, code: 'good-code' })).toMatchObject({ status: 200, body: { id, cli: true } });
    expect((await call(owner, 'POST', '/callback', { state: cliState, code: 'good-code' })).status).toBe(400);

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
    expect((await call(owner, 'GET', '/signals')).body).toEqual({ signals: [] });

    // Remembered approval, per agent: a gated tool may be; a destructive one says why not.
    const tools = await call(owner, 'GET', `/${id}/tools`);
    expect(tools.body.tools.map((t: { tool: string; tier: string; rememberable: boolean }) => [t.tool, t.tier, t.rememberable])).toEqual([
      ['mcp.tracker.search_issues', 'auto', false], ['mcp.tracker.create_issue', 'gated', true], ['mcp.tracker.delete_repo', 'gated', false],
    ]);
    const before = await call(owner, 'GET', '/remembered/concierge');
    expect(before.body.tools.map((t: { tool: string; remembered: boolean; why: string | null }) => [t.tool, t.remembered, t.why !== null])).toEqual([
      ['mcp.tracker.create_issue', false, false], ['mcp.tracker.delete_repo', false, true],
    ]);
    expect(await call(owner, 'POST', '/remembered', { agent: 'concierge', tool: 'mcp.tracker.create_issue', remember: true })).toMatchObject({ status: 200, body: { remembered: true } });
    expect((await call(owner, 'GET', '/remembered/concierge')).body.tools[0]).toMatchObject({ tool: 'mcp.tracker.create_issue', remembered: true });
    const { rows } = await pool.query(`select agent_id, tool, tool_version, conversation_id from core.tool_permissions`);
    expect(rows).toEqual([{ agent_id: 'concierge', tool: 'mcp.tracker.create_issue', tool_version: '0.1.0', conversation_id: '' }]);
    expect(await call(owner, 'POST', '/remembered', { agent: 'concierge', tool: 'mcp.tracker.delete_repo', remember: true })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/never remembered/) } });
    expect((await call(owner, 'POST', '/remembered', { agent: 'helper', tool: 'mcp.tracker.create_issue', remember: true })).status).toBe(409);
    expect((await call(owner, 'POST', '/remembered', { agent: 'concierge', tool: 'mcp.tracker.search_issues', remember: true })).status).toBe(404);
    expect(await call(owner, 'POST', '/remembered', { agent: 'concierge', tool: 'mcp.tracker.create_issue', remember: false })).toMatchObject({ status: 200 });
    expect((await pool.query(`select count(*)::int as n from core.tool_permissions`)).rows[0].n).toBe(0);

    const gone = await call(owner, 'DELETE', `/${id}`);
    expect(gone).toMatchObject({ status: 200, body: { touched: ['concierge'] } });
    expect(agentFile('concierge')).not.toContain('mcp.tracker');
    expect(await vault.get(vaultRefFor(id))).toBeNull();
    expect((await call(owner, 'GET', '')).body.connections).toEqual([]);
  });

  it('signs in with a pasted token: refused ones are not kept, a kept one is an owner secret bound to the host', async () => {
    const owner = await signIn();
    const added = await call(owner, 'POST', '', { url: MCP_URL, name: 'Tracker' });
    const id = added.body.connection.id as string;

    expect((await call(owner, 'POST', `/${id}/token`, {})).status).toBe(400);
    const refused = await call(owner, 'POST', `/${id}/token`, { token: 'not-it' });
    expect(refused).toMatchObject({ status: 400, body: { error: 'Tracker did not accept that token.', code: 'token-refused' } });
    expect((await pool.query(`select count(*)::int as n from core.secrets`)).rows[0].n).toBe(0);

    const kept = await call(owner, 'POST', `/${id}/token`, { token: fake.validToken, prefix: 'Bearer ' });
    expect(kept).toMatchObject({ status: 200, body: { id, reconnected: false, connection: { authKind: 'token', signedIn: true } } });
    expect(JSON.stringify(kept.body)).not.toContain(fake.validToken);
    const secrets = await pool.query(`select s.name, b.kind, b.target, b.rule from core.secrets s join core.secret_bindings b on b.secret_id = s.id`);
    expect(secrets.rows).toEqual([{ name: `MCP_TOKEN_${id.replace(/-/g, '')}`, kind: 'http.header', target: { host: 'mcp.example.test', header: 'Authorization' }, rule: 'pre-approved' }]);

    const review = await call(owner, 'GET', `/${id}/review`);
    expect(review.status).toBe(200);
    const uses = await pool.query(`select kind, outcome from core.secret_uses order by at`);
    expect(uses.rows.at(-1)).toEqual({ kind: 'http.header', outcome: 'delivered' });
    expect(fake.calls.filter((c) => c.url === MCP_URL).at(-1)!.headers.authorization).toBe(`Bearer ${fake.validToken}`);

    expect((await call(owner, 'DELETE', `/${id}`)).status).toBe(200);
    expect((await pool.query(`select count(*)::int as n from core.secrets`)).rows[0].n).toBe(0);
  });

  it('signs in with a device code: the code and the address, then the view says done', async () => {
    const owner = await signIn();
    const added = await call(owner, 'POST', '', { url: MCP_URL, name: 'Tracker' });
    const id = added.body.connection.id as string;
    fake.deviceScript = ['pending', 'approve'];
    expect((await call(owner, 'GET', `/${id}/device`)).status).toBe(405);
    const started = await call(owner, 'POST', `/${id}/device`, {});
    expect(started).toMatchObject({ status: 200, body: { userCode: 'WDJB-MJHT', verificationUri: `${AS_ORIGIN}/device`, interval: 5 } });
    let view: any;
    for (let i = 0; i < 200; i++) {
      view = (await call(owner, 'GET', `/${id}`)).body;
      if (view.device?.state !== 'waiting') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(view).toMatchObject({ authKind: 'token', signedIn: true, device: { state: 'done', userCode: 'WDJB-MJHT' } });
    expect(JSON.stringify(view)).not.toContain(fake.validToken);
    expect((await call(owner, 'DELETE', `/${id}`)).status).toBe(200);
  });
});
