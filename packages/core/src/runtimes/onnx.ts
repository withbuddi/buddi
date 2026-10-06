/**
 * The ONNX engine: one per process, downloaded on first need, for this
 * platform only (docs/plugin-host-api.md §4.2 `onnx`, 1.32).
 *
 * On disk it is `<data>/runtimes/onnx/<version>/<platform>-<arch>/`: the
 * binding, the library it links, and `.verified.json`, written inside the
 * temporary folder after every file matched its pin and before the folder is
 * renamed into place — so the folder exists only when it is whole.
 *
 * The state is read from disk and from what this process is doing:
 *
 *  - `absent`: no folder. A plugin's `ensure` raises a card; nothing is
 *    fetched before the owner's yes.
 *  - `downloading`: a download runs in this process.
 *  - `ready`: the folder is there.
 *  - `failed`: a download or a load failed, and the reason is kept in
 *    `<platform>-<arch>.failed.json` beside the folder. Nothing retries by
 *    itself, across restarts too; Remove in Settings clears it.
 *
 * Sessions share the one engine, which runs in a worker thread of its own so
 * a synchronous `run` never holds the event loop. Each is loaded on its first `run`,
 * with its own thread limit, and unloaded after it sat idle; the next `run`
 * loads it again.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DownloadError, downloadVerified, extractVerified, safeReason, sha256OfFile, sweepTemp, tempName } from './download.js';
import { currentPin, maxThreads, platformKey, runtimesConfig, runtimesGet, runtimesLog, runtimesRoot } from './config.js';
import { OrtTensor, type NativeSession, type OnnxNative, type OnnxTensor } from './native.js';
import { pinnedBytes, type OnnxPin } from './pins.js';

export type OnnxRuntimeStateName = 'absent' | 'downloading' | 'ready' | 'failed';

/** What `ctx.buddi.onnx.state()` answers. */
export interface OnnxRuntimeState {
  state: OnnxRuntimeStateName;
  /** The pinned ONNX Runtime version for this platform; empty where none is offered. */
  version: string;
  /** What stays on disk once it is ready: this platform's binding and library. */
  sizeBytes: number;
  /** What is downloaded to get there: the npm tarball, checked before it is opened. */
  downloadBytes: number;
  /** `<platform>-<arch>`. */
  platform: string;
  /** False where buddi offers no engine (Windows); `state` is then `failed`. */
  available: boolean;
  /** Why it failed, in a sentence. */
  reason?: string;
  /** While downloading: the bytes received so far. */
  receivedBytes?: number;
  /** An approval card raised by `ensure` and not decided yet. */
  pending?: string;
}

const VERIFIED = '.verified.json';

/**
 * Where sessions load and run: the engine's worker thread in a real process,
 * so a synchronous `run` never holds the event loop; in-process over a fake
 * binding in the tests that hand one in (`loadNative`).
 */
interface EngineHost {
  readonly alive: boolean;
  load(id: number, modelPath: string, options: Record<string, unknown>): Promise<{ inputs: string[]; outputs: string[] }>;
  run(id: number, feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
  dispose(id: number): Promise<void>;
  close(): Promise<void>;
}

/** What this process is doing. */
const live: {
  download?: Promise<void>;
  received: number;
  native?: { dir: string; host: EngineHost };
  loading?: Promise<EngineHost>;
  sessions: Set<SharedSession>;
} = { received: 0, sessions: new Set() };

function versionDir(pin: OnnxPin): string {
  return path.join(runtimesRoot(), 'onnx', pin.version);
}

function engineDir(key: string, pin: OnnxPin): string {
  return path.join(versionDir(pin), key);
}

function failureFile(key: string, pin: OnnxPin): string {
  return path.join(versionDir(pin), `${key}.failed.json`);
}

function approvedFile(key: string, pin: OnnxPin): string {
  return path.join(versionDir(pin), `${key}.approved.json`);
}

function readFailure(key: string, pin: OnnxPin): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(failureFile(key, pin), 'utf8')) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? safeReason(parsed.reason) : 'The engine failed.';
  } catch {
    return undefined;
  }
}

