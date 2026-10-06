/**
 * The ONNX engine and shared models (host API 1.32): the download path over a
 * fake server, the state machine, the load, sessions with thread limits and
 * idle unloading, and who may reach it. No network, no native code, no
 * database: the pins point at a fixture tarball served from 127.0.0.1 and the
 * binding is a fake.
 */
import { existsSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configurePluginHost, createPluginHost, hostBindingOf, readOnlyHostOf, resetPluginHost } from '../host/build.js';
import type { PluginManifest } from '../tools.js';
import { configureRuntimes, resetRuntimesConfig } from './config.js';
import { describeRuntimesDownload, downloadArgs } from './consent.js';
import { nodeGet, safeReason } from './download.js';
import { sweepRuntimesOnce } from './area.js';
import { startFakeServer, sha256, tgz, type FakeServer } from './__fixtures__/server.js';
import { listModels, markModelApproved, modelState, removeModel, resetModels, startModelDownload } from './models.js';
import type { NativeSession, OnnxNative, OrtTensor } from './native.js';
import { createOnnxSession, markOnnxApproved, onnxSessionCounts, onnxState, removeOnnxRuntime, resetOnnxRuntime, startOnnxDownload } from './onnx.js';
import type { OnnxPin } from './pins.js';
import { ONNX_PINS, onnxPinFor } from './pins.js';

