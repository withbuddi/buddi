/**
 * A program on this computer, end to end against Postgres and a real stdio
 * MCP server (fixtures/stdio-server.mjs): recorded without starting, started
 * for the review, its tools registered and called, a secret variable reaching
 * it from the vault, stopped when idle, stderr on the row when it fails, and
 * another review when its command changes. Skipped without DATABASE_URL.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileJsonSchema, createPool, runMigrations, testDatabaseUrl, ToolRegistry, type CoreToolContext } from '@buddi/core/testing';
import { bindConnections, createConnectionsManifest } from './index.js';
import type { ConnectionsDeps, ConnectionsService } from './service.js';
import type { EnvTarget, HeaderTarget, OAuthPort, SecretsPort } from './ports.js';
import { groupAlive, liveGroups } from './program.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'stdio-server.mjs');

/** The owner's secrets as the gateway binds them: an env value answers only for its connection and variable. */
class MemorySecrets implements SecretsPort {
  readonly held = new Map<string, { value: string; target: HeaderTarget | EnvTarget }>();
  readonly reads: string[] = [];
  async put(name: string, value: string, target: HeaderTarget): Promise<void> { this.held.set(name, { value, target }); }
  async value(): Promise<string> { throw new Error('no header secrets here'); }
  async remove(name: string): Promise<void> { this.held.delete(name); }
  async putEnv(name: string, value: string, target: EnvTarget): Promise<void> { this.held.set(name, { value, target }); }
  async envValue(name: string, target: EnvTarget): Promise<string> {
    const held = this.held.get(name);
    const bound = held?.target as EnvTarget | undefined;
    if (!held || bound?.connection !== target.connection || bound.variable !== target.variable) throw new Error(`"${name}" is not bound there`);
    this.reads.push(name);
    return held.value;
  }
}

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_mcp_stdio_test_${process.pid}`;
const SECRET = 'tok-7f3a9c';

const textOf = (result: unknown): string => (result as { output: { text: string } }).output.text;

suite('a program on this computer (postgres + a real stdio server)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [createConnectionsManifest()]);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddi-stdio-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query('truncate mcp.tools, mcp.connections cascade');
  });

  function setup(extra: Partial<ConnectionsDeps> = {}): { registry: ToolRegistry; service: ConnectionsService; secrets: MemorySecrets } {
    const registry = new ToolRegistry();
    registry.register(createConnectionsManifest());
    const secrets = new MemorySecrets();
    const refuse = async (): Promise<never> => { throw new Error('a program makes no HTTP request'); };
    const service = bindConnections(registry.manifests(), {
      pool, vault: undefined, secrets, transport: refuse, oauth: {} as OAuthPort, // a program signs in to nothing
      compileSchema: (schema) => compileJsonSchema(schema).dispose(), log: () => {},
      dataDir, env: { PATH: process.env.PATH, HOME: os.homedir() },
      ...extra,
    })!;
    return { registry, service, secrets };
  }

  const ctx = (): CoreToolContext => ({ db: pool, ownerId: 'owner', agentId: 'concierge', now: () => new Date(), timezone: 'UTC' });

  it('is recorded unstarted, reviewed with its command, registered as mcp.<name>.*, and called with its secret', async () => {
    const { registry, service, secrets } = setup();
    const before = liveGroups().length;
    const { connection } = await service.addProgram({
      name: 'Fixture', command: 'node', args: [FIXTURE, '--flag'],
      env: [{ name: 'FIXTURE_URL', value: 'https://fixture.example' }, { name: 'FIXTURE_TOKEN', value: SECRET, secret: true }],
    });
    expect(connection).toMatchObject({
      transport: 'stdio', host: 'this computer', state: 'pending-review', signedIn: true,
      program: {
        command: 'node', args: [FIXTURE, '--flag'], line: `node ${FIXTURE} --flag`, changedSinceReview: false,
        env: [{ name: 'FIXTURE_URL', secret: false, value: 'https://fixture.example' }, { name: 'FIXTURE_TOKEN', secret: true }],
      },
    });
    // Nothing started, and the secret is nowhere but the vault.
    expect(liveGroups().length).toBe(before);
    expect(secrets.reads).toEqual([]);
    const { rows } = await pool.query('select * from mcp.connections');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(rows[0].env).toEqual([
      { name: 'FIXTURE_URL', value: 'https://fixture.example' },
      { name: 'FIXTURE_TOKEN', secretRef: `MCP_ENV_${connection.id.replace(/-/g, '')}_FIXTURE_TOKEN` },
    ]);

    const review = await service.review(connection.id);
    expect(review.program?.line).toBe(`node ${FIXTURE} --flag`);
    expect(review.host).toBe('this computer');
    expect(review.tools.map((t) => t.name)).toEqual(['echo', 'read_env', 'env_keys', 'where', 'spawn_child', 'crash']);
    const saved = await service.saveReview(connection.id, { slug: 'fixture', hash: review.hash });
    expect(saved).toMatchObject({ state: 'connected', grant: 'mcp.fixture.*', toolCount: 6 });
    expect(registry.list().map((t) => t.name)).toContain('mcp.fixture.echo');

    const echo = await registry.invoke('mcp.fixture.echo', { text: 'hello' }, ctx());
    expect(textOf(echo)).toContain('echo: hello');
    // The secret reached the program from the vault, and so did the plain one.
    expect(textOf(await registry.invoke('mcp.fixture.read_env', { name: 'FIXTURE_TOKEN' }, ctx()))).toContain(SECRET);
    expect(textOf(await registry.invoke('mcp.fixture.read_env', { name: 'FIXTURE_URL' }, ctx()))).toContain('https://fixture.example');
    expect(textOf(await registry.invoke('mcp.fixture.read_env', { name: 'DATABASE_URL' }, ctx()))).toContain('(unset)');
    const where = JSON.parse(/\{.*\}/s.exec(textOf(await registry.invoke('mcp.fixture.where', {}, ctx())))![0]) as { cwd: string };
    expect(where.cwd.endsWith(path.join('connections', connection.id))).toBe(true);

    // Disconnect takes the secret out of the vault and stops the program.
    await service.disconnect(connection.id);
    expect(secrets.held.size).toBe(0);
    await service.close();
  }, 60_000);

  it('stops the program, and what it started, after the idle time; the next call starts it again', async () => {
    const { registry, service } = setup({ idleMs: 400 });
    const { connection } = await service.addProgram({ name: 'Idle', command: 'node', args: [FIXTURE] });
    const review = await service.review(connection.id);
    await service.saveReview(connection.id, { slug: 'idle', hash: review.hash });
    const where = JSON.parse(/\{.*\}/s.exec(textOf(await registry.invoke('mcp.idle.where', {}, ctx())))![0]) as { pid: number };
    const grandchild = Number(/\d+/.exec(textOf(await registry.invoke('mcp.idle.spawn_child', {}, ctx())))![0]);
    expect(groupAlive(where.pid)).toBe(true);
    const gone = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i += 1) {
        if (!groupAlive(where.pid) && !processAlive(grandchild)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    expect(await gone()).toBe(true);
    const again = JSON.parse(/\{.*\}/s.exec(textOf(await registry.invoke('mcp.idle.where', {}, ctx())))![0]) as { pid: number };
    expect(again.pid).not.toBe(where.pid);
    // Shutdown kills the group.
    await service.close();
    expect(groupAlive(again.pid)).toBe(false);
  }, 60_000);

  it('keeps the last stderr lines on the row when it fails, never in a tool result', async () => {
    const { registry, service } = setup();
    const failing = await service.addProgram({
      name: 'Broken', command: 'node', args: [FIXTURE], env: [{ name: 'FIXTURE_FAIL', value: '1' }, { name: 'FIXTURE_TOKEN', value: SECRET, secret: true }],
    });
    await expect(service.review(failing.connection.id)).rejects.toMatchObject({ status: 502, code: 'program-failed' });
    const view = await service.get(failing.connection.id);
    expect(view.stderr).toHaveLength(20);
    expect(view.stderr).toContain('fixture: line 25');
    expect(view.stderr!.join('\n')).not.toContain(SECRET);
    expect(view.phase).toBeUndefined();

    // A program that crashes mid-call: the agent gets a sentence, the row gets the lines.
    const { connection } = await service.addProgram({ name: 'Crashy', command: 'node', args: [FIXTURE] });
    const review = await service.review(connection.id);
    await service.saveReview(connection.id, { slug: 'crashy', hash: review.hash });
    expect(JSON.stringify(await registry.invoke('mcp.crashy.crash', {}, ctx()))).not.toContain('fixture:');
    for (let i = 0; i < 100 && !(await service.get(connection.id)).stderr; i += 1) await new Promise((r) => setTimeout(r, 50));
    const crashed = await service.get(connection.id);
    expect(crashed.stderr).toEqual(['fixture: starting', 'fixture: about to crash', '(the program stopped with exit code 7)']);
    // Started again on the next call: it answers, and the failure leaves the row.
    const after = await registry.invoke('mcp.crashy.echo', { text: 'x' }, ctx());
    expect(textOf(after)).toContain('echo: x');
    expect(JSON.stringify(after)).not.toContain('fixture:');
    expect((await service.get(connection.id)).stderr).toBeUndefined();
    await service.close();
  }, 60_000);

  it('asks for another review when the command, the arguments or a variable name changes; a new value does not', async () => {
    const { registry, service, secrets } = setup();
    const { connection } = await service.addProgram({
      name: 'Changing', command: 'node', args: [FIXTURE], env: [{ name: 'FIXTURE_TOKEN', value: SECRET, secret: true }],
    });
    const review = await service.review(connection.id);
    await service.saveReview(connection.id, { slug: 'changing', hash: review.hash });
    expect(registry.list().map((t) => t.name)).toContain('mcp.changing.echo');

    // A new secret value, same names: no review, the new value reaches it.
    const same = await service.updateProgram(connection.id, {
      name: 'Changing', command: 'node', args: [FIXTURE], env: [{ name: 'FIXTURE_TOKEN', value: 'tok-new', secret: true }],
    });
    expect(same).toMatchObject({ state: 'connected', program: { changedSinceReview: false } });
    expect(textOf(await registry.invoke('mcp.changing.read_env', { name: 'FIXTURE_TOKEN' }, ctx()))).toContain('tok-new');
    // An empty secret keeps the value it had.
    await service.updateProgram(connection.id, {
      name: 'Changing', command: 'node', args: [FIXTURE], env: [{ name: 'FIXTURE_TOKEN', value: '', secret: true }],
    });
    expect(textOf(await registry.invoke('mcp.changing.read_env', { name: 'FIXTURE_TOKEN' }, ctx()))).toContain('tok-new');

    // Other arguments: the tools stop until it is reviewed again.
    const changed = await service.updateProgram(connection.id, {
      name: 'Changing', command: 'node', args: [FIXTURE, '--other'], env: [{ name: 'FIXTURE_TOKEN', value: '', secret: true }, { name: 'FIXTURE_EXTRA_TOOL', value: '1' }],
    });
    expect(changed).toMatchObject({ state: 'needs-review', program: { changedSinceReview: true } });
    expect(registry.list().map((t) => t.name).filter((n) => n.startsWith('mcp.changing.'))).toEqual([]);
    expect((await service.signals()).map((s) => s.sentence)).toEqual(["Changing's program changed; review it."]);

    // A review read before the change cannot be kept after it.
    await expect(service.saveReview(connection.id, { hash: review.hash })).rejects.toMatchObject({ status: 409, code: 'changed' });
    const again = await service.review(connection.id);
    expect(again.program?.line).toBe(`node ${FIXTURE} --other`);
    expect(again.changes?.added).toEqual(['extra']);
    await service.saveReview(connection.id, { hash: again.hash });
    expect(registry.list().map((t) => t.name)).toContain('mcp.changing.extra');
    expect(await service.get(connection.id)).toMatchObject({ state: 'connected', program: { changedSinceReview: false } });

    // A restart with a program edited behind buddi's back registers nothing of it.
    await pool.query(`update mcp.connections set args = '["x"]'::jsonb where id = $1`, [connection.id]);
    await service.close();
    const fresh = setup();
    await fresh.service.boot();
    expect(fresh.registry.list().map((t) => t.name).filter((n) => n.startsWith('mcp.changing.'))).toEqual([]);
    expect(secrets.held.size).toBe(1);
    await fresh.service.close();
  }, 60_000);

  it('refuses what cannot be run, and a secret without a vault', async () => {
    const { service } = setup();
    await expect(service.addProgram({ name: '', command: 'node' })).rejects.toMatchObject({ status: 400 });
    await expect(service.addProgram({ name: 'x', command: '' })).rejects.toMatchObject({ status: 400 });
    await expect(service.addProgram({ name: 'x', command: 'node', env: [{ name: '1BAD', value: 'v' }] })).rejects.toMatchObject({ status: 400 });
    await expect(service.addProgram({ name: 'x', command: 'node', env: [{ name: 'A', value: '1' }, { name: 'a', value: '2' }] })).rejects.toMatchObject({ status: 400 });
    await expect(service.addProgram({ name: 'x', command: 'node', env: [{ name: 'TOKEN', value: '', secret: true }] })).rejects.toMatchObject({ status: 400 });
    const noVault = setup({ secrets: undefined } as Partial<ConnectionsDeps>);
    await expect(noVault.service.addProgram({ name: 'x', command: 'node', env: [{ name: 'TOKEN', value: 'v', secret: true }] })).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('select count(*)::int as n from mcp.connections')).rows[0].n).toBe(0);
    await service.close();
  });
});

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