async function recordFailure(key: string, pin: OnnxPin, raw: string): Promise<string> {
  // Scrubbed and cut to hosts before it is logged, kept or shown in Settings.
  const reason = safeReason(raw);
  await mkdir(path.dirname(failureFile(key, pin)), { recursive: true });
  await writeFile(failureFile(key, pin), JSON.stringify({ reason, at: new Date().toISOString() }));
  runtimesLog(`onnx ${pin.version} ${key}: ${reason}`);
  return reason;
}

/** Keep the owner's yes for the engine until its download ends (`runtimes.download`). */
export async function markOnnxApproved(): Promise<void> {
  const found = currentPin();
  if (found === undefined) return;
  await mkdir(versionDir(found.pin), { recursive: true });
  await writeFile(approvedFile(found.key, found.pin), JSON.stringify({ version: found.pin.version, platform: found.key, at: new Date().toISOString() }));
}

/** Whether the owner approved this engine and its download has not finished (a restart cut it short). */
export function onnxApproved(): boolean {
  const found = currentPin();
  return found !== undefined && existsSync(approvedFile(found.key, found.pin));
}

/** The engine's state now. Synchronous: a few `stat`s. */
export function onnxState(): OnnxRuntimeState {
  const found = currentPin();
  if (found === undefined) {
    return {
      state: 'failed',
      version: '',
      sizeBytes: 0,
      downloadBytes: 0,
      platform: platformKey().key,
      available: false,
      reason: `The engine is not available on this platform (${platformKey().key}).`,
    };
  }
  const { key, pin } = found;
  const base = {
    version: pin.version,
    sizeBytes: pinnedBytes(pin),
    downloadBytes: pin.tarball.bytes,
    platform: key,
    available: true,
  };
  if (live.download !== undefined) return { ...base, state: 'downloading', receivedBytes: live.received };
  const reason = readFailure(key, pin);
  if (reason !== undefined) return { ...base, state: 'failed', reason };
  if (existsSync(path.join(engineDir(key, pin), VERIFIED))) return { ...base, state: 'ready' };
  return { ...base, state: 'absent' };
}

/**
 * Start the download, once the owner said yes. Answers at once; the download
 * runs in the background and the state says how it went. A second call while
 * one runs joins it. Never starts over a recorded failure or a ready engine.
 */
export function startOnnxDownload(): Promise<void> {
  if (live.download !== undefined) return live.download;
  const state = onnxState();
  if (state.state !== 'absent') return Promise.resolve();
  const { key, pin } = currentPin()!;
  live.received = 0;
  const run = downloadEngine(key, pin)
    .catch(async (err) => {
      await recordFailure(key, pin, err instanceof Error ? err.message : String(err)).catch(() => {});
    })
    .finally(async () => {
      // Finished or failed, the yes is spent: a failure is never retried by itself.
      await rm(approvedFile(key, pin), { force: true }).catch(() => {});
      live.download = undefined;
    });
  live.download = run;
  return run;
}

async function downloadEngine(key: string, pin: OnnxPin): Promise<void> {
  const dir = versionDir(pin);
  await mkdir(dir, { recursive: true });
  await sweepTemp(dir);
  const tarball = tempName(dir, '.tgz');
  const stage = tempName(dir);
  try {
    await downloadVerified(runtimesGet(), pin.tarball, tarball, {
      onProgress: (received) => {
        live.received = received;
      },
    });
    await mkdir(stage);
    await extractVerified(
      tarball,
      pin.files.map((file) => ({ entry: file.entry, dest: path.join(stage, file.name), sha256: file.sha256, bytes: file.bytes })),
    );
    await writeFile(
      path.join(stage, VERIFIED),
      JSON.stringify({
        version: pin.version,
        platform: key,
        files: pin.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
        at: new Date().toISOString(),
      }),
    );
    const final = engineDir(key, pin);
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await rm(tarball, { force: true }).catch(() => {});
  }
}