const BINDING = Buffer.from('fake binding '.repeat(500));
const LIBRARY = Buffer.from('fake library '.repeat(3000));
const OTHER = Buffer.from('another platform '.repeat(2000));
const TARBALL = tgz([
  { name: 'package/package.json', body: Buffer.from('{"name":"onnxruntime-node"}') },
  { name: 'package/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib', body: OTHER },
  { name: 'package/bin/napi-v6/linux/x64/onnxruntime_binding.node', body: BINDING },
  { name: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', body: LIBRARY },
]);

function pin(over: Partial<OnnxPin> = {}): OnnxPin {
  return {
    version: '9.9.9',
    tarball: { url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz', sha256: sha256(TARBALL), bytes: TARBALL.length },
    files: [
      { entry: 'package/bin/napi-v6/linux/x64/onnxruntime_binding.node', name: 'onnxruntime_binding.node', sha256: sha256(BINDING), bytes: BINDING.length },
      { entry: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', name: 'libonnxruntime.so.1', sha256: sha256(LIBRARY), bytes: LIBRARY.length },
    ],
    ...over,
  };
}

/** A binding that adds one to every float and records what it was asked. */
function fakeNative(record: { loads: Array<{ path: string; options: Record<string, unknown> }>; disposed: number }): OnnxNative {
  class Session implements NativeSession {
    inputMetadata = [{ name: 'x', isTensor: true, type: 1, shape: [3], symbolicDimensions: [''] }];
    outputMetadata = [{ name: 'y', isTensor: true, type: 1, shape: [3], symbolicDimensions: [''] }];
    loadModel(modelPath: string, options: Record<string, unknown>): void {
      record.loads.push({ path: modelPath, options });
    }
    run(feeds: Record<string, OrtTensor>): Record<string, OrtTensor> {
      const x = feeds.x!;
      const y = Float32Array.from(x.data as Float32Array, (v) => v + 1);
      return { y: { type: 'float32', data: y, dims: x.dims, location: 'cpu', size: y.length } as OrtTensor };
    }
    dispose(): void {
      record.disposed += 1;
    }
  }
  return { InferenceSession: Session, initOrtOnce: () => {} };
}

let server: FakeServer;
let data: string;
let loadCalls = 0;
let record: { loads: Array<{ path: string; options: Record<string, unknown> }>; disposed: number };
const TARBALL_PATH = '/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz';
const versionDir = (): string => path.join(data, 'runtimes', 'onnx', '9.9.9');

beforeAll(async () => {
  server = await startFakeServer();
});
afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  data = await mkdtemp(path.join(tmpdir(), 'buddi-runtimes-'));
  server.files.clear();
  server.modes.clear();
  server.hits.clear();
  server.redirects.clear();
  server.delays.clear();
  server.files.set(TARBALL_PATH, TARBALL);
  loadCalls = 0;
  record = { loads: [], disposed: 0 };
  configureRuntimes({
    env: { BUDDI_DATA_DIR: data },
    get: server.get,
    platform: 'linux',
    arch: 'x64',
    pinFor: (platform, arch) => (`${platform}-${arch}` === 'linux-x64' ? { key: 'linux-x64', pin: pin() } : undefined),
    loadNative: () => {
      loadCalls += 1;
      return fakeNative(record);
    },
    log: () => {},
    maxThreads: 4,
  });
});

afterEach(async () => {
  resetOnnxRuntime();
  resetModels();
  resetRuntimesConfig();
  await rm(data, { recursive: true, force: true });
});

describe('the pins', () => {
  it('cover Linux and Apple silicon, and leave Windows and Intel Macs out for now', () => {
    expect(onnxPinFor('linux', 'x64')?.pin.version).toBe('1.30.0');
    expect(onnxPinFor('darwin', 'arm64')?.pin.version).toBe('1.30.0');
    expect(onnxPinFor('darwin', 'x64')).toBeUndefined();
    expect(onnxPinFor('win32', 'x64')).toBeUndefined();
    expect(onnxPinFor('constructor', '')).toBeUndefined();
    for (const entry of Object.values(ONNX_PINS)) {
      if (entry === undefined) continue;
      expect(entry.tarball.url).toMatch(/^https:\/\/registry\.npmjs\.org\/onnxruntime-node\/-\//);
      for (const file of [entry.tarball, ...entry.files]) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.files.map((f) => f.name)).toContain('onnxruntime_binding.node');
    }
  });
});

describe('the engine download', () => {
  it('goes absent → downloading → ready, keeping only this platform\'s two files', async () => {
    expect(onnxState()).toMatchObject({ state: 'absent', version: '9.9.9', available: true, platform: 'linux-x64', sizeBytes: BINDING.length + LIBRARY.length, downloadBytes: TARBALL.length });
    const run = startOnnxDownload();
    expect(onnxState().state).toBe('downloading');
    expect(startOnnxDownload()).toBe(run);
    await run;
    expect(onnxState().state).toBe('ready');
    expect(readdirSync(path.join(versionDir(), 'linux-x64')).sort()).toEqual(['.verified.json', 'libonnxruntime.so.1', 'onnxruntime_binding.node']);
    // Nothing else of the tarball, and no temporary left.
    expect(readdirSync(versionDir())).toEqual(['linux-x64']);
    expect(server.hits.get(TARBALL_PATH)).toBe(1);
  });

  it('writes nothing into place when the checksum does not match, and does not retry by itself', async () => {
    server.modes.set(TARBALL_PATH, 'corrupt');
    await startOnnxDownload();
    const state = onnxState();
    expect(state.state).toBe('failed');
    expect(state.reason).toMatch(/pinned checksum/);
    expect(existsSync(path.join(versionDir(), 'linux-x64'))).toBe(false);
    expect(readdirSync(versionDir()).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    // Asked again (a later approval, a restart): nothing is fetched.
    server.modes.delete(TARBALL_PATH);
    resetOnnxRuntime();
    await startOnnxDownload();
    expect(onnxState().state).toBe('failed');
    expect(server.hits.get(TARBALL_PATH)).toBe(1);
  });

  it('refuses a file inside the tarball whose hash differs from its pin', async () => {
    configureRuntimes({
      pinFor: () => ({ key: 'linux-x64', pin: pin({ files: [{ ...pin().files[0]!, sha256: '0'.repeat(64) }, pin().files[1]!] }) }),
    });
    await startOnnxDownload();
    expect(onnxState()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/onnxruntime_binding\.node does not match/) });
    expect(existsSync(path.join(versionDir(), 'linux-x64'))).toBe(false);
  });

  it('sweeps a partial download, its own and one a dead process left', async () => {
    await mkdir(versionDir(), { recursive: true });
    await writeFile(path.join(versionDir(), '.tmp-left-by-a-crash.tgz'), 'half');
    server.modes.set(TARBALL_PATH, 'partial');
    await startOnnxDownload();
    expect(onnxState()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/broke off|ended after/) });
    expect(readdirSync(versionDir()).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('is removed from Settings, which also clears a failure', async () => {
    server.modes.set(TARBALL_PATH, 'missing');
    await startOnnxDownload();
    expect(onnxState()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/answered 404/) });
    expect(await removeOnnxRuntime()).toEqual({ removed: true });
    expect(onnxState().state).toBe('absent');
    server.modes.delete(TARBALL_PATH);
    await startOnnxDownload();
    expect(onnxState().state).toBe('ready');
    await removeOnnxRuntime();
    expect(onnxState().state).toBe('absent');
  });

  it('says it is not available on Windows', () => {
    configureRuntimes({ platform: 'win32', arch: 'x64' });
    expect(onnxState()).toMatchObject({ state: 'failed', available: false, reason: 'The engine is not available on this platform (win32-x64).' });
  });
});

