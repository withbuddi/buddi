/**
 * Shared models: one download per model id, whichever plugins ask for it
 * (docs/plugin-host-api.md §4.2 `onnx`, `ctx.buddi.models`, 1.32).
 *
 * `<data>/models/<id>/` holds a model's files and `.verified.json`, written
 * after every file matched its pin and before the folder is renamed into
 * place, under the same rules as the engine: temporary names, checks while the
 * bytes arrive, an atomic rename, stale temporaries swept, a failure kept in
 * `<id>.failed.json` and never retried by itself.
 *
 * Minimal on purpose: plugins keep their own download code until they move,
 * and this is the place they move to.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkUrl } from '../plugin/url.js';
import { downloadVerified, sweepTemp, tempName, type PinnedDownload } from './download.js';
import { modelsRoot, runtimesGet, runtimesLog } from './config.js';

/** One file of a model: where it comes from, its sha256 and its length. */
export interface ModelFile extends PinnedDownload {
  /** Its path inside the model's folder. The URL's last segment when absent. */
  name?: string;
}

export interface ModelRequest {
  /** Lower case, digits, `.`, `_`, `-`; at most 96. One folder per id across plugins. */
  id: string;
  files: readonly ModelFile[];
}

/** What `ctx.buddi.models.state(id)` answers. */
export interface ModelState {
  id: string;
  state: 'absent' | 'downloading' | 'ready' | 'failed';
  /** The sum of its files. */
  sizeBytes: number;
  /** The folder its files are in, once it is ready. Pass `path.join(path, name)` to `createSession`. */
  path?: string;
  reason?: string;
  receivedBytes?: number;
  /** An approval card raised by `ensure` and not decided yet. */
  pending?: string;
}

/** The most one model may be: 8 GB. */
export const MODEL_MAX_BYTES = 8e9;
const VERIFIED = '.verified.json';
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A model request that is not one, in a sentence. */
export class ModelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRefusal';
  }
}

const live = new Map<string, { download: Promise<void>; received: number }>();

/** Each file's name in the folder, or a refusal. */
function fileName(file: ModelFile): string {
  const name = file.name ?? decodeURIComponent(new URL(file.url).pathname.split('/').pop() ?? '');
  const segments = name.split('/');
  if (segments.length > 4 || !segments.every((segment) => NAME_SEGMENT.test(segment) && segment !== '..' && !segment.startsWith('.'))) {
    throw new ModelRefusal(`"${name}" is not a file name a model may use (letters, digits, ".", "_", "-", at most four folders deep).`);
  }
  return name;
}