/** Sweep what a download that died left in this version's folder (once at boot). Skipped while one runs. */
export async function sweepOnnxTemps(): Promise<number> {
  const found = currentPin();
  if (found === undefined || live.download !== undefined) return 0;
  return sweepTemp(versionDir(found.pin));
}

/* ------------------------------------------------------------------ *
 * Where sessions run
 * ------------------------------------------------------------------ */

/** A session's feeds or outputs as plain data a worker message carries. */
function plain(tensors: Record<string, OnnxTensor>): Record<string, OnnxTensor> {
  const out: Record<string, OnnxTensor> = {};
  for (const [name, tensor] of Object.entries(tensors)) out[name] = { type: tensor.type, data: tensor.data, dims: [...tensor.dims] };
  return out;
}

/** Over a binding in this thread: only the tests' fake bindings (`loadNative`). */
function inProcessHost(native: OnnxNative): EngineHost {
  const sessions = new Map<number, NativeSession>();
  return {
    alive: true,
    async load(id, modelPath, options) {
      const handle = new native.InferenceSession();
      handle.loadModel(modelPath, options);
      sessions.set(id, handle);
      return { inputs: handle.inputMetadata.map((m) => m.name), outputs: handle.outputMetadata.map((m) => m.name) };
    },
    async run(id, feeds) {
      const handle = sessions.get(id);
      if (handle === undefined) throw new OnnxUnavailable('The session is not loaded.');
      const input: Record<string, OrtTensor> = {};
      for (const [name, tensor] of Object.entries(feeds)) input[name] = new OrtTensor(tensor.type, tensor.data, [...tensor.dims]);
      const fetches: Record<string, null> = {};
      for (const output of handle.outputMetadata) fetches[output.name] = null;
      await new Promise((resolve) => setImmediate(resolve));
      const result = handle.run(input, fetches, {});
      const out: Record<string, OnnxTensor> = {};
      for (const [name, tensor] of Object.entries(result)) {
        out[name] = { type: tensor.type as OnnxTensor['type'], data: tensor.data, dims: [...tensor.dims] };
      }
      return out;
    },
    async dispose(id) {
      const handle = sessions.get(id);
      sessions.delete(id);
      try {
        handle?.dispose();
      } catch {
        // Already gone.
      }
    },
    async close() {
      for (const id of [...sessions.keys()]) await this.dispose(id);
    },
  };
}

/**
 * The engine's worker: it opens the binding and holds every session, so a
 * synchronous `run` holds only this thread. CommonJS, evaluated from this
 * string, so it needs no file of its own. `workerData.fake` (tests only) swaps
 * the binding for one written here, whose `run` spins for as many
 * milliseconds as its first input says and answers it plus one; nothing is
 * ever loaded from a path a caller names but the verified binding.
 */