describe('sessions on the one engine', () => {
  const model = (): string => path.join(data, 'model.onnx');

  it('loads the binding once, runs, and clamps the thread limit', async () => {
    await startOnnxDownload();
    const a = createOnnxSession(model(), { threads: 64 });
    const b = createOnnxSession(model(), { threads: 1 });
    expect(a.threadLimit).toBe(4);
    expect(b.threadLimit).toBe(1);
    const out = await a.run({ x: { type: 'float32', data: new Float32Array([1, 2, 3]), dims: [3] } });
    expect(Array.from(out.y!.data as Float32Array)).toEqual([2, 3, 4]);
    expect(out.y!.dims).toEqual([3]);
    await b.run({ x: { type: 'float32', data: new Float32Array([0, 0, 0]), dims: [3] } });
    expect(loadCalls).toBe(1);
    expect(record.loads.map((load) => load.options.intraOpNumThreads)).toEqual([4, 1]);
    expect(await a.names()).toEqual({ inputs: ['x'], outputs: ['y'] });
  });

  it('unloads a model that sat idle and loads it again on the next run', async () => {
    await startOnnxDownload();
    const session = createOnnxSession(model(), { idleUnloadMs: 30 });
    await session.run({ x: { type: 'float32', data: new Float32Array([1, 1, 1]), dims: [3] } });
    expect(session.loaded).toBe(true);
    expect(onnxSessionCounts()).toEqual({ open: 1, loaded: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(session.loaded).toBe(false);
    expect(record.disposed).toBe(1);
    await session.run({ x: { type: 'float32', data: new Float32Array([1, 1, 1]), dims: [3] } });
    expect(session.loaded).toBe(true);
    expect(record.loads).toHaveLength(2);
    await session.close();
    expect(onnxSessionCounts()).toEqual({ open: 0, loaded: 0 });
    await expect(session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } })).rejects.toThrow(/closed/);
  });

  it('turns a load failure into failed with the reason, and never loads again by itself', async () => {
    await startOnnxDownload();
    configureRuntimes({
      loadNative: () => {
        loadCalls += 1;
        throw new Error('dlopen: wrong architecture');
      },
    });
    const session = createOnnxSession(model());
    await expect(session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } })).rejects.toThrow(/wrong architecture/);
    expect(onnxState()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/could not be loaded: dlopen: wrong architecture/) });
    await expect(session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } })).rejects.toThrow(/wrong architecture/);
    expect(loadCalls).toBe(1);
  });

  it('checks the files again before loading them', async () => {
    await startOnnxDownload();
    await writeFile(path.join(versionDir(), 'linux-x64', 'libonnxruntime.so.1'), 'tampered');
    const session = createOnnxSession(model());
    await expect(session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } })).rejects.toThrow(/no longer matches/);
    expect(loadCalls).toBe(0);
  });

  it('will not run before the engine is ready', async () => {
    const session = createOnnxSession(model());
    await expect(session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } })).rejects.toThrow(/not downloaded/);
  });
});

