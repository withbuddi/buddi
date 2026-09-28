/**
 * `buddi speech install [whisper|kokoro]` and `buddi speech`: the local speech
 * models, fetched from the command line.
 *
 * buddi does not know how: the speech plugin does. This loads the installed
 * plugin's own entry from the plugins record and calls the `installLocal` it
 * exports — the same function the Speech page's Install button runs, into
 * the same directory (`<data>/plugins-data/speech`), with the same pinned
 * URLs and checksums. A plugin cannot add a command of its own, so this thin
 * one lives here.
 *
 * No gateway is needed, and none is asked: the CLI hands the plugin an `http`
 * area of its own (`cliHttpArea`), core's `createHttpArea` with its address
 * rules on the socket, which additionally refuses any host the plugin's
 * manifest does not declare under `network`. The plugin follows redirects
 * itself, one hop at a time, each hop through this area again, so Hugging
 * Face's hop to *.hf.co is allowed and a hop anywhere else is not.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpArea, readPluginsFile, resolveDataDir, type HttpArea, type HttpTransportFactory } from '@buddi/core';
import { createHttpTransport } from '@buddi/runtime';
import { recordFile } from './plugins/load.js';

export type SpeechModel = 'whisper' | 'kokoro';
export const SPEECH_MODELS: readonly SpeechModel[] = ['whisper', 'kokoro'];

interface InstallProgress { fraction: number; bytes: number; total: number }
interface SpeechModule {
  installLocal?: (kind: SpeechModel, options: { dir: string; onProgress?: (p: InstallProgress) => void; http?: HttpArea }) => Promise<{ bytes: number; fetched: boolean; path: string }>;
  installedLocal?: (dir: string) => Record<SpeechModel, { label: string; installed: boolean; bytes: number; path: string; missing?: number }>;
  LOCAL_MODELS?: Record<SpeechModel, { label: string }>;
  manifest?: { network?: readonly { host: string }[] };
}

function hostMatches(declared: string, host: string): boolean {
  const pattern = declared.trim().toLowerCase();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

/**
 * An `http` area for the speech plugin outside the gateway: core's own (no
 * loopback, no private network, ports 80 and 443, checked again where the
 * socket resolves), refusing a host the manifest does not declare.
 */
export function cliHttpArea(
  network: readonly string[],
  log: (line: string) => void,
  transport: HttpTransportFactory = createHttpTransport,
): HttpArea {
  const area = createHttpArea({ plugin: 'speech', network, log, transport });
  return {
    request(req) {
      let host: string;
      try {
        host = new URL(req.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        return Promise.reject(new Error(`that is not a URL: ${JSON.stringify(String(req.url).slice(0, 120))}`));
      }
      if (!network.some((declared) => hostMatches(declared, host))) {
        return Promise.reject(new Error(`refusing ${host}: the speech plugin does not declare it under network`));
      }
      return area.request(req);
    },
  };
}

export interface SpeechCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Rewrite the current line (a TTY); absent, progress prints every tenth. */
  progress?: (line: string) => void;
}

const MB = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

/** The speech plugin's module, from the installed record, or the sentence saying why not. */
export async function loadSpeechPlugin(env: NodeJS.ProcessEnv): Promise<{ mod: SpeechModule } | { problem: string }> {
  let entry: string | undefined;
  try {
    entry = readPluginsFile(recordFile(env)).plugins.find((p) => p.name === 'speech')?.entry;
  } catch (err) {
    return { problem: `The plugins record could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!entry) return { problem: 'The speech plugin is not installed. Install it from Settings → Plugins, or with buddi plugins install.' };
  try {
    return { mod: (await import(pathToFileURL(entry).href)) as SpeechModule };
  } catch (err) {
    return { problem: `The speech plugin did not load: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function speechDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDataDir(env), 'plugins-data', 'speech');
}

export async function runSpeechCli(
  action: 'install' | 'status',
  model: SpeechModel | undefined,
  env: NodeJS.ProcessEnv = process.env,
  io: SpeechCliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ...(process.stdout.isTTY ? { progress: (line: string) => process.stdout.write(`\r${line}\x1b[K`) } : {}),
  },
): Promise<number> {
  const loaded = await loadSpeechPlugin(env);
  if ('problem' in loaded) {
    io.err(loaded.problem);
    return 1;
  }
  const { mod } = loaded;
  const dir = speechDir(env);
  if (!mod.installLocal || !mod.installedLocal) {
    io.err('This version of the speech plugin cannot install local models. Update it from Settings → Plugins.');
    return 1;
  }
  const state = mod.installedLocal(dir);
  const http = cliHttpArea((mod.manifest?.network ?? []).map((n) => n.host), (line) => io.err(`speech: ${line}`));
  if (action === 'status') {
    for (const kind of SPEECH_MODELS) {
      const s = state[kind];
      io.out(`${kind}: ${s.label}, ${s.installed ? `installed (${MB(s.bytes)}) in ${s.path}` : `not installed (a ${MB(s.bytes)} download)`}`);
    }
    return 0;
  }
  for (const kind of model ? [model] : SPEECH_MODELS) {
    const s = state[kind];
    if (s.installed) {
      io.out(`${s.label} is already installed (${MB(s.bytes)}).`);
      continue;
    }
    // `missing`: what is left when part is already here (Kokoro before eSpeak NG came with it).
    io.out(`Downloading ${s.label} (${MB(s.missing || s.bytes)}) into ${s.path}…`);
    let shown = -1;
    try {
      const result = await mod.installLocal(kind, {
        dir,
        http,
        onProgress: (p) => {
          const percent = Math.floor(p.fraction * 100);
          if (io.progress) {
            if (percent !== shown) io.progress(`  ${percent}% (${Math.round(p.bytes / 1_000_000)} of ${MB(p.total)})`);
            shown = percent;
            return;
          }
          // Not a terminal: a line at every tenth.
          const step = Math.floor(percent / 10) * 10;
          if (step > shown) {
            io.out(`  ${step}%`);
            shown = step;
          }
        },
      });
      if (io.progress) io.progress('');
      io.out(`Installed ${s.label}, ${MB(result.bytes)}. Checked against its pinned checksums; nothing leaves this computer when it runs.`);
    } catch (err) {
      if (io.progress) io.progress('');
      io.err(`buddi: ${s.label} was not installed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  io.out('Choose it on Settings → Speech, or leave the service blank there: installed, it is used.');
  return 0;
}
