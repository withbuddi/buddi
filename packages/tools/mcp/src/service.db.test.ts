/**
 * Connections end to end against Postgres and an in-process MCP server and
 * authorization server (docs/connections.md). Skipped without DATABASE_URL;
 * creates and drops its own database. No socket leaves the process.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOAuthPort } from '@buddi/runtime';
import {
  compileJsonSchema,
  createMemoryVault,
  createPool,
  decideApproval,
  executeApproved,
  runMigrations,
  testDatabaseUrl,
  ToolRegistry,
  type CoreToolContext,
  type Vault,
} from '@buddi/core/testing';
import { bindConnections, createConnectionsManifest } from './index.js';
import { ConnectionError, type ConnectionsService } from './service.js';
import { SERVICE_OPEN } from './output.js';
import { Fake, MCP_URL } from './testing/fake.js';
import { vaultRefFor } from './tokens.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_mcp_connections_test_${process.pid}`;
const REDIRECT = 'http://127.0.0.1:4317/connections/callback';

suite('connections (postgres + fake MCP server)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [createConnectionsManifest()]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate mcp.tools, mcp.connections cascade');
  });

  function setup(fake: Fake, vault: Vault = createMemoryVault()): { registry: ToolRegistry; service: ConnectionsService; vault: Vault } {
    const registry = new ToolRegistry();
    registry.register(createConnectionsManifest());
    const service = bindConnections(registry.manifests(), {
      pool, vault, transport: fake.transport, oauth: createOAuthPort({ transport: fake.transport }),
      compileSchema: (schema) => compileJsonSchema(schema).dispose(), log: () => {},
    })!;
    return { registry, service, vault };
  }

  const ctx = (): CoreToolContext => ({ db: pool, ownerId: 'owner', agentId: 'concierge', now: () => new Date(), timezone: 'UTC' });

  async function signIn(service: ConnectionsService, id: string, session = 's1'): Promise<void> {
    const { authorizeUrl } = await service.beginConsent(id, { sessionId: session, redirectUri: REDIRECT });
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    await service.finishConsent({ sessionId: session, state, code: 'good-code' });
  }

  it('connects a server that wants no sign-in: address, review, registered tools, calls', async () => {
    const fake = new Fake({ json: true });
    const { registry, service } = setup(fake);
    const added = await service.add({ url: MCP_URL });
    expect(added.signIn).toBe('none');
    expect(added.connection).toMatchObject({ name: 'Fake Tracker', host: 'mcp.example.test', state: 'pending-review', signedIn: true });
    // Nothing registered before the review is saved.
    expect(registry.list()).toEqual([]);

    const review = await service.review(added.connection.id);
    expect(review.slug).toBe('fake_tracker');
    expect(review.tools.map((t) => [t.fullName, t.tier, t.destructive])).toEqual([
      ['mcp.fake_tracker.search_issues', 'auto', false],
      ['mcp.fake_tracker.create_issue', 'gated', false],
      ['mcp.fake_tracker.delete_repo', 'gated', true],
    ]);
    expect(review.annotatedNothing).toBe(false);

    await expect(service.saveReview(added.connection.id, { slug: 'tracker', hash: 'stale' })).rejects.toMatchObject({ status: 409, code: 'changed' });
    await expect(service.saveReview(added.connection.id, { slug: 'Bad Slug', hash: review.hash })).rejects.toMatchObject({ status: 400 });
    const saved = await service.saveReview(added.connection.id, { slug: 'tracker', hash: review.hash });
    expect(saved).toMatchObject({ state: 'connected', slug: 'tracker', toolCount: 3, grant: 'mcp.tracker.*' });
    expect(registry.list().map((t) => t.name)).toEqual(['mcp.tracker.search_issues', 'mcp.tracker.create_issue', 'mcp.tracker.delete_repo']);
    expect(registry.untrustedKind('mcp.tracker.search_issues')).toBe('mcp');

    // An auto tool runs; its answer is fenced, its image goes to the hook.
    const result = await registry.invoke('mcp.tracker.search_issues', { q: 'bug' }, ctx());
    expect(result.ok).toBe(true);
    const output = (result as { output: { text: string; links: unknown; image: { ref: string } } }).output;
    expect(output.text.startsWith(SERVICE_OPEN)).toBe(true);
    expect(output.text).toContain('found for bug');
    expect(output.links).toEqual([{ url: 'https://tracker.example.test/1', name: 'Issue 1' }]);
    const image = await registry.image('mcp.tracker.search_issues', output, ctx());
    expect(image).toEqual({ mime: 'image/png', data: Buffer.from('png').toString('base64') });

    // A gated tool asks first, with the server, the tool and the arguments; approved, it runs.
    const gated = await registry.invoke('mcp.tracker.create_issue', { title: 'Hi' }, ctx());
    expect(gated).toMatchObject({ ok: false, reason: 'approval-required' });
    const actionId = (gated as { actionId: string }).actionId;
    const { rows } = await pool.query('select envelope, preview from core.actions where id = $1', [actionId]);
    expect(rows[0].envelope).toEqual({ service: 'Fake Tracker', host: 'mcp.example.test', connection: 'tracker', tool: 'create_issue', arguments: { title: 'Hi' } });
    expect(rows[0].preview).toContain('create_issue on Fake Tracker (mcp.example.test)');
    await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'test', now: new Date() });
    const executed = await executeApproved(pool, { actionId, registry, ctx: ctx(), worker: 'test', now: new Date() });
    expect(executed).toMatchObject({ ok: true });
    expect(JSON.stringify((executed as { result: unknown }).result)).toContain('created Hi');
    expect(registry.lookup('mcp.tracker.delete_repo')!.reusableApproval).toBeUndefined();
    expect(registry.lookup('mcp.tracker.create_issue')!.reusableApproval).toBe(true);
    await service.close();
  });

  it('signs in: discovery, dynamic registration, PKCE and a state bound to the session, used once', async () => {
    const fake = new Fake({ auth: true, json: true });
    const { registry, service, vault } = setup(fake);
    const added = await service.add({ url: MCP_URL, name: 'Tracker' });
    expect(added).toMatchObject({ signIn: 'dynamic', connection: { authKind: 'oauth', signedIn: false, name: 'Tracker' } });
    await expect(service.review(added.connection.id)).rejects.toMatchObject({ status: 409 });

    const { authorizeUrl } = await service.beginConsent(added.connection.id, { sessionId: 's1', redirectUri: REDIRECT });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://auth.example.test/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(MCP_URL);
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(fake.registered[0]).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    const state = url.searchParams.get('state')!;

    // Another dashboard session cannot finish it, and a used state is gone.
    await expect(service.finishConsent({ sessionId: 's2', state, code: 'good-code' })).rejects.toMatchObject({ status: 403 });
    await expect(service.finishConsent({ sessionId: 's1', state, code: 'good-code' })).rejects.toMatchObject({ status: 400 });

    await signIn(service, added.connection.id);
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'good-code', redirect_uri: REDIRECT, resource: MCP_URL });
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = JSON.parse((await vault.get(vaultRefFor(added.connection.id)))!);
    expect(stored).toMatchObject({ version: 1, state: 'ready', accessToken: fake.validToken, clientId: 'client-2', resource: MCP_URL });
    const { rows } = await pool.query('select * from mcp.connections');
    expect(JSON.stringify(rows)).not.toContain(fake.validToken);

    const review = await service.review(added.connection.id);
    await service.saveReview(added.connection.id, { slug: 'tracker', hash: review.hash });
    // The token went in the header, from the vault.
    expect(fake.calls.filter((c) => c.url === MCP_URL).at(-1)!.headers.authorization).toBe(`Bearer ${fake.validToken}`);
    expect(await registry.invoke('mcp.tracker.search_issues', { q: 'x' }, ctx())).toMatchObject({ ok: true });
    await service.close();
  });

  it('refreshes an expiring token under the discipline, and needs a reconnect when refused; reconnect keeps the tools', async () => {
    const fake = new Fake({ auth: true, json: true, refresh: true, expiresIn: 60 });
    const { registry, service, vault } = setup(fake);
    const { connection } = await service.add({ url: MCP_URL });
    await signIn(service, connection.id);
    const review = await service.review(connection.id);
    expect(fake.tokenRequests.at(-1)!.grant_type).toBe('refresh_token');
    await service.saveReview(connection.id, { slug: 'tracker', hash: review.hash });

    // The service revokes the sign-in: every tool answers one sentence.
    fake.validToken = 'revoked';
    fake.refuseRefresh = true;
    await service.sessions.closeAll();
    const refused = await registry.invoke('mcp.tracker.search_issues', { q: 'x' }, ctx());
    expect(refused).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((refused as { message: string }).message).toMatch(/needs to be reconnected/);
    expect((await service.get(connection.id)).state).toBe('needs-reconnect');
    const calls = fake.calls.length;
    expect(await registry.invoke('mcp.tracker.create_issue', { title: 'x' }, ctx())).toMatchObject({ reason: 'tool-error' });
    expect(fake.calls.length).toBe(calls);

    // Reconnect: consent again, tools kept.
    fake.refuseRefresh = false;
    await signIn(service, connection.id);
    expect((await service.get(connection.id)).state).toBe('connected');
    expect(registry.has('mcp.tracker.search_issues')).toBe(true);
    expect(await registry.invoke('mcp.tracker.search_issues', { q: 'x' }, ctx())).toMatchObject({ ok: true });
    expect(await vault.get(vaultRefFor(connection.id))).not.toBeNull();
    await service.close();
  });

  it('asks for a client id when the server offers no registration', async () => {
    const fake = new Fake({ auth: true, json: true, registration: false });
    const { service } = setup(fake);
    const added = await service.add({ url: MCP_URL });
    expect(added.signIn).toBe('manual');
    const refusal = await service.beginConsent(added.connection.id, { sessionId: 's1', redirectUri: REDIRECT }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConnectionError);
    expect(refusal).toMatchObject({ status: 409, code: 'client-id' });
    const { authorizeUrl } = await service.beginConsent(added.connection.id, { sessionId: 's1', redirectUri: REDIRECT, clientId: 'my-app' });
    expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe('my-app');
  });

  it('registers reviewed connections at boot, and disconnect takes tokens, tools and rows', async () => {
    const fake = new Fake({ auth: true, json: true });
    const first = setup(fake);
    const { connection } = await first.service.add({ url: MCP_URL });
    await signIn(first.service, connection.id);
    const review = await first.service.review(connection.id);
    await first.service.saveReview(connection.id, { slug: 'tracker', hash: review.hash });
    await first.service.close();

    // A new process: same database and vault, a fresh registry.
    const second = setup(fake, first.vault);
    expect(second.registry.list()).toEqual([]);
    await second.service.boot();
    expect(second.registry.list().map((t) => t.name)).toEqual(['mcp.tracker.create_issue', 'mcp.tracker.delete_repo', 'mcp.tracker.search_issues']);

    await second.service.disconnect(connection.id);
    expect(second.registry.list()).toEqual([]);
    expect(await first.vault.get(vaultRefFor(connection.id))).toBeNull();
    expect((await pool.query('select count(*)::int as n from mcp.tools')).rows[0].n).toBe(0);
    await expect(second.service.get(connection.id)).rejects.toMatchObject({ status: 404 });
  });

  it('says so when a server annotates nothing, and keeps a slug unique', async () => {
    const fake = new Fake({ json: true, tools: [{ name: 'do', inputSchema: { type: 'object' } }] });
    const { service } = setup(fake);
    const a = await service.add({ url: MCP_URL });
    const review = await service.review(a.connection.id);
    expect(review.annotatedNothing).toBe(true);
    expect(review.tools[0]).toMatchObject({ tier: 'gated', annotated: false });
    await service.saveReview(a.connection.id, { slug: 'svc', hash: review.hash });
    const b = await service.add({ url: MCP_URL });
    expect((await service.review(b.connection.id)).slug).toBe('fake_tracker');
    await expect(service.saveReview(b.connection.id, { slug: 'svc', hash: review.hash })).rejects.toMatchObject({ status: 409 });
    await service.close();
  });
});