describe('shared models', () => {
  const A = Buffer.from('encoder weights '.repeat(4000));
  const B = Buffer.from('{"vocab":[]}');
  const files = () => [
    { url: 'https://huggingface.co/acme/whisper/resolve/main/onnx/encoder.onnx', sha256: sha256(A), bytes: A.length, name: 'onnx/encoder.onnx' },
    { url: 'https://huggingface.co/acme/whisper/resolve/main/tokenizer.json', sha256: sha256(B), bytes: B.length },
  ];

  beforeEach(() => {
    server.files.set('/acme/whisper/resolve/main/onnx/encoder.onnx', A);
    server.files.set('/acme/whisper/resolve/main/tokenizer.json', B);
  });

  it('downloads once per id into models/<id>/ and answers its folder', async () => {
    const first = startModelDownload({ id: 'whisper-base', files: files() });
    expect(startModelDownload({ id: 'whisper-base', files: files() })).toBe(first);
    await first;
    const state = modelState('whisper-base');
    expect(state).toMatchObject({ state: 'ready', sizeBytes: A.length + B.length, path: path.join(data, 'models', 'whisper-base') });
    expect(existsSync(path.join(state.path!, 'onnx', 'encoder.onnx'))).toBe(true);
    expect(existsSync(path.join(state.path!, 'tokenizer.json'))).toBe(true);
    expect(server.hits.get('/acme/whisper/resolve/main/onnx/encoder.onnx')).toBe(1);
    expect(listModels().map((m) => m.id)).toEqual(['whisper-base']);
    // Another plugin naming the same id with other files is refused, not served another's model.
    expect(modelState('whisper-base', [{ name: 'tokenizer.json', sha256: '1'.repeat(64) }]).state).toBe('failed');
    await removeModel('whisper-base');
    expect(modelState('whisper-base').state).toBe('absent');
  });

  it('follows a redirect to where the bytes live, and still checks them', async () => {
    server.redirects.set('/acme/whisper/resolve/main/tokenizer.json', 'https://cdn-lfs.huggingface.co/blobs/tokenizer');
    server.files.set('/blobs/tokenizer', B);
    await startModelDownload({ id: 'whisper-base', files: files() });
    expect(modelState('whisper-base').state).toBe('ready');
    expect(server.hits.get('/blobs/tokenizer')).toBe(1);
  });

  it('writes nothing into place when one file does not match', async () => {
    server.modes.set('/acme/whisper/resolve/main/tokenizer.json', 'corrupt');
    await startModelDownload({ id: 'whisper-base', files: files() });
    expect(modelState('whisper-base')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/pinned checksum/) });
    expect(readdirSync(path.join(data, 'models'))).toEqual(['whisper-base.failed.json']);
  });

  it('refuses an id, a name or an address it should not take', () => {
    expect(() => startModelDownload({ id: '../etc', files: files() })).toThrow(/not a model id/);
    expect(() => startModelDownload({ id: 'm', files: [{ ...files()[0]!, name: '../escape.onnx' }] })).toThrow(/not a file name/);
    expect(() => startModelDownload({ id: 'm', files: [{ ...files()[0]!, url: 'http://huggingface.co/a.onnx' }] })).toThrow(/https/);
    expect(() => startModelDownload({ id: 'm', files: [{ ...files()[0]!, url: 'https://localhost/a.onnx' }] })).toThrow(/localhost/);
  });
});

describe('the card', () => {
  it('asks once for the model and the engine that runs it', () => {
    const args = downloadArgs('speech', 'to transcribe your voice notes here', true, { name: 'Whisper base model', bytes: 135_000_000 })!;
    const card = describeRuntimesDownload(args);
    expect(card.preview).toMatch(/^Download the Whisper base model \(135 MB\) and the engine that runs it \([^)]+\)\?\nspeech asks: to transcribe your voice notes here\. The engine is ONNX Runtime 9\.9\.9/);
    expect(args.key).toBe('onnx@9.9.9/linux-x64|named:Whisper base model');
  });

  it('asks only for the model once the engine is there', () => {
    const args = downloadArgs('news', 'to group stories', false, { id: 'minilm', files: [{ url: 'https://huggingface.co/m.onnx', sha256: 'a'.repeat(64), bytes: 90_000_000 }] })!;
    expect(describeRuntimesDownload(args).preview).toMatch(/^Download the minilm \(90 MB\)\?/);
    expect(downloadArgs('news', 'nothing missing', false, undefined)).toBeUndefined();
  });
});