/** Check a request and answer it normalised: every file with its name. Throws a `ModelRefusal`. */
export function checkModelRequest(req: ModelRequest): { id: string; files: Array<PinnedDownload & { name: string }>; bytes: number } {
  if (typeof req?.id !== 'string' || !ID.test(req.id)) {
    throw new ModelRefusal(`"${String(req?.id)}" is not a model id (lower-case letters, digits, ".", "_" and "-", at most 96 characters).`);
  }
  if (!Array.isArray(req.files) || req.files.length === 0 || req.files.length > 64) {
    throw new ModelRefusal(`Model ${req.id} needs between one and 64 files.`);
  }
  const files = req.files.map((file) => {
    if (typeof file?.url !== 'string' || !/^https:\/\//.test(file.url)) {
      throw new ModelRefusal(`Model ${req.id}: every file is fetched over https.`);
    }
    try {
      checkUrl(file.url);
    } catch (err) {
      throw new ModelRefusal(`Model ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      throw new ModelRefusal(`Model ${req.id}: each file carries its sha256, as 64 hex digits.`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
      throw new ModelRefusal(`Model ${req.id}: each file carries its length in bytes.`);
    }
    return { url: file.url, sha256: file.sha256.toLowerCase(), bytes: file.bytes, name: fileName(file) };
  });
  if (new Set(files.map((file) => file.name)).size !== files.length) throw new ModelRefusal(`Model ${req.id} names one file twice.`);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (bytes > MODEL_MAX_BYTES) throw new ModelRefusal(`Model ${req.id} is larger than the 8 GB one model may be.`);
  return { id: req.id, files, bytes };
}

function folder(id: string): string {
  return path.join(modelsRoot(), id);
}

function failureFile(id: string): string {
  return path.join(modelsRoot(), `${id}.failed.json`);
}

function verifiedFiles(id: string): Array<{ name: string; sha256: string; bytes: number }> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(folder(id), VERIFIED), 'utf8')) as { files?: unknown };
    return Array.isArray(parsed.files) ? (parsed.files as Array<{ name: string; sha256: string; bytes: number }>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A model's state. With the files asked for, a model already kept with other
 * files is `failed`: one id is one model across plugins, and buddi will not
 * replace another plugin's files.
 */
export function modelState(id: string, files?: ReadonlyArray<{ name: string; sha256: string }>): ModelState {
  if (!ID.test(id)) return { id, state: 'failed', sizeBytes: 0, reason: `"${id}" is not a model id.` };
  const running = live.get(id);
  if (running !== undefined) return { id, state: 'downloading', sizeBytes: 0, receivedBytes: running.received };
  try {
    const parsed = JSON.parse(readFileSync(failureFile(id), 'utf8')) as { reason?: string };
    return { id, state: 'failed', sizeBytes: 0, reason: parsed.reason ?? 'The download failed.' };
  } catch {
    // No failure recorded.
  }
  const kept = verifiedFiles(id);
  if (kept === undefined) return { id, state: 'absent', sizeBytes: 0 };
  const sizeBytes = kept.reduce((sum, file) => sum + Number(file.bytes), 0);
  if (files !== undefined) {
    const same = files.length === kept.length && files.every((file) => kept.some((k) => k.name === file.name && k.sha256 === file.sha256));
    if (!same) return { id, state: 'failed', sizeBytes, reason: `Model ${id} is already kept with other files; pick another id.` };
  }
  return { id, state: 'ready', sizeBytes, path: folder(id) };
}

/** Start a model's download, once the owner said yes. Joins one already running; never restarts a failure. */
export function startModelDownload(req: ModelRequest): Promise<void> {
  const { id, files, bytes } = checkModelRequest(req);
  const running = live.get(id);
  if (running !== undefined) return running.download;
  if (modelState(id).state !== 'absent') return Promise.resolve();
  const entry = { received: 0, download: Promise.resolve() };
  entry.download = downloadModel(id, files, bytes, (received) => {
    entry.received = received;
  })
    .catch(async (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      runtimesLog(`model ${id}: ${reason}`);
      await mkdir(modelsRoot(), { recursive: true }).catch(() => {});
      await writeFile(failureFile(id), JSON.stringify({ reason, at: new Date().toISOString() })).catch(() => {});
    })
    .finally(() => {
      live.delete(id);
    });
  live.set(id, entry);
  return entry.download;
}

async function downloadModel(
  id: string,
  files: Array<PinnedDownload & { name: string }>,
  _bytes: number,
  progress: (received: number) => void,
): Promise<void> {
  const root = modelsRoot();
  await mkdir(root, { recursive: true });
  await sweepTemp(root);
  const stage = tempName(root);
  try {
    await mkdir(stage);
    let before = 0;
    for (const file of files) {
      const dest = path.join(stage, file.name);
      await mkdir(path.dirname(dest), { recursive: true });
      await downloadVerified(runtimesGet(), file, dest, { onProgress: (received) => progress(before + received) });
      before += file.bytes;
    }
    await writeFile(
      path.join(stage, VERIFIED),
      JSON.stringify({ id, files: files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes, url: file.url })), at: new Date().toISOString() }),
    );
    await rm(folder(id), { recursive: true, force: true });
    await rename(stage, folder(id));
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Every model kept or failed, for Settings. */
export function listModels(): ModelState[] {
  let names: string[];
  try {
    names = readdirSync(modelsRoot());
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const id = name.endsWith('.failed.json') ? name.slice(0, -'.failed.json'.length) : name;
    if (ID.test(id)) ids.add(id);
  }
  for (const id of live.keys()) ids.add(id);
  return [...ids].sort().map((id) => modelState(id)).filter((state) => state.state !== 'absent');
}

/** Remove a model and any recorded failure. Refused while it downloads. */
export async function removeModel(id: string): Promise<{ removed: boolean; refused?: string }> {
  if (!ID.test(id)) return { removed: false, refused: `"${id}" is not a model id.` };
  if (live.has(id)) return { removed: false, refused: `Model ${id} is downloading; remove it once that is done.` };
  const existed = existsSync(folder(id)) || existsSync(failureFile(id));
  await rm(folder(id), { recursive: true, force: true });
  await rm(failureFile(id), { force: true });
  return { removed: existed };
}

/** Forget what this process was doing. Tests only. */
export function resetModels(): void {
  live.clear();
}
