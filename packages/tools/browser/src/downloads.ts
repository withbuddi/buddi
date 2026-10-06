/**
 * The agents' downloads area (docs/browser.md, "Downloads").
 *
 * A file a page hands an agent — the bank's transactions CSV, a statement PDF —
 * lands here first, under `<data>/downloads/<agent>/<yyyy-mm-dd>/`, and the
 * browser service then registers it in Files so the agent can pass its id to a
 * plugin's import tool. This folder is the landing zone, not the library: it is
 * swept after thirty days, and the owner can clear it from Settings → Browser;
 * the copy in Files stays until the owner deletes it there.
 *
 * Three rules hold for every file: it is never executable (written 0600, the
 * exec bit never set), no single file is larger than the per-file cap, and no
 * agent keeps more than its cap here. A download that would break one is
 * refused with a sentence the agent can repeat, and nothing partial is left.
 */
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

export const DOWNLOAD_FILE_CAP = 50 * 1024 * 1024;
export const DOWNLOAD_AGENT_CAP = 500 * 1024 * 1024;
export const DOWNLOAD_RETENTION_DAYS = 30;
/** A finished file in the owner's own Downloads folder counts only this soon after it was written. */
export const OWNER_FILE_FRESH_MS = 15 * 60 * 1000;

/** Refused on purpose: a cap, an empty file, a file that is not the one reported. The message is the agent's. */
export class DownloadRefused extends Error {}

/**
 * One download a driver saw, not yet in the area.
 *
 * Playwright hands a stream that ends when the download finishes; the owner's
 * Chrome hands the finished file's path on this machine, which is read only
 * under the checks in `#ownerFile`.
 */
export interface PendingDownload {
  filename: string;
  url: string;
  mime?: string;
  /** What the browser reported, when it did. */
  size?: number;
  read: { stream(): Promise<Readable | null> } | { path: string };
  /** Why the browser gave up on it, when it did. */
  failure?(): Promise<string | null>;
}

export interface StoredDownload { path: string; filename: string; size: number; mime: string; url: string; agent: string }

export interface DownloadUsage {
  bytes: number;
  files: number;
  agents: Array<{ agent: string; bytes: number; files: number }>;
  fileCap: number;
  agentCap: number;
  retentionDays: number;
}

