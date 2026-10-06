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
 * Sessions share the one loaded binding. Each is loaded on its first `run`,
 * with its own thread limit, and unloaded after it sat idle; the next `run`
 * loads it again.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DownloadError, downloadVerified, extractVerified, sha256OfFile, sweepTemp, tempName } from './download.js';
import { currentPin, maxThreads, platformKey, runtimesConfig, runtimesGet, runtimesLog, runtimesRoot } from './config.js';
import { dlopenNative, OrtTensor, type NativeSession, type OnnxNative, type OnnxTensor } from './native.js';
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

/** What this process is doing. */
const live: {
  download?: Promise<void>;
  received: number;
  native?: { dir: string; binding: OnnxNative };
  loading?: Promise<OnnxNative>;
  sessions: Set<SharedSession>;
} = { received: 0, sessions: new Set() };

function engineDir(key: string, pin: OnnxPin): string {
  return path.join(runtimesRoot(), 'onnx', pin.version, key);
}

function failureFile(key: string, pin: OnnxPin): string {
  return path.join(runtimesRoot(), 'onnx', pin.version, `${key}.failed.json`);
}

function readFailure(key: string, pin: OnnxPin): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(failureFile(key, pin), 'utf8')) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : 'The engine failed.';
  } catch {
    return undefined;
  }
}

async function recordFailure(key: string, pin: OnnxPin, reason: string): Promise<void> {
  await mkdir(path.dirname(failureFile(key, pin)), { recursive: true });
  await writeFile(failureFile(key, pin), JSON.stringify({ reason, at: new Date().toISOString() }));
  runtimesLog(`onnx ${pin.version} ${key}: ${reason}`);
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
      const reason = err instanceof Error ? err.message : String(err);
      await recordFailure(key, pin, reason).catch(() => {});
    })
    .finally(() => {
      live.download = undefined;
    });
  live.download = run;
  return run;
}

async function downloadEngine(key: string, pin: OnnxPin): Promise<void> {
  const versionDir = path.join(runtimesRoot(), 'onnx', pin.version);
  await mkdir(versionDir, { recursive: true });
  await sweepTemp(versionDir);
  const tarball = tempName(versionDir, '.tgz');
  const stage = tempName(versionDir);
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

/**
 * The binding, loaded once per process. Each file is hashed again against
 * the pin before it is opened; a mismatch or a load error is recorded as
 * `failed` with the reason and is never retried by itself.
 */
async function loadedNative(): Promise<OnnxNative> {
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
  if (live.native?.dir === dir) return live.native.binding;
  if (live.loading !== undefined) return live.loading;
  live.loading = (async () => {
    try {
      for (const file of pin.files) {
        const digest = await sha256OfFile(path.join(dir, file.name));
        if (digest !== file.sha256) throw new DownloadError(`${file.name} on disk no longer matches its pinned checksum.`);
      }
      const binding = (runtimesConfig().loadNative ?? dlopenNative)(dir, pin);
      live.native = { dir, binding };
      return binding;
    } catch (err) {
      const reason = `The engine could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
      await recordFailure(key, pin, reason).catch(() => {});
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

class SharedSession implements OnnxSession {
  private handle: NativeSession | undefined;
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
    return this.handle !== undefined;
  }

  /** The thread limit the session was opened with. */
  get threadLimit(): number {
    return this.threads;
  }

  private async load(): Promise<NativeSession> {
    if (this.closed) throw new OnnxUnavailable('This session was closed.');
    if (this.handle !== undefined) return this.handle;
    const native = await loadedNative();
    const handle = new native.InferenceSession();
    handle.loadModel(this.modelPath, {
      intraOpNumThreads: this.threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
    this.handle = handle;
    return handle;
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.idleMs === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.unload();
    }, this.idleMs);
    this.timer.unref?.();
  }

  /** Drop the model from memory; the session stays usable. */
  unload(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const handle = this.handle;
    this.handle = undefined;
    try {
      handle?.dispose();
    } catch {
      // Already gone.
    }
  }

  /** One at a time per session: the binding's run is synchronous. */
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
        const input: Record<string, OrtTensor> = {};
        for (const [name, tensor] of Object.entries(feeds)) input[name] = new OrtTensor(tensor.type, tensor.data, [...tensor.dims]);
        const fetches: Record<string, null> = {};
        for (const output of handle.outputMetadata) fetches[output.name] = null;
        // Yield once so a caller's other work runs before the synchronous call.
        await new Promise((resolve) => setImmediate(resolve));
        const result = handle.run(input, fetches, {});
        const out: Record<string, OnnxTensor> = {};
        for (const [name, tensor] of Object.entries(result)) {
          out[name] = { type: tensor.type as OnnxTensor['type'], data: tensor.data, dims: [...tensor.dims] };
        }
        return out;
      } finally {
        this.arm();
      }
    });
  }

  names(): Promise<{ inputs: string[]; outputs: string[] }> {
    return this.serial(async () => {
      const handle = await this.load();
      this.arm();
      return { inputs: handle.inputMetadata.map((m) => m.name), outputs: handle.outputMetadata.map((m) => m.name) };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unload();
    live.sessions.delete(this);
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
 * Remove the engine (Settings → System): unload every session, delete the
 * folder and any recorded failure. Refused while a download runs. The loaded
 * library stays mapped until buddi restarts; nothing uses it once the files
 * are gone, and a plugin's next `ensure` asks the owner again.
 */
export async function removeOnnxRuntime(): Promise<{ removed: boolean; refused?: string }> {
  if (live.download !== undefined) return { removed: false, refused: 'The engine is downloading; remove it once that is done.' };
  const found = currentPin();
  if (found === undefined) return { removed: false, refused: 'There is no engine on this platform.' };
  for (const session of live.sessions) session.unload();
  const { key, pin } = found;
  const existed = existsSync(engineDir(key, pin)) || existsSync(failureFile(key, pin));
  await rm(engineDir(key, pin), { recursive: true, force: true });
  await rm(failureFile(key, pin), { force: true });
  await sweepTemp(path.join(runtimesRoot(), 'onnx', pin.version));
  return { removed: existed };
}

/** Forget what this process was doing. Tests only. */
export function resetOnnxRuntime(): void {
  for (const session of live.sessions) session.unload();
  live.sessions.clear();
  live.download = undefined;
  live.loading = undefined;
  live.native = undefined;
  live.received = 0;
}
