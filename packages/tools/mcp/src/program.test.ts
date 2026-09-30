/**
 * A program on this computer: started in its own group with a small
 * environment, spoken to over stdio, stopped with everything it started.
 * The fixture is a real MCP server (fixtures/stdio-server.mjs).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, commandLine, groupAlive, openProgram, specHash, StderrTail } from './program.js';
import { listAllTools } from './session.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'stdio-server.mjs');

const textOf = (answer: unknown): string => ((answer as { content: Array<{ text: string }> }).content[0]!.text);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe('program helpers', () => {
  it('puts the running Node first on PATH, keeps the basics, and only the named variables', () => {
    const env = childEnv({ TOKEN: 's3cret' }, { PATH: '/usr/bin:/bin', HOME: '/home/o', LANG: 'en_GB.UTF-8', AWS_SECRET: 'no', DATABASE_URL: 'no' }, '/opt/node/bin/node');
    expect(env).toEqual({ PATH: ['/opt/node/bin', '/usr/bin', '/bin'].join(path.delimiter), HOME: '/home/o', LANG: 'en_GB.UTF-8', TOKEN: 's3cret' });
  });

  it('quotes the command line as a shell needs it, and hashes command, args and names only', () => {
    expect(commandLine({ command: 'npx', args: ['-y', '@trokky/mcp@3', 'a b', "it's"] })).toBe(`npx -y @trokky/mcp@3 'a b' 'it'\\''s'`);
    const a = specHash({ command: 'npx', args: ['x'], env: [{ name: 'T' }] });
    expect(specHash({ command: 'npx', args: ['x'], env: [{ name: 'T', value: 'other' } as { name: string }] })).toBe(a);
    expect(specHash({ command: 'npx', args: ['y'], env: [{ name: 'T' }] })).not.toBe(a);
    expect(specHash({ command: 'npx', args: ['x'], env: [{ name: 'U' }] })).not.toBe(a);
  });

  it('keeps the last lines of stderr, without the secrets it was given', () => {
    const tail = new StderrTail(['hunter22'], 3);
    tail.push('one\ntwo\nthe password is hunter22\n');
    tail.push('\x1b[31mred\x1b[0m\npartial');
    expect(tail.lines()).toEqual(['the password is …', 'red', 'partial'].slice(-3));
  });
});

describe('openProgram (a real stdio server)', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-program-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('starts it in its own group, lists and calls its tools, passes only the named env, and kills the group', async () => {
    const tail = new StderrTail();
    const opened = await openProgram({
      command: 'node', args: [FIXTURE], cwd: dir, tail,
      env: childEnv({ FIXTURE_TOKEN: 'tok-123' }, { PATH: process.env.PATH, HOME: os.homedir(), SNEAKY: 'x' }),
    });
    const pid = opened.pid!;
    expect(pid).toBeGreaterThan(0);
    const tools = await listAllTools(opened.client);
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(textOf(await opened.client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('echo: hi');
    expect(textOf(await opened.client.callTool({ name: 'read_env', arguments: { name: 'FIXTURE_TOKEN' } }))).toBe('tok-123');
    expect(textOf(await opened.client.callTool({ name: 'env_keys', arguments: {} })).split(',').filter((k) => !k.startsWith('__CF_'))).toEqual(['FIXTURE_TOKEN', 'HOME', 'PATH']);
    const where = JSON.parse(textOf(await opened.client.callTool({ name: 'where', arguments: {} }))) as { pid: number; cwd: string; path: string };
    expect(where.pid).toBe(pid);
    expect(await import('node:fs').then((fs) => fs.realpathSync(where.cwd))).toBe(await import('node:fs').then((fs) => fs.realpathSync(dir)));
    expect(where.path.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(tail.lines()).toContain('fixture: starting');

    // Something it started lives in its group, and goes with it.
    const grandchild = Number(textOf(await opened.client.callTool({ name: 'spawn_child', arguments: {} })));
    expect(alive(grandchild)).toBe(true);
    expect(groupAlive(pid)).toBe(true);
    await opened.close();
    expect(await until(() => !alive(pid) && !alive(grandchild))).toBe(true);
    expect(groupAlive(pid)).toBe(false);
  }, 30_000);

  it('keeps stderr when the program fails to start, and says a missing command in a sentence', async () => {
    const tail = new StderrTail(['tok-123']);
    await expect(openProgram({
      command: 'node', args: [FIXTURE], cwd: dir, tail, timeoutMs: 10_000,
      env: childEnv({ FIXTURE_FAIL: '1', FIXTURE_TOKEN: 'tok-123' }),
    })).rejects.toThrow();
    const lines = tail.lines();
    expect(lines.length).toBe(20);
    expect(lines).toContain('fixture: cannot reach …');
    expect(lines.at(-1)).toBe('(the program stopped with exit code 3)');
    expect(lines.join('\n')).not.toContain('tok-123');

    await expect(openProgram({
      command: 'buddi-no-such-program-xyz', args: [], cwd: dir, tail: new StderrTail(), env: childEnv({}),
    })).rejects.toThrow('buddi-no-such-program-xyz was not found on this computer.');
  }, 30_000);
});
