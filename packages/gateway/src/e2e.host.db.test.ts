import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, runMigrations, ToolRegistry, decideApproval, executeApproved,
  listToolPermissions, revokeToolPermission, saveArtifact, getAction, readArtifactBytes, getArtifact,
  type ToolContext } from '@buddi/core';
import { ensureOwner, completeOnboarding, pairSurfaceIdentity } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { createHostManifest, hostService, type HostService, execInput } from '@buddi/tool-host';
import { startWebServer } from './web/server.js';
import { mintTicket } from './web/token.js';
import { readChatTranscript } from './web/chat.js';
import { loadGatewayCatalog } from './agents/catalog.js';
import { TelegramApprovals, approvalKeyboard, parseApprovalCallback } from './telegram/approvals.js';
import type { Pool } from 'pg';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_host_e2e_${process.pid}`;
suite('host execution permissions and file workflow', () => {
  let admin: Pool, pool: Pool, dir: string, service: HostService, registry: ToolRegistry, ctx: ToolContext;
  beforeAll(async () => {
    admin = createPool(databaseUrl!);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    pool = createPool(url.toString()); await runMigrations(pool, []);
    await ensureOwner(pool, 'owner'); await completeOnboarding(pool, 'fixture');
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-host-e2e-'));
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`drop database if exists ${name}`); await admin.end(); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await pool.query('truncate core.tool_permissions, core.actions cascade');
    service = hostService({ ...process.env, BUDDI_DATA_DIR: dir });
    registry = new ToolRegistry(); registry.register(createHostManifest(service));
    const { rows } = await pool.query("insert into core.conversations (agent_id) values ('ledger') returning id");
    ctx = { db: pool, ownerId: 'owner', agentId: 'ledger', conversationId: rows[0].id, now: () => new Date(), timezone: 'UTC' };
  });
  async function propose(command = 'printf worked', extra = {}) {
    const result = await registry.invoke('host.exec', { command, ...extra }, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'approval-required' });
    if (result.ok || result.reason !== 'approval-required') throw new Error('Expected approval');
    return result.actionId;
  }
  async function approve(id: string, permissionScope: 'once' | 'conversation' | 'always' = 'once') {
    return decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'web', permissionScope, registry });
  }
  const execute = (actionId: string) => executeApproved(pool, { actionId, registry, ctx, worker: 'test' });

  it('does not run before approval; once stays once; duplicate execution is refused', async () => {
    const id = await propose();
    expect(await execute(id)).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(await approve(id)).toMatchObject({ ok: true });
    expect(await execute(id)).toMatchObject({ ok: true, result: { stdout: 'worked', exitCode: 0 } });
    expect(await execute(id)).toMatchObject({ ok: false });
    expect(await listToolPermissions(pool, 'owner')).toEqual([]);
    await propose();
  });
  it('auto-mode is scoped by owner, agent, conversation and version; revoke restores prompts', async () => {
    const id = await propose(); await approve(id, 'conversation'); await execute(id);
    expect(await registry.invoke('host.exec', { command: 'printf auto' }, ctx)).toMatchObject({ ok: true, output: { stdout: 'auto' } });
    const other = (await pool.query("insert into core.conversations (agent_id) values ('ledger') returning id")).rows[0].id;
    for (const changed of [{ ownerId: 'stranger' }, { agentId: 'other' }, { conversationId: other }]) {
      expect(await registry.invoke('host.exec', { command: 'true' }, { ...ctx, ...changed })).toMatchObject({ reason: 'approval-required' });
    }
    const upgraded = new ToolRegistry(); upgraded.register({ ...createHostManifest(service), version: '0.2.0' });
    expect(await upgraded.invoke('host.exec', { command: 'true' }, ctx)).toMatchObject({ reason: 'approval-required' });
    const permission = (await listToolPermissions(pool, 'owner'))[0]!;
    expect(await revokeToolPermission(pool, 'stranger', permission.id)).toBe(false);
    expect(await revokeToolPermission(pool, 'owner', permission.id)).toBe(true);
    await propose();
  });
  it('always covers future conversations, never delegates or a different agent', async () => {
    const id = await propose(); await approve(id, 'always'); await execute(id);
    const other = (await pool.query("insert into core.conversations (agent_id) values ('ledger') returning id")).rows[0].id;
    expect(await registry.invoke('host.exec', { command: 'true' }, { ...ctx, conversationId: other })).toMatchObject({ ok: true });
    expect(await registry.invoke('host.exec', { command: 'true' }, { ...ctx, delegationDepth: 1 })).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(await registry.invoke('host.exec', { command: 'true' }, { ...ctx, agentId: 'other' })).toMatchObject({ reason: 'approval-required' });
  });
  it('rejected, expired and repeated decisions cannot create or widen grants', async () => {
    const rejected = await propose();
    await decideApproval(pool, { actionId: rejected, decision: 'rejected', by: 'owner', via: 'web' });
    expect(await approve(rejected, 'always')).toMatchObject({ ok: false });
    const expired = await propose();
    await pool.query("update core.actions set expires_at=now()-interval '1 hour' where id=$1", [expired]);
    expect(await approve(expired, 'always')).toMatchObject({ ok: false });
    const once = await propose(); await approve(once);
    expect(await approve(once, 'always')).toMatchObject({ ok: false });
    expect(await listToolPermissions(pool, 'owner')).toEqual([]);
  });
  it('requires tools to explicitly support remembered permissions', async () => {
    const id = await propose();
    const untrustedRegistry = new ToolRegistry();
    const manifest = createHostManifest(service);
    untrustedRegistry.register({ ...manifest, tools: manifest.tools.map(t => ({ ...t, reusableApproval: false })) });
    expect(await decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'web', permissionScope: 'always', registry: untrustedRegistry })).toMatchObject({ reason: 'invalid-permission' });
  });
  it('copies CSV bytes, computes using Python, and publishes an artifact without changing the original', async () => {
    const bytes = Buffer.from('label,amount\none,12\ntwo,30\n');
    const artifact = await saveArtifact(pool, { bytes, mime: 'text/csv', filename: 'input.csv', createdBy: 'owner' }, service.env);
    const command = `python3 - <<'PY'\nimport csv\nwith open('inputs/${artifact.id}/input.csv') as f:\n    total = sum(int(row['amount']) for row in csv.DictReader(f))\nwith open('summary.csv', 'w') as f:\n    f.write('total\\n' + str(total) + '\\n')\nprint(total)\nPY`;
    const id = await propose(command, { attachments: [artifact.id], outputs: ['summary.csv'] });
    await approve(id, 'conversation');
    const result = await execute(id);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { exitCode: 0, stdout: '42\n', outputErrors: [] } });
    if (!result.ok) throw new Error('Execution failed');
    const output = result.result as { artifacts: { id: string }[] };
    const saved = await getArtifact(pool, output.artifacts[0]!.id);
    expect((await readArtifactBytes(service.env, saved!)).toString()).toBe('total\n42\n');
    expect(await readArtifactBytes(service.env, artifact)).toEqual(bytes);
  });
  it('binds attachment hashes and refuses edited files before executing', async () => {
    const artifact = await saveArtifact(pool, { bytes: Buffer.from('original'), mime: 'text/plain', filename: 'input.txt', createdBy: 'owner' }, service.env);
    const id = await propose('printf should-not-run', { attachments: [artifact.id] }); await approve(id);
    await writeFile(path.join(dir, artifact.storagePath), 'changed');
    expect(await execute(id)).toMatchObject({ ok: false, reason: 'effect-changed' });
  });
  it('refuses output traversal and exports through escaping symlinks', async () => {
    await expect(service.describe(execInput.parse({ command: 'true', outputs: ['../outside'] }), ctx)).rejects.toThrow('inside');
    const id = await propose('ln -s /etc/hosts outside.txt', { outputs: ['outside.txt'] }); await approve(id);
    const result = await execute(id);
    expect(result).toMatchObject({ ok: true, result: { artifacts: [], outputErrors: [expect.stringContaining('symlinks')] } });
  });
  it('stops a running command and releases its conversation lock', async () => {
    const id = await propose('sleep 30'); await approve(id);
    const pending = execute(id);
    for (let i = 0; !service.runs('owner').length && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    expect(service.stop('stranger')).toBe(0);
    expect(service.stop('owner', ctx.agentId, ctx.conversationId)).toBe(1);
    const result = await pending;
    expect(result.ok ? (result.result as { state: string }).state === 'cancelled' : result.reason === 'tool-error').toBe(true);
    expect(service.runs('owner')).toEqual([]);
    expect(await getAction(pool, id)).toBeTruthy();
  });
  it('dashboard authentication, scopes, download, revoke and continuation use the same executor', async () => {
    const agents = await mkdtemp(path.join(dir, 'agents-'));
    await mkdir(path.join(agents, 'ledger'));
    await writeFile(path.join(agents, 'ledger', 'agent.md'), '---\nid: ledger\nhandle: ledger\nname: Ledger\ndescription: Host fixture\ndefault: true\nprovider: anthropic\nmodel: claude-sonnet-5\ntools: [host.*]\nmaxTurns: 4\n---\nComplete the owner task.\n');
    service.env.ANTHROPIC_API_KEY = 'fixture-unused';
    const catalog = loadGatewayCatalog({ dir: agents, registry, env: service.env });
    let calls = 0;
    const complete = vi.fn(async () => (++calls === 1
      ? { content: [{ type: 'tool_use' as const, id: 'h1', name: 'host.exec', input: { command: 'printf 42' } }], stopReason: 'tool_use' as const }
      : { content: [{ type: 'text' as const, text: 'Continued after approval.' }], stopReason: 'end_turn' as const }));
    const app = await startWebServer({ pool, registry, catalog, ctx, timezone: 'UTC', now: () => new Date(),
      env: service.env, token: 'host-fixture-token', openAccess: false,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      chat: { providerFor: () => ({ complete: async () => ({ ...await complete(), usage: { input: 1, output: 1 }, model: 'fixture' }) }) } });
    const origin = `http://127.0.0.1:${app.port}`;
    try {
      expect((await fetch(`${origin}/api/host`)).status).toBe(401);
      const ticket = mintTicket('host-fixture-token', new Date());
      const login = await fetch(`${origin}/?t=${ticket}`, { redirect: 'manual' });
      const cookies = login.headers.getSetCookie().map(c => c.split(';')[0]!);
      const headers = { Cookie: cookies.join('; '), Origin: origin, 'Content-Type': 'application/json',
        'X-Buddi-CSRF': cookies.find(c => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length) };
      // Stale polling tabs cannot deny service to a valid session or recovery
      // ticket sharing the proxy's IP. Invalid authentication stays limited.
      for (let i = 0; i < 10; i++) await fetch(`${origin}/api/host`);
      expect((await fetch(`${origin}/api/host`)).status).toBe(429);
      expect((await fetch(`${origin}/?t=invalid`, { redirect: 'manual' })).status).toBe(429);
      expect((await fetch(`${origin}/api/host`, { headers })).status).toBe(200);
      const recoveryTicket = mintTicket('host-fixture-token', new Date());
      expect((await fetch(`${origin}/?t=${recoveryTicket}`, { redirect: 'manual' })).status).toBe(302);
      const sent = await app.chat!.send({ agentId: 'ledger', text: 'Calculate 42 with the shell.' });
      expect(sent.ok).toBe(true); await app.chat!.drain();
      const action = (await pool.query("select id from core.actions where tool='host.exec' order by created_at desc limit 1")).rows[0];
      const actionRow = await getAction(pool, action.id);
      const transcript = await readChatTranscript(pool, actionRow!.conversationId!);
      expect(transcript!.messages.flatMap(m => m.blocks)).toContainEqual(expect.objectContaining({
        type: 'tool_result', toolUseId: 'h1', approval: { id: action.id, state: 'pending' },
      }));
      const url = `${origin}/api/approvals/${action.id}/approve`;
      expect((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{"permissionScope":"always"}' })).status).toBe(403);
      expect((await fetch(url, { method: 'POST', headers, body: '{"permissionScope":"invalid"}' })).status).toBe(400);
      expect((await fetch(url, { method: 'POST', headers, body: '{"permissionScope":"conversation"}' })).status).toBe(200);
      await app.chat!.drain();
      const resolved = await readChatTranscript(pool, actionRow!.conversationId!);
      expect(resolved!.messages.flatMap(m => m.blocks)).toContainEqual(expect.objectContaining({
        type: 'tool_result', toolUseId: 'h1', approval: { id: action.id, state: 'succeeded' },
        output: expect.objectContaining({ stdout: '42' }),
      }));
      expect(complete).toHaveBeenCalledTimes(2);
      const state = await (await fetch(`${origin}/api/host`, { headers })).json() as { permissions: { id: string }[] };
      expect(state.permissions).toHaveLength(1);
      expect((await fetch(`${origin}/api/host/revoke`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ id: state.permissions[0]!.id }) })).status).toBe(403);
      expect((await fetch(`${origin}/api/host/revoke`, { method: 'POST', headers, body: JSON.stringify({ id: state.permissions[0]!.id }) })).status).toBe(200);
      expect(await listToolPermissions(pool, 'owner')).toEqual([]);
      const file = await saveArtifact(pool, { bytes: Buffer.from('fixture-download'), filename: 'result.txt', mime: 'text/plain', createdBy: 'ledger' }, service.env);
      const download = `${origin}/api/artifacts/${file.id}/download`;
      expect((await fetch(download)).status).toBe(401);
      const response = await fetch(download, { headers });
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(await response.text()).toBe('fixture-download');
      expect((await fetch(`${origin}/api/artifacts/${file.id}/preview`, { headers })).status).toBe(415);
      const png = await saveArtifact(pool, { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=', 'base64'), filename: 'preview.png', mime: 'image/png', createdBy: 'ledger' }, service.env);
      const previewUrl = `${origin}/api/artifacts/${png.id}/preview`;
      expect((await fetch(previewUrl)).status).toBe(401);
      const preview = await fetch(previewUrl, { headers });
      expect(preview.status).toBe(200);
      expect(preview.headers.get('content-type')).toBe('image/png');
      expect(preview.headers.get('content-disposition')).toContain('inline');
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(await readArtifactBytes(service.env, png));
      const svg = await saveArtifact(pool, { bytes: Buffer.from('<svg/>'), filename: 'unsafe.svg', mime: 'image/svg+xml', createdBy: 'ledger' }, service.env);
      expect((await fetch(`${origin}/api/artifacts/${svg.id}/preview`, { headers })).status).toBe(415);
    } finally { await app.close(); }
  });
  it('Telegram scopes authenticate the owner and resume the completed command', async () => {
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: '4242', externalChatId: '4242', pairedVia: 'env' });
    const id = await propose();
    const api = { sendMessage: vi.fn(async () => 1), editMessageText: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}) };
    const resumeInteractive = vi.fn(async () => {});
    const approvals = new TelegramApprovals({ api, pool, registry, ctx, timezone: 'UTC', resumeInteractive });
    const keyboard = approvalKeyboard(id, true);
    expect(keyboard.inline_keyboard.flat()).toHaveLength(4);
    const data = keyboard.inline_keyboard[1]![0]!.callback_data;
    expect(parseApprovalCallback(data)).toMatchObject({ permissionScope: 'conversation' });
    const callback = { id: 'c1', data, from: { id: 8888, first_name: 'Stranger' }, message: { message_id: 1, date: 0, chat: { id: 8888, type: 'private' as const } } };
    await approvals.handleCallback(callback);
    expect(await listToolPermissions(pool, 'owner')).toEqual([]);
    await approvals.handleCallback({ ...callback, from: { id: 4242, first_name: 'Owner' }, message: { ...callback.message, chat: { id: 4242, type: 'private' } } });
    expect((await listToolPermissions(pool, 'owner'))[0]?.conversationId).toBe(ctx.conversationId);
    expect(resumeInteractive).toHaveBeenCalledOnce();
    expect(resumeInteractive.mock.calls[0]).toMatchObject(['4242', { id }, { state: 'succeeded', result: { stdout: 'worked' } }]);
  });
});