const WORKER_SOURCE = `
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const path = require('node:path');
class OrtTensor {
  constructor(type, data, dims) { this.location = 'cpu'; this.type = type; this.data = data; this.dims = dims; this.size = data.length; }
}
const sessions = new Map();
let native;
class FakeSession {
  constructor() { this.inputMetadata = [{ name: 'x' }]; this.outputMetadata = [{ name: 'y' }]; }
  loadModel() {}
  run(feeds) {
    const x = feeds.x;
    const until = Date.now() + Number(x.data[0]);
    while (Date.now() < until) {}
    return { y: new OrtTensor('float32', Float32Array.from(x.data, (v) => v + 1), x.dims) };
  }
  dispose() {}
}
async function open() {
  if (workerData.fake === true) {
    native = { InferenceSession: FakeSession };
    return;
  }
  const m = { exports: {} };
  process.dlopen(m, path.join(workerData.dir, 'onnxruntime_binding.node'));
  native = m.exports;
  if (!native || typeof native.InferenceSession !== 'function' || typeof native.initOrtOnce !== 'function') {
    throw new Error('the binding does not export InferenceSession and initOrtOnce');
  }
  // Warning level (2): errors and warnings reach the log, nothing chattier.
  native.initOrtOnce(2, OrtTensor, isMainThread);
}
const message = (err) => (err instanceof Error ? err.message : String(err));
parentPort.on('message', (msg) => {
  try {
    if (msg.op === 'load') {
      const s = new native.InferenceSession();
      s.loadModel(msg.modelPath, msg.options);
      sessions.set(msg.session, s);
      parentPort.postMessage({ seq: msg.seq, ok: true, value: { inputs: s.inputMetadata.map((m) => m.name), outputs: s.outputMetadata.map((m) => m.name) } });
    } else if (msg.op === 'run') {
      const s = sessions.get(msg.session);
      if (!s) throw new Error('the session is not loaded');
      const input = {};
      for (const [name, t] of Object.entries(msg.feeds)) input[name] = new OrtTensor(t.type, t.data, t.dims);
      const fetches = {};
      for (const o of s.outputMetadata) fetches[o.name] = null;
      const result = s.run(input, fetches, {});
      const out = {};
      for (const [name, t] of Object.entries(result)) out[name] = { type: t.type, data: t.data, dims: Array.from(t.dims) };
      parentPort.postMessage({ seq: msg.seq, ok: true, value: out });
    } else if (msg.op === 'dispose') {
      const s = sessions.get(msg.session);
      sessions.delete(msg.session);
      try { if (s) s.dispose(); } catch {}
      parentPort.postMessage({ seq: msg.seq, ok: true });
    }
  } catch (err) {
    parentPort.postMessage({ seq: msg.seq, ok: false, message: message(err) });
  }
});
open().then(() => parentPort.postMessage({ ready: true }), (err) => parentPort.postMessage({ ready: false, message: message(err) }));
`;

type WorkerAnswer = { ready: boolean; message?: string } | { seq: number; ok: boolean; value?: unknown; message?: string };

