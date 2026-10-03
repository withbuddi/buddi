/**
 * Ollama on this computer for the zero-key first run: which model for how
 * much memory, what the machine says about installing it, and a pull's
 * progress read from Ollama's own stream.
 */
import { describe, expect, it } from 'vitest';
import type { HttpTransport } from '@buddi/runtime';
import {
  OLLAMA_BREW_COMMAND,
  OLLAMA_LINUX_COMMAND,
  PullRefusal,
  createOllamaPulls,
  ollamaMachine,
  recommendLocalModel,
} from './ollama-local.js';

const GiB = 1024 ** 3;

describe('the model for this machine', () => {
  it('follows the memory table, generous to a machine that reports a little under its size', () => {
    expect(recommendLocalModel(4 * GiB).model).toBe('qwen3:1.7b');
    expect(recommendLocalModel(7.7 * GiB).model).toBe('qwen3:4b');
    expect(recommendLocalModel(16 * GiB).model).toBe('qwen3:8b');
    expect(recommendLocalModel(15.5 * GiB).model).toBe('qwen3:8b');
    expect(recommendLocalModel(32 * GiB).model).toBe('qwen3:14b');
    expect(recommendLocalModel(128 * GiB)).toMatchObject({ model: 'qwen3:14b', sizeGb: 9.3 });
  });
});

describe('the machine', () => {
  it('finds Ollama on the PATH or in the usual places, and the app on a Mac', () => {
    const base = { platform: 'darwin' as const, arch: 'arm64', totalmem: () => 16 * GiB, env: { PATH: '/x/bin' } };
    expect(ollamaMachine({ ...base, exists: () => false }).installed).toBe(false);
    expect(ollamaMachine({ ...base, exists: (f) => f === '/x/bin/ollama' }).installed).toBe(true);
    expect(ollamaMachine({ ...base, exists: (f) => f === '/opt/homebrew/bin/ollama' }).installed).toBe(true);
    expect(ollamaMachine({ ...base, exists: (f) => f === '/Applications/Ollama.app' }).installed).toBe(true);
  });

  it('shows the Homebrew command on a Mac and the official script on Linux, never more', () => {
    const mac = ollamaMachine({ platform: 'darwin', arch: 'arm64', totalmem: () => 16 * GiB, exists: () => false, env: {} });
    expect(mac).toMatchObject({ gpu: 'apple', cloudSuggested: false, install: { command: OLLAMA_BREW_COMMAND } });
    const linux = ollamaMachine({ platform: 'linux', arch: 'x64', totalmem: () => 16 * GiB, exists: () => false, env: {} });
    expect(linux.install.command).toBe('curl -fsSL https://ollama.com/install.sh | sh');
    expect(linux.install.command).toBe(OLLAMA_LINUX_COMMAND);
    expect(ollamaMachine({ platform: 'win32', arch: 'x64', totalmem: () => 16 * GiB, exists: () => false, env: {} }).install.command).toBeUndefined();
  });

  it('suggests Ollama Cloud with little memory or no graphics chip Ollama can use', () => {
    const linux = (exists: (f: string) => boolean, mem = 16) =>
      ollamaMachine({ platform: 'linux', arch: 'x64', totalmem: () => mem * GiB, exists, env: {} });
    expect(linux(() => false)).toMatchObject({ gpu: 'none', cloudSuggested: true });
    expect(linux((f) => f === '/dev/nvidia0')).toMatchObject({ gpu: 'nvidia', cloudSuggested: false });
    expect(linux((f) => f === '/dev/kfd')).toMatchObject({ gpu: 'amd', cloudSuggested: false });
    expect(linux((f) => f === '/dev/nvidia0', 4)).toMatchObject({ cloudSuggested: true, memoryGb: 4 });
  });
});

/** A transport that plays Ollama's NDJSON stream, chunk by chunk, split mid-line. */
function streaming(lines: string[], status = 200): HttpTransport {
  return async (_url, init) => {
    const text = lines.map((line) => `${line}\n`).join('');
    const cut = Math.floor(text.length / 2);
    init.onChunk?.(text.slice(0, cut), status);
    init.onChunk?.(text.slice(cut), status);
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => text, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

describe('a pull', () => {
  it('adds up the layers into one progress, and ends done on success', async () => {
    const seen: unknown[] = [];
    const transport: HttpTransport = async (url, init) => {
      seen.push(url, JSON.parse(String(init.body)));
      return streaming([
        '{"status":"pulling manifest"}',
        '{"status":"pulling aa","digest":"sha256:aa","total":1000,"completed":250}',
        '{"status":"pulling bb","digest":"sha256:bb","total":3000}',
        '{"status":"pulling aa","digest":"sha256:aa","total":1000,"completed":1000}',
        '{"status":"pulling bb","digest":"sha256:bb","total":3000,"completed":1500}',
      ])(url, init);
    };
    const pulls = createOllamaPulls({ baseUrl: 'http://ollama.test/', transport });
    expect(pulls.start('qwen3:4b')).toMatchObject({ state: 'pulling', completed: 0 });
    await pulls.settled();
    expect(seen).toEqual(['http://ollama.test/api/pull', { model: 'qwen3:4b', stream: true }]);
    // No "success": Ollama stopped short, and that is a failure to say.
    expect(pulls.read()).toMatchObject({ state: 'failed', completed: 2500, total: 4000, status: 'pulling bb' });
  });

  it('is done when Ollama says success', async () => {
    const pulls = createOllamaPulls({
      baseUrl: 'http://ollama.test',
      transport: streaming(['{"status":"pulling aa","digest":"sha256:aa","total":10,"completed":3}', '{"status":"verifying sha256 digest"}', '{"status":"success"}']),
    });
    pulls.start('qwen3:4b');
    await pulls.settled();
    expect(pulls.read()).toMatchObject({ state: 'done', completed: 10, total: 10, status: 'success' });
  });

  it("says Ollama's own error, and a refusal to connect in words", async () => {
    const said = createOllamaPulls({ baseUrl: 'http://ollama.test', transport: streaming(['{"error":"pull model manifest: file does not exist"}'], 500) });
    said.start('nope:1b');
    await said.settled();
    expect(said.read()).toMatchObject({ state: 'failed', error: 'pull model manifest: file does not exist' });

    const down = createOllamaPulls({ baseUrl: 'http://ollama.test', transport: async () => { throw new Error('connect ECONNREFUSED'); } });
    down.start('qwen3:4b');
    await down.settled();
    expect(down.read()?.error).toMatch(/not answering/);
  });

  it('takes one pull at a time, answers the same model twice, and refuses a name that is not one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pulls = createOllamaPulls({
      baseUrl: 'http://ollama.test',
      transport: async (url, init) => { await held; return streaming(['{"status":"success"}'])(url, init); },
    });
    pulls.start('qwen3:4b');
    expect(pulls.start('qwen3:4b').model).toBe('qwen3:4b');
    expect(() => pulls.start('qwen3:8b')).toThrow(PullRefusal);
    for (const bad of ['', 'qwen3:4b; rm -rf /', '../etc', 'a b']) expect(() => pulls.start(bad)).toThrow(/not a model name/);
    release();
    await pulls.settled();
    expect(pulls.read()?.state).toBe('done');
    // Another may start once the first is over.
    expect(pulls.start('qwen3:8b').state).toBe('pulling');
  });
});