export interface DownloadStoreOptions {
  fileCap?: number;
  agentCap?: number;
  retentionDays?: number;
  now?: () => number;
  /** Where the owner's own files live; a Chrome download is read only from under it. */
  homeDir?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', json: 'application/json', xml: 'application/xml',
  pdf: 'application/pdf', ofx: 'application/x-ofx', qfx: 'application/x-ofx', qif: 'application/qif',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** The type a download is filed under: what the server said when it said something useful, else the extension's. */
export function downloadMime(filename: string, reported?: string): string {
  const given = reported?.split(';')[0]?.trim().toLowerCase();
  if (given && given !== 'application/octet-stream' && /^[a-z]+\/[a-z0-9.+-]+$/.test(given)) return given;
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** A name that is a name: no folders, no control characters, no leading dot, at most 120 characters. */
export function downloadName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (base === '') return 'download';
  if (base.length <= 120) return base;
  const ext = path.extname(base).slice(0, 12);
  return `${base.slice(0, 120 - ext.length)}${ext}`;
}

/** An agent id as a folder name. */
function agentFolder(agent: string): string {
  return agent.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'agent';
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The address a download came from, for its Files row: origin and path, never the query (signed URLs carry tokens there). */
export function downloadSource(url: string): string {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`.slice(0, 2048); }
  catch { return url.split(/[?#]/)[0]!.slice(0, 2048); }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class DownloadStore {
  readonly fileCap: number;
  readonly agentCap: number;
  readonly retentionDays: number;
  readonly #now: () => number;
  readonly #home: string;
  constructor(readonly root: string, options: DownloadStoreOptions = {}) {
    this.fileCap = options.fileCap ?? DOWNLOAD_FILE_CAP;
    this.agentCap = options.agentCap ?? DOWNLOAD_AGENT_CAP;
    this.retentionDays = options.retentionDays ?? DOWNLOAD_RETENTION_DAYS;
    this.#now = options.now ?? Date.now;
    this.#home = options.homeDir ?? os.homedir();
  }

  async #tally(dir: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0; let files = 0;
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const inner = await this.#tally(full); bytes += inner.bytes; files += inner.files; }
      else if (entry.isFile()) { try { bytes += (await stat(full)).size; files += 1; } catch { /* gone meanwhile */ } }
    }
    return { bytes, files };
  }

  /** The finished file a Chrome download left, read only when it plainly is that file. */
  async #ownerFile(file: string, reported: number | undefined): Promise<Readable> {
    const refuse = () => new DownloadRefused('That download could not be read from your Downloads folder.');
    if (!path.isAbsolute(file)) throw refuse();
    const resolved = path.resolve(file);
    const home = path.resolve(this.#home) + path.sep;
    if (!resolved.startsWith(home) || resolved.startsWith(path.resolve(this.root) + path.sep)) throw refuse();
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(resolved); } catch { throw refuse(); }
    if (!info.isFile() || info.isSymbolicLink()) throw refuse();
    if (Math.abs(this.#now() - info.mtimeMs) > OWNER_FILE_FRESH_MS) throw refuse();
    if (reported !== undefined && reported >= 0 && info.size !== reported) throw refuse();
    if (info.size > this.fileCap) throw new DownloadRefused(`That download is ${kb(info.size)}; agents may download at most ${kb(this.fileCap)} per file.`);
    return createReadStream(resolved);
  }

  /** Copy one download into the agent's area for today. Refuses, and leaves nothing behind, when a cap is hit. */
  async save(agent: string, pending: PendingDownload): Promise<StoredDownload> {
    const failure = await pending.failure?.().catch(() => null);
    if (failure) throw new DownloadRefused(`The download did not finish: ${failure}.`);
    if (pending.size !== undefined && pending.size > this.fileCap) {
      throw new DownloadRefused(`That download is ${kb(pending.size)}; agents may download at most ${kb(this.fileCap)} per file.`);
    }
    const agentDir = path.join(this.root, agentFolder(agent));
    const used = (await this.#tally(agentDir)).bytes;
    const room = this.agentCap - used;
    if (room <= 0 || (pending.size !== undefined && pending.size > room)) {
      throw new DownloadRefused(`This agent's downloads area is full (${kb(used)} of ${kb(this.agentCap)}). The owner can clear it in Settings → Browser.`);
    }
    const limit = Math.min(this.fileCap, room);
    const source = 'path' in pending.read ? await this.#ownerFile(pending.read.path, pending.size) : await pending.read.stream();
    if (!source) throw new DownloadRefused('The download did not finish.');

    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const dir = path.join(agentDir, day);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = downloadName(pending.filename);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = '';
    let handle: FileHandle | undefined;
    for (let n = 1; n < 1000 && !handle; n++) {
      target = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      try { handle = await open(target, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!handle) throw new DownloadRefused('Too many downloads with that name today.');

    let size = 0;
    let over = false;
    try {
      for await (const chunk of source as AsyncIterable<Buffer | string>) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > limit) { over = true; break; }
        await handle.write(buffer);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    } finally {
      if (over) (source as Readable).destroy?.();
    }
    await handle.close();
    if (over || size === 0) {
      await unlink(target).catch(() => undefined);
      if (size === 0) throw new DownloadRefused('The download was empty.');
      throw limit === this.fileCap
        ? new DownloadRefused(`That download is larger than ${kb(this.fileCap)}, the most agents may download per file.`)
        : new DownloadRefused(`This agent's downloads area is full (${kb(used)} of ${kb(this.agentCap)}). The owner can clear it in Settings → Browser.`);
    }
    // Never executable, whatever the umask or the server said.
    await chmod(target, 0o600);
    const filename = path.basename(target);
    return { path: target, filename, size, mime: downloadMime(filename, pending.mime), url: pending.url, agent };
  }

  /** What the area holds, by agent. */
  async usage(): Promise<DownloadUsage> {
    const agents: DownloadUsage['agents'] = [];
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { /* nothing yet */ }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tally = await this.#tally(path.join(this.root, entry.name));
      if (tally.files > 0) agents.push({ agent: entry.name, ...tally });
    }
    agents.sort((a, b) => b.bytes - a.bytes);
    return {
      bytes: agents.reduce((sum, a) => sum + a.bytes, 0), files: agents.reduce((sum, a) => sum + a.files, 0), agents,
      fileCap: this.fileCap, agentCap: this.agentCap, retentionDays: this.retentionDays,
    };
  }

  /** Empty the area, or one agent's part of it. Files keeps its copies. */
  async clear(agent?: string): Promise<DownloadUsage> {
    if (agent === undefined) {
      let entries: string[] = [];
      try { entries = await readdir(this.root); } catch { /* nothing yet */ }
      for (const name of entries) await rm(path.join(this.root, name), { recursive: true, force: true });
    } else {
      await rm(path.join(this.root, agentFolder(agent)), { recursive: true, force: true });
    }
    return this.usage();
  }

  /** Remove every day older than the retention. Returns how many files went. */
  async sweep(): Promise<number> {
    const cutoff = this.#now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let agents: import('node:fs').Dirent[] = [];
    try { agents = await readdir(this.root, { withFileTypes: true }); } catch { return 0; }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const agentDir = path.join(this.root, agent.name);
      let days: import('node:fs').Dirent[] = [];
      try { days = await readdir(agentDir, { withFileTypes: true }); } catch { continue; }
      for (const day of days) {
        const full = path.join(agentDir, day.name);
        // A day folder is dated by its name, the end of that day; anything else by when it was last written.
        let at: number;
        if (day.isDirectory() && DAY.test(day.name)) at = Date.parse(`${day.name}T23:59:59.999Z`);
        else { try { at = (await stat(full)).mtimeMs; } catch { continue; } }
        if (!(at < cutoff)) continue;
        removed += day.isDirectory() ? (await this.#tally(full)).files : 1;
        await rm(full, { recursive: true, force: true });
      }
      try { if ((await readdir(agentDir)).length === 0) await rm(agentDir, { recursive: true, force: true }); } catch { /* fine */ }
    }
    return removed;
  }
}