/** Start the engine's worker over a verified folder; answers once the binding is open. */
function workerHost(dir: string, fake: boolean): Promise<EngineHost> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dir, fake } });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    let seq = 0;
    let alive = true;
    let ready = false;
    const fail = (err: Error): void => {
      alive = false;
      for (const waiting of pending.values()) waiting.reject(err);
      pending.clear();
      if (!ready) reject(err);
    };
    const call = <T>(msg: Record<string, unknown>): Promise<T> => {
      if (!alive) return Promise.reject(new OnnxUnavailable('The engine stopped; the next run loads it again.'));
      return new Promise<T>((done, failed) => {
        seq += 1;
        pending.set(seq, { resolve: done as (value: unknown) => void, reject: failed });
        // Held open while it works; idle, it never keeps the process alive.
        worker.ref();
        worker.postMessage({ ...msg, seq });
      });
    };
    const host: EngineHost = {
      get alive() {
        return alive;
      },
      load: (id, modelPath, options) => call({ op: 'load', session: id, modelPath, options }),
      run: (id, feeds) => call({ op: 'run', session: id, feeds: plain(feeds) }),
      dispose: (id) => (alive ? call<void>({ op: 'dispose', session: id }).catch(() => {}) : Promise.resolve()),
      async close() {
        alive = false;
        await worker.terminate().catch(() => 0);
      },
    };
    worker.on('message', (msg: WorkerAnswer) => {
      if ('ready' in msg) {
        if (msg.ready) {
          ready = true;
          worker.unref();
          resolve(host);
        } else {
          fail(new Error(msg.message ?? 'the binding could not be opened'));
          void worker.terminate().catch(() => 0);
        }
        return;
      }
      const waiting = pending.get(msg.seq);
      if (waiting === undefined) return;
      pending.delete(msg.seq);
      if (pending.size === 0) worker.unref();
      if (msg.ok) waiting.resolve(msg.value);
      else waiting.reject(new Error(msg.message ?? 'the engine failed'));
    });
    worker.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', (code) => fail(new OnnxUnavailable(`The engine's worker stopped (exit ${code}).`)));
  });
}

/**
 * The engine, opened once per process. Each file is hashed again against
 * the pin before it is opened; a mismatch or a load error is recorded as
 * `failed` with the reason and is never retried by itself.
 */
async function loadedNative(): Promise<EngineHost> {
  const state = onnxState();
  if (state.state !== 'ready') {
    throw new OnnxUnavailable(
      state.state === 'failed'
        ? (state.reason ?? 'The engine failed.')
        : state.state === 'downloading'
          ? 'The engine is still downloading.'
          : 'The engine is not downloaded; ask for it with ctx.buddi.onnx.ensure first.',
    );
  }
  const { key, pin } = currentPin()!;
  const dir = engineDir(key, pin);
  if (live.native?.dir === dir && live.native.host.alive) return live.native.host;
  if (live.loading !== undefined) return live.loading;
  live.loading = (async () => {
    try {
      for (const file of pin.files) {
        const digest = await sha256OfFile(path.join(dir, file.name));
        if (digest !== file.sha256) throw new DownloadError(`${file.name} on disk no longer matches its pinned checksum.`);
      }
      const config = runtimesConfig();
      const host = config.loadNative !== undefined ? inProcessHost(config.loadNative(dir, pin)) : await workerHost(dir, config.fakeWorkerBinding === true);
      live.native = { dir, host };
      return host;
    } catch (err) {
      const reason = await recordFailure(key, pin, `The engine could not be loaded: ${err instanceof Error ? err.message : String(err)}`).catch(
        () => safeReason(`The engine could not be loaded: ${err instanceof Error ? err.message : String(err)}`),
      );
      throw new OnnxUnavailable(reason);
    } finally {
      live.loading = undefined;
    }
  })();
  return live.loading;
}

/** The engine is not there to run on: absent, downloading or failed. */
export class OnnxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnnxUnavailable';
  }
}

export interface OnnxSessionOptions {
  /** Threads inside one operator. Clamped to 1 … half the cores (at most 8). Default 2. */
  threads?: number;
  /** Unload the model after this long without a run. Default five minutes; 0 keeps it loaded. */
  idleUnloadMs?: number;
}

/** What `createSession` answers. */
export interface OnnxSession {
  /** Run once. Every output comes back as plain data. Loads the model when it is not loaded. */
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
  /** The model's input and output names; loads it when it is not loaded. */
  names(): Promise<{ inputs: string[]; outputs: string[] }>;
  /** Whether the model is in memory now. */
  readonly loaded: boolean;
  /** Unload it and forget the session. A later `run` throws. */
  close(): Promise<void>;
}

export const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000;

let nextSessionId = 0;

class SharedSession implements OnnxSession {
  private handle: { host: EngineHost; id: number; names: { inputs: string[]; outputs: string[] } } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly threads: number;
  private readonly idleMs: number;

  constructor(
    private readonly modelPath: string,
    opts: OnnxSessionOptions,
  ) {
    this.threads = Math.min(maxThreads(), Math.max(1, Math.floor(opts.threads ?? 2)));
    this.idleMs = Math.max(0, opts.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS);
  }

  get loaded(): boolean {
    return this.handle !== undefined && this.handle.host.alive;
  }

  /** The thread limit the session was opened with. */
  get threadLimit(): number {
    return this.threads;
  }

  /**
   * The model, loaded. Runs inside the session's queue, so a `close` waits
   * behind it; and closure is checked again after every wait, so a session
   * closed while the engine was being verified or the model loaded never
   * keeps a model nobody can reach.
   */
  private async load(): Promise<{ host: EngineHost; id: number; names: { inputs: string[]; outputs: string[] } }> {
    if (this.closed) throw new OnnxUnavailable('This session was closed.');
    if (this.handle !== undefined && this.handle.host.alive) return this.handle;
    this.handle = undefined;
    const host = await loadedNative();
    if (this.closed) throw new OnnxUnavailable('This session was closed.');
    nextSessionId += 1;
    const id = nextSessionId;
    const names = await host.load(id, this.modelPath, {
      intraOpNumThreads: this.threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
    if (this.closed) {
      await host.dispose(id);
      throw new OnnxUnavailable('This session was closed.');
    }
    this.handle = { host, id, names };
    return this.handle;
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.idleMs === 0 || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.unload();
    }, this.idleMs);
    this.timer.unref?.();
  }

  /** Drop the model now. Called only from inside the queue. */
  private async drop(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) await handle.host.dispose(handle.id);
  }

  /** Drop the model from memory once what is running finishes; the session stays usable. */
  unload(): void {
    void this.drain();
  }

  /** `unload`, awaited. */
  drain(): Promise<void> {
    return this.serial(() => this.drop());
  }

  /** One at a time per session. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>> {
    return this.serial(async () => {
      const handle = await this.load();
      if (this.timer !== undefined) clearTimeout(this.timer);
      try {
        return await handle.host.run(handle.id, feeds);
      } finally {
        this.arm();
      }
    });
  }

  names(): Promise<{ inputs: string[]; outputs: string[] }> {
    return this.serial(async () => {
      const handle = await this.load();
      this.arm();
      return { inputs: [...handle.names.inputs], outputs: [...handle.names.outputs] };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    live.sessions.delete(this);
    await this.drain();
  }
}

/**
 * A session over `modelPath`, sharing the process's one engine. Nothing is
 * loaded until the first `run`. The caller has checked the path is one the
 * plugin may open.
 */
export function createOnnxSession(modelPath: string, opts: OnnxSessionOptions = {}): OnnxSession & { readonly threadLimit: number; unload(): void } {
  const session = new SharedSession(modelPath, opts);
  live.sessions.add(session);
  return session;
}

/** How many sessions exist, and how many hold a model in memory now. */
export function onnxSessionCounts(): { open: number; loaded: number } {
  let loaded = 0;
  for (const session of live.sessions) if (session.loaded) loaded += 1;
  return { open: live.sessions.size, loaded };
}

/**
 * Remove the engine (Settings → System): unload every session, stop the
 * engine's worker, delete the folder and any recorded failure. Refused while a
 * download runs. A plugin's next `ensure` asks the owner again.
 */
export async function removeOnnxRuntime(): Promise<{ removed: boolean; refused?: string }> {
  if (live.download !== undefined) return { removed: false, refused: 'The engine is downloading; remove it once that is done.' };
  const found = currentPin();
  if (found === undefined) return { removed: false, refused: 'There is no engine on this platform.' };
  await Promise.all([...live.sessions].map((session) => session.drain()));
  const host = live.native?.host;
  live.native = undefined;
  await host?.close();
  const { key, pin } = found;
  const existed = existsSync(engineDir(key, pin)) || existsSync(failureFile(key, pin));
  await rm(engineDir(key, pin), { recursive: true, force: true });
  await rm(failureFile(key, pin), { force: true });
  await rm(approvedFile(key, pin), { force: true });
  await sweepTemp(versionDir(pin));
  return { removed: existed };
}

/** Forget what this process was doing. Tests only. */
export function resetOnnxRuntime(): void {
  for (const session of live.sessions) session.unload();
  live.sessions.clear();
  void live.native?.host.close();
  live.download = undefined;
  live.loading = undefined;
  live.native = undefined;
  live.received = 0;
}
