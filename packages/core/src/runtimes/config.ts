/**
 * What the runtimes area reads from its process: where the data directory is,
 * how to fetch, which platform this is, how the native binding is opened.
 * The composition root sets `env`; tests hand in a fetch over a local server,
 * a platform and pins of their own, and a fake binding, so no test reaches the
 * network or loads native code.
 */
import { cpus } from 'node:os';
import path from 'node:path';
import { resolveDataDir, type EnvLike } from '../artifacts/store.js';
import { nodeGet, type DownloadGet } from './download.js';
import { onnxPinFor, type OnnxPin } from './pins.js';
import type { OnnxNative } from './native.js';

export interface RuntimesConfig {
  env?: EnvLike;
  /** How a download asks for a URL. `nodeGet()` unless a test points it at a local server. */
  get?: DownloadGet;
  platform?: string;
  arch?: string;
  /** The pin for a platform. `onnxPinFor` unless a test points it at a fixture. */
  pinFor?: (platform: string, arch: string) => { key: string; pin: OnnxPin } | undefined;
  /**
   * Tests only: a fake binding run in this thread. Absent, the binding is
   * opened with `process.dlopen` inside the engine's worker thread.
   */
  loadNative?: (dir: string, pin: OnnxPin) => OnnxNative;
  /**
   * Tests only: the engine's worker uses a fake binding written into it
   * (`run` spins for its first input's milliseconds) instead of opening the
   * real one, so a test can time the worker without native code.
   */
  fakeWorkerBinding?: boolean;
  /** Where a background failure is logged. */
  log?: (line: string) => void;
  /** The most threads one session may ask for. Half the cores, at least 1, at most 8. */
  maxThreads?: number;
}

let config: RuntimesConfig = {};

/** Merge in what the caller owns. */
export function configureRuntimes(more: RuntimesConfig): void {
  config = { ...config, ...more };
}

/** Forget it. Tests only. */
export function resetRuntimesConfig(): void {
  config = {};
}

export function runtimesConfig(): RuntimesConfig {
  return config;
}

export function runtimesEnv(): EnvLike {
  return config.env ?? process.env;
}

let defaultGet: DownloadGet | undefined;

export function runtimesGet(): DownloadGet {
  return config.get ?? (defaultGet ??= nodeGet());
}

export function runtimesLog(line: string): void {
  (config.log ?? ((text: string) => console.error(text)))(`[runtimes] ${line}`);
}

/** `<data>/runtimes`. */
export function runtimesRoot(): string {
  return path.join(resolveDataDir(runtimesEnv()), 'runtimes');
}

/** `<data>/models`. */
export function modelsRoot(): string {
  return path.join(resolveDataDir(runtimesEnv()), 'models');
}

export function platformKey(): { platform: string; arch: string; key: string } {
  const platform = config.platform ?? process.platform;
  const arch = config.arch ?? process.arch;
  return { platform, arch, key: `${platform}-${arch}` };
}

export function currentPin(): { key: string; pin: OnnxPin } | undefined {
  const { platform, arch } = platformKey();
  return (config.pinFor ?? onnxPinFor)(platform, arch);
}

export function maxThreads(): number {
  if (config.maxThreads !== undefined) return Math.max(1, Math.floor(config.maxThreads));
  return Math.min(8, Math.max(1, Math.floor(cpus().length / 2)));
}
