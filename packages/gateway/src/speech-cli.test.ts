/** `buddi speech install`: the installed speech plugin's own `installLocal`, found through the plugins record. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSpeechCli, speechDir } from './speech-cli.js';

let root: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let err: string[];
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });

/** A plugin entry that exports what the real one does, recording its calls into the data dir. */
const FAKE_PLUGIN = `
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
const LABELS = { whisper: 'Whisper small', kokoro: 'Kokoro 82M' };
const SIZES = { whisper: 251846613, kokoro: 92364770 };
export function installedLocal(dir) {
  return Object.fromEntries(Object.keys(LABELS).map((k) => [k, { label: LABELS[k], bytes: SIZES[k], path: path.join(dir, k), installed: existsSync(path.join(dir, k, 'ok')) }]));
}
export async function installLocal(kind, { dir, onProgress }) {
  if (kind === 'kokoro' && process.env.FAKE_FAIL) throw new Error('onnx/model_quantized.onnx did not match its checksum; nothing was kept.');
  for (const f of [0.25, 0.5, 1]) onProgress?.({ fraction: f, bytes: f * SIZES[kind], total: SIZES[kind] });
  await mkdir(path.join(dir, kind), { recursive: true });
  await writeFile(path.join(dir, kind, 'ok'), '');
  return { bytes: SIZES[kind], fetched: true, path: path.join(dir, kind) };
}
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'buddi-speech-cli-'));
  const pluginDir = path.join(root, 'speech');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'index.mjs'), FAKE_PLUGIN);
  const record = path.join(root, 'plugins.json');
  await writeFile(record, JSON.stringify({
    version: 2,
    plugins: [{
      name: 'speech', version: '0.1.0', source: { kind: 'directory', path: pluginDir }, entry: path.join(pluginDir, 'index.mjs'),
      installedAt: '2026-09-27T00:00:00.000Z', schema: 'speech',
    }],
  }));
  env = { BUDDI_PLUGINS_FILE: record, BUDDI_DATA_DIR: path.join(root, 'data') };
  out = [];
  err = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('buddi speech', () => {
  it('installs both into the plugin\'s own directory, then says they are there', async () => {
    expect(await runSpeechCli('install', undefined, env, io())).toBe(0);
    expect(out).toContain(`Downloading Whisper small (252 MB) into ${path.join(speechDir(env), 'whisper')}…`);
    expect(out).toContain('Installed Kokoro 82M, 92 MB. Checked against its pinned checksums; nothing leaves this computer when it runs.');
    expect(out.filter((l) => l === '  100%')).toHaveLength(2);
    expect(speechDir(env)).toBe(path.join(root, 'data', 'plugins-data', 'speech'));

    out = [];
    expect(await runSpeechCli('install', 'kokoro', env, io())).toBe(0);
    expect(out[0]).toBe('Kokoro 82M is already installed (92 MB).');
    out = [];
    expect(await runSpeechCli('status', undefined, env, io())).toBe(0);
    expect(out[0]).toBe(`whisper: Whisper small, installed (252 MB) in ${path.join(speechDir(env), 'whisper')}`);
  });

  it('says why when the plugin is missing, or a download fails', async () => {
    await writeFile(env.BUDDI_PLUGINS_FILE!, JSON.stringify({ version: 2, plugins: [] }));
    expect(await runSpeechCli('install', 'whisper', env, io())).toBe(1);
    expect(err).toEqual(['The speech plugin is not installed. Install it from Settings → Plugins, or with buddi plugins install.']);
  });

  it('stops at a failed checksum with the plugin\'s own sentence', async () => {
    process.env.FAKE_FAIL = '1';
    try {
      expect(await runSpeechCli('install', 'kokoro', env, io())).toBe(1);
      expect(err).toEqual(['buddi: Kokoro 82M was not installed: onnx/model_quantized.onnx did not match its checksum; nothing was kept.']);
    } finally {
      delete process.env.FAKE_FAIL;
    }
  });
});