describe('who may reach it', () => {
  const fakePool = {} as Pool;
  const facts = { db: fakePool, now: () => new Date('2026-10-06T10:00:00Z'), timezone: 'UTC' };
  const manifest = (uses: string[]): PluginManifest =>
    ({ name: 'speech', version: '1.0.0', schema: 'speech', migrationsDir: '', tools: [], uses }) as unknown as PluginManifest;

  it('gives the areas only to a plugin that declares onnx', () => {
    const without = createPluginHost(hostBindingOf(manifest([])), facts);
    expect(without.onnx).toBeUndefined();
    expect(without.models).toBeUndefined();
    const withIt = createPluginHost(hostBindingOf(manifest(['onnx'])), facts);
    expect(typeof withIt.onnx?.ensure).toBe('function');
    expect(typeof withIt.models?.ensure).toBe('function');
    expect(withIt.version).toBe('1.32');
  });

  it('keeps an export to reading the state', async () => {
    const host = createPluginHost(hostBindingOf(manifest(['onnx'])), facts);
    const view = readOnlyHostOf(host, 'speech.status');
    expect((await view.onnx!.state()).state).toBe('absent');
    await expect(Promise.resolve().then(() => view.onnx!.ensure({ reason: 'x' }))).rejects.toThrow(/read-only call/);
    await expect(Promise.resolve().then(() => view.onnx!.createSession('/m.onnx'))).rejects.toThrow(/read-only call/);
    await expect(Promise.resolve().then(() => view.models!.ensure({ id: 'm', files: [], reason: 'x' }))).rejects.toThrow(/read-only call/);
  });

  it('opens a model only from the plugin\'s directory or the shared models', async () => {
    await startOnnxDownload();
    configurePluginHost({ env: { BUDDI_DATA_DIR: data } });
    const host = createPluginHost(hostBindingOf(manifest(['onnx'])), facts);
    const outside = path.join(data, 'elsewhere.onnx');
    await writeFile(outside, 'x');
    await expect(host.onnx!.createSession(outside)).rejects.toThrow(/may open a model in its own directory/);
    const own = path.join(data, 'plugins-data', 'speech', 'model.onnx');
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, 'x');
    const session = await host.onnx!.createSession(own, { threads: 2 });
    const out = await session.run({ x: { type: 'float32', data: new Float32Array([5]), dims: [1] } });
    expect(Array.from(out.y!.data as Float32Array)).toEqual([6]);
    await session.close();
    resetPluginHost();
  });

  it('answers ensure without a card when nothing is missing', async () => {
    await startOnnxDownload();
    const host = createPluginHost(hostBindingOf(manifest(['onnx'])), facts);
    // The engine is here and the plugin fetches its own model: no card, no pool touched.
    const state = await host.onnx!.ensure({ reason: 'to listen', model: { name: 'Whisper base model', bytes: 135_000_000 } });
    expect(state.state).toBe('ready');
    expect(state.pending).toBeUndefined();
  });
});

