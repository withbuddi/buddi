/**
 * Ollama on this computer, for the zero-key first run: is it installed, how
 * would the owner install it, which small model suits this machine, and a
 * pull of that model with progress.
 *
 * Asked from the gateway, never from the page, for the reason the probe is
 * (`web/onboarding.ts`): the dashboard reaches no host but its own, and the
 * answers are about the machine buddi runs on. Nothing here installs Ollama:
 * the install command is *shown*, and the owner runs it.
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpTransport, type HttpTransport } from '@buddi/runtime';

/* ------------------------------------------------------------------ *
 * Which model, for how much memory
 * ------------------------------------------------------------------ */

export interface LocalModelChoice {
  /** The Ollama model tag, as `ollama pull` takes it. */
  model: string;
  /** About how much it downloads, in GB, for the button and the progress line. */
  sizeGb: number;
  /** Memory from which it is the pick, in GiB as the machine reports it. */
  fromGb: number;
}

/**
 * The table: the largest model that leaves room for the rest of the machine.
 * All four answer tool calls through Ollama's OpenAI-compatible endpoint,
 * which an agent needs. The thresholds sit a little under 8, 16 and 32 so a
 * machine that reports 7.7 GiB of its 8 is not treated as a 4 GB one.
 */
export const LOCAL_MODELS: readonly LocalModelChoice[] = [
  { model: 'qwen3:14b', sizeGb: 9.3, fromGb: 30 },
  { model: 'qwen3:8b', sizeGb: 5.2, fromGb: 15 },
  { model: 'qwen3:4b', sizeGb: 2.5, fromGb: 7 },
  { model: 'qwen3:1.7b', sizeGb: 1.4, fromGb: 0 },
];

export function recommendLocalModel(totalBytes: number): LocalModelChoice {
  const gb = totalBytes / 1024 ** 3;
  return LOCAL_MODELS.find((row) => gb >= row.fromGb) ?? LOCAL_MODELS[LOCAL_MODELS.length - 1]!;
}

/* ------------------------------------------------------------------ *
 * The machine
 * ------------------------------------------------------------------ */

export type LocalGpu = 'apple' | 'nvidia' | 'amd' | 'none';

export interface OllamaInstallHelp {
  /** Where Ollama is downloaded: data for the page, which names no host. */
  url: string;
  /** The one command that installs it here, shown with a copy button and never run by buddi. */
  command?: string;
}

export interface OllamaMachine {
  platform: NodeJS.Platform;
  /** The machine's memory, in GiB, one decimal. */
  memoryGb: number;
  gpu: LocalGpu;
  /** An `ollama` program or the Ollama app is on this machine, running or not. */
  installed: boolean;
  /** The model the first run offers to pull here. */
  recommended: LocalModelChoice;
  install: OllamaInstallHelp;
  /**
   * A model on this machine would be slow enough that Ollama Cloud is the
   * better first brain: little memory, or no graphics chip Ollama can use.
   */
  cloudSuggested: boolean;
}

export const OLLAMA_INSTALL_URL = 'https://ollama.com/download';
/** The official Linux installer, exactly as ollama.com prints it. */
export const OLLAMA_LINUX_COMMAND = 'curl -fsSL https://ollama.com/install.sh | sh';
export const OLLAMA_BREW_COMMAND = 'brew install ollama';

export function ollamaInstallHelp(platform: NodeJS.Platform): OllamaInstallHelp {
  if (platform === 'linux') return { url: OLLAMA_INSTALL_URL, command: OLLAMA_LINUX_COMMAND };
  if (platform === 'darwin') return { url: OLLAMA_INSTALL_URL, command: OLLAMA_BREW_COMMAND };
  return { url: OLLAMA_INSTALL_URL };
}

export interface MachineDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  totalmem?: () => number;
  exists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where an `ollama` may live. The service's PATH is often a short one
 * (launchd, systemd), so the usual install places are looked at as well.
 */
function candidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const fixed = ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin'];
  const exe = platform === 'win32' ? 'ollama.exe' : 'ollama';
  const files = [...new Set([...dirs, ...fixed])].map((dir) => path.join(dir, exe));
  if (platform === 'darwin') files.push('/Applications/Ollama.app/Contents/Resources/ollama');
  return files;
}