describe('the downloader\'s guards', () => {
  const A = Buffer.from('weights '.repeat(2000));
  const one = () => [{ url: 'https://huggingface.co/acme/m/resolve/main/model.onnx', sha256: sha256(A), bytes: A.length }];

  beforeEach(() => {
    server.files.set('/acme/m/resolve/main/model.onnx', A);
  });

  it('refuses a redirect to a private or local address, and never asks it', async () => {
    for (const [i, target] of ['https://127.0.0.1/steal', 'https://10.1.2.3/steal', 'https://169.254.169.254/latest/meta-data', 'https://localhost/steal'].entries()) {
      server.redirects.set('/acme/m/resolve/main/model.onnx', target);
      await startModelDownload({ id: `m${i}`, files: one() });
      expect(modelState(`m${i}`)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/refusing/) });
      expect(existsSync(path.join(data, 'models', `m${i}`))).toBe(false);
    }
    expect(server.hits.get('/steal')).toBeUndefined();
    expect(server.hits.get('/latest/meta-data')).toBeUndefined();
  });

  it('refuses credentials, another port and plain http, first or after a redirect', async () => {
    const get = server.get;
    await expect(get('https://user:pass@huggingface.co/acme/m/resolve/main/model.onnx')).rejects.toThrow(/username or password/);
    await expect(get('https://huggingface.co:8443/acme/m/resolve/main/model.onnx')).rejects.toThrow(/port 8443/);
    await expect(get('http://huggingface.co/acme/m/resolve/main/model.onnx')).rejects.toThrow(/https only/);
    server.redirects.set('/acme/m/resolve/main/model.onnx', 'https://user:sekret@cdn.example.com/blob?sig=abc123');
    await startModelDownload({ id: 'creds', files: one() });
    const state = modelState('creds');
    expect(state).toMatchObject({ state: 'failed', reason: expect.stringMatching(/username or password/) });
    expect(state.reason).not.toMatch(/sekret|sig=abc123/);
    expect(server.hits.get('/blob')).toBeUndefined();
  });

  it('stops after five redirects', async () => {
    server.redirects.set('/loop', 'https://huggingface.co/loop');
    await expect(server.get('https://huggingface.co/loop')).rejects.toThrow(/too many redirects/);
    expect(server.hits.get('/loop')).toBe(6);
  });

  it('resolves every name through the guard, so a public name that answers a private address is refused', async () => {
    const get = nodeGet({
      request: httpRequest as never,
      // The socket dials a name, which only the guard resolves; it answers loopback.
      rewrite: (url) => `http://rebind.example:${server.port}${new URL(url).pathname}`,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(get('https://rebind.example/acme/m/resolve/main/model.onnx')).rejects.toThrow(/loopback|refus/);
    expect(server.hits.get('/acme/m/resolve/main/model.onnx')).toBeUndefined();
  });

  it('keeps a failure reason free of credentials, paths and queries', () => {
    const reason = safeReason('could not fetch https://user:sekret@cdn.example.com/private/abc?X-Amz-Signature=deadbeef\nthen gave up');
    expect(reason).toBe('could not fetch cdn.example.com then gave up');
    expect(safeReason('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('two models at once', () => {
  const A = Buffer.from('model a '.repeat(3000));
  const B = Buffer.from('model b '.repeat(3000));

  it('downloads both: neither sweeps the other\'s staging folder', async () => {
    server.files.set('/a/model.onnx', A);
    server.files.set('/b/model.onnx', B);
    // A is still staging when B starts and sweeps.
    server.delays.set('/a/model.onnx', 150);
    const a = startModelDownload({ id: 'model-a', files: [{ url: 'https://huggingface.co/a/model.onnx', sha256: sha256(A), bytes: A.length }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(path.join(data, 'models')).some((name) => name.startsWith('.tmp-model-a+'))).toBe(true);
    const b = startModelDownload({ id: 'model-b', files: [{ url: 'https://huggingface.co/b/model.onnx', sha256: sha256(B), bytes: B.length }] });
    await Promise.all([a, b]);
    expect(modelState('model-a').state).toBe('ready');
    expect(modelState('model-b').state).toBe('ready');
    expect(readdirSync(path.join(data, 'models')).sort()).toEqual(['model-a', 'model-b']);
  });
});

describe('a download cut short by a restart', () => {
  const fakePool = {} as Pool;
  const facts = { db: fakePool, now: () => new Date('2026-10-06T10:00:00Z'), timezone: 'UTC' };
  const manifest = (): PluginManifest =>
    ({ name: 'speech', version: '1.0.0', schema: 'speech', migrationsDir: '', tools: [], uses: ['onnx'] }) as unknown as PluginManifest;

  it('resumes on the next ensure with no second card, for the engine and a model', async () => {
    const M = Buffer.from('resumed '.repeat(500));
    server.files.set('/r/model.onnx', M);
    const files = [{ url: 'https://huggingface.co/r/model.onnx', sha256: sha256(M), bytes: M.length, name: 'model.onnx' }];
    await markOnnxApproved();
    await markModelApproved('resumed', files);
    // The pool is never touched: a card would need it.
    const host = createPluginHost(hostBindingOf(manifest()), facts);
    const engine = await host.onnx!.ensure({ reason: 'to listen' });
    expect(engine).toMatchObject({ state: 'downloading' });
    expect(engine.pending).toBeUndefined();
    const model = await host.models!.ensure({ id: 'resumed', files, reason: 'to listen' });
    expect(model).toMatchObject({ state: 'downloading' });
    expect(model.pending).toBeUndefined();
    await startOnnxDownload();
    await startModelDownload({ id: 'resumed', files });
    expect(onnxState().state).toBe('ready');
    expect(modelState('resumed').state).toBe('ready');
    // Spent: neither marker is left, so a later Remove asks again.
    expect(readdirSync(versionDir()).filter((name) => name.endsWith('.approved.json'))).toEqual([]);
    expect(readdirSync(path.join(data, 'models'))).toEqual(['resumed']);
  });

  it('sweeps half-written temporaries once at boot', async () => {
    await mkdir(versionDir(), { recursive: true });
    await mkdir(path.join(data, 'models', '.tmp-old+abc'), { recursive: true });
    await writeFile(path.join(versionDir(), '.tmp-abc.tgz'), 'half');
    await sweepRuntimesOnce();
    expect(readdirSync(versionDir())).toEqual([]);
    expect(readdirSync(path.join(data, 'models'))).toEqual([]);
  });
});

describe('closing a session while it loads', () => {
  it('never loads the model once it was closed during the engine\'s check', async () => {
    await startOnnxDownload();
    const session = createOnnxSession(path.join(data, 'model.onnx'));
    const running = session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } });
    // The run is hashing the engine's files; close it now.
    await session.close();
    await expect(running).rejects.toThrow(/closed/);
    expect(record.loads).toHaveLength(0);
    expect(session.loaded).toBe(false);
    expect(onnxSessionCounts()).toEqual({ open: 0, loaded: 0 });
  });

  it('refuses a run still queued when it closes, and unloads once', async () => {
    await startOnnxDownload();
    const session = createOnnxSession(path.join(data, 'model.onnx'));
    await session.run({ x: { type: 'float32', data: new Float32Array([1]), dims: [1] } });
    const queued = session.run({ x: { type: 'float32', data: new Float32Array([2]), dims: [1] } });
    await session.close();
    await expect(queued).rejects.toThrow(/closed/);
    expect(record.disposed).toBe(1);
    expect(record.loads).toHaveLength(1);
    expect(session.loaded).toBe(false);
  });
});

describe('the engine\'s worker', () => {
  it('runs a long inference off the main thread: a timer keeps its pace meanwhile', async () => {
    await startOnnxDownload();
    configureRuntimes({ loadNative: undefined, fakeWorkerBinding: true });
    const session = createOnnxSession(path.join(data, 'model.onnx'));
    // Load first, so only the run is timed.
    expect(await session.names()).toEqual({ inputs: ['x'], outputs: ['y'] });
    let last = Date.now();
    let worst = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
      ticks += 1;
    }, 10);
    try {
      const out = await session.run({ x: { type: 'float32', data: new Float32Array([400]), dims: [1] } });
      expect(Array.from(out.y!.data as Float32Array)).toEqual([401]);
    } finally {
      clearInterval(timer);
    }
    // 400 ms of a busy run: the main thread kept ticking every ~10 ms.
    expect(ticks).toBeGreaterThan(15);
    expect(worst).toBeLessThan(200);
    await session.close();
    expect(await removeOnnxRuntime()).toEqual({ removed: true });
  }, 30_000);
});