export function ollamaMachine(deps: MachineDeps = {}): OllamaMachine {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const exists = deps.exists ?? existsSync;
  const total = (deps.totalmem ?? os.totalmem)();
  const memoryGb = Math.round((total / 1024 ** 3) * 10) / 10;
  const gpu: LocalGpu =
    platform === 'darwin'
      ? arch === 'arm64' ? 'apple' : 'none'
      : platform === 'linux'
        ? exists('/dev/nvidia0') || exists('/proc/driver/nvidia/version') ? 'nvidia' : exists('/dev/kfd') ? 'amd' : 'none'
        : 'none';
  const fileExists = deps.exists ?? isFile;
  const installed =
    candidates(platform, deps.env ?? process.env).some((file) => fileExists(file)) ||
    (platform === 'darwin' && exists('/Applications/Ollama.app'));
  const recommended = recommendLocalModel(total);
  return {
    platform,
    memoryGb,
    gpu,
    installed,
    recommended,
    install: ollamaInstallHelp(platform),
    cloudSuggested: memoryGb < 7 || gpu === 'none',
  };
}

/* ------------------------------------------------------------------ *
 * A pull, with progress
 * ------------------------------------------------------------------ */

export interface OllamaPull {
  model: string;
  state: 'pulling' | 'done' | 'failed';
  /** Bytes fetched so far, over every layer Ollama has named. */
  completed: number;
  /** Bytes in all, as far as Ollama has said; 0 until the first layer. */
  total: number;
  /** Ollama's own last status line ("pulling manifest", "verifying sha256 digest"). */
  status: string;
  error?: string;
}

/** A model name as `ollama pull` takes it; nothing that could reach past the field. */
export const OLLAMA_MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*(:[a-z0-9][a-z0-9._-]*)?$/i;

export class PullRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OllamaPullsDeps {
  /** Where Ollama answers, without `/v1`. */
  baseUrl: string;
  transport?: HttpTransport;
}

/**
 * One pull at a time, remembered until the next one. A pull of gigabytes
 * goes quiet between layers, so the socket may be idle for a while; it is
 * abandoned only after the transport's usual five minutes of silence.
 */
export function createOllamaPulls(deps: OllamaPullsDeps) {
  const transport = deps.transport ?? createHttpTransport();
  const base = deps.baseUrl.replace(/\/+$/, '');
  let current: OllamaPull | null = null;
  let running: Promise<void> | null = null;

  const apply = (pull: OllamaPull, layers: Map<string, { total: number; completed: number }>, line: string): void => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof row.error === 'string') {
      pull.state = 'failed';
      pull.error = row.error;
      return;
    }
    if (typeof row.status === 'string') pull.status = row.status;
    if (typeof row.digest === 'string' && typeof row.total === 'number') {
      const completed = typeof row.completed === 'number' ? row.completed : 0;
      const before = layers.get(row.digest);
      layers.set(row.digest, { total: row.total, completed: Math.max(before?.completed ?? 0, completed) });
      pull.total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
      pull.completed = [...layers.values()].reduce((sum, layer) => sum + Math.min(layer.completed, layer.total), 0);
    }
    if (row.status === 'success') {
      pull.state = 'done';
      pull.completed = pull.total;
    }
  };

  const run = async (pull: OllamaPull): Promise<void> => {
    const layers = new Map<string, { total: number; completed: number }>();
    let carry = '';
    try {
      const res = await transport(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ model: pull.model, stream: true }),
        onChunk: (text) => {
          carry += text;
          const lines = carry.split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) apply(pull, layers, line);
        },
      });
      // The whole body is here as well: read whatever the tap did not see.
      if (carry.trim()) apply(pull, layers, carry);
      if (pull.state === 'pulling') {
        const lines = (await res.text()).split('\n').filter((line) => line.trim());
        for (const line of lines) if (pull.state === 'pulling') apply(pull, layers, line);
      }
      if (!res.ok && pull.state !== 'failed') {
        pull.state = 'failed';
        pull.error = pull.error ?? `Ollama answered ${res.status}.`;
      }
      if (pull.state === 'pulling') {
        pull.state = 'failed';
        pull.error = 'Ollama stopped before the model was complete. Try again.';
      }
    } catch (err) {
      pull.state = 'failed';
      pull.error = `Ollama is not answering: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return {
    /** Start pulling `model`, or answer the pull of it already going. */
    start(model: string): OllamaPull {
      const name = model.trim();
      if (!OLLAMA_MODEL_NAME.test(name) || name.length > 120) throw new PullRefusal(400, 'That is not a model name Ollama knows.');
      if (current?.state === 'pulling') {
        if (current.model === name) return { ...current };
        throw new PullRefusal(409, `Ollama is already fetching ${current.model}. Wait for it, then try again.`);
      }
      const pull: OllamaPull = { model: name, state: 'pulling', completed: 0, total: 0, status: 'starting' };
      current = pull;
      const snapshot = { ...pull };
      running = run(pull);
      return snapshot;
    },
    /** The last pull, as it stands. */
    read(): OllamaPull | null {
      return current ? { ...current } : null;
    },
    /** For tests: the pull's end. */
    settled(): Promise<void> {
      return running ?? Promise.resolve();
    },
  };
}

export type OllamaPulls = ReturnType<typeof createOllamaPulls>;
