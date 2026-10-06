/**
 * The agents' downloads area (docs/browser.md, "Downloads").
 *
 * A file a page hands an agent — the bank's transactions CSV, a statement PDF —
 * lands here first, under `<data>/downloads/<agent>/<yyyy-mm-dd>/`, and the
 * browser service then registers it in Files so the agent can pass its id to a
 * plugin's import tool, and removes it from here: Files holds the one kept copy.
 * What stays is only what failed to register; that is swept after thirty days,
 * and the owner can clear it from Settings → Browser.
 *
 * Three rules hold for every file: it is never executable (written 0600, the
 * exec bit never set), no single file is larger than the per-file cap, and no
 * agent keeps more than its cap here. A download that would break one is
 * refused with a sentence the agent can repeat, and nothing partial is left.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

export const DOWNLOAD_FILE_CAP = 50 * 1024 * 1024;
export const DOWNLOAD_AGENT_CAP = 500 * 1024 * 1024;
export const DOWNLOAD_RETENTION_DAYS = 30;
/** A finished file in the owner's own Downloads folder counts only this soon after it was written. */
export const OWNER_FILE_FRESH_MS = 15 * 60 * 1000;
/** How long buddi's browser may take over one download before it is stopped. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
/** How often a transfer's partial file is measured against the cap. */
export const DOWNLOAD_POLL_MS = 250;

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
  /**
   * Waits for the transfer to end: null when it finished, the browser's reason
   * when it gave up. Rejects with `DownloadRefused` when it was stopped on
   * purpose (over the cap, too slow).
   */
  failure?(): Promise<string | null>;
  /** Stop a transfer still running (the run was cancelled). */
  cancel?(): Promise<void>;
  /** Remove the browser's own copy once the file was taken or refused. Called in both cases. */
  cleanup?(): Promise<void>;
}

export interface StoredDownload { path: string; filename: string; size: number; mime: string; url: string; agent: string }

/** One file waiting in the area because it could not be filed: what Settings → Browser lists. */
export interface WaitingDownload {
  /** `<agent>/<day>/<name>`, the handle for File it. */
  id: string;
  agent: string;
  day: string;
  name: string;
  size: number;
  mime: string;
}

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
  /** The owner's home; `~` in the Chrome folder means it, and the folder defaults to `~/Downloads`. */
  homeDir?: string;
  /** The folder the owner's Chrome saves downloads to (setting `downloadsFolder`); a Chrome download is read only from inside it. */
  chromeFolder?: () => string | undefined;
  /** buddi's data dir: nothing under it is ever read as a Chrome download. */
  dataDir?: string;
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

/** `child` is `parent` or inside it (both already resolved). */
function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The resolved path when it exists, else the lexical one. */
async function resolvedOr(file: string): Promise<string> {
  try { return await realpath(file); } catch { return path.resolve(file); }
}

/**
 * Watch one transfer in buddi's own browser: stop it the moment its partial
 * file passes the cap, or when it runs past the timeout, so a huge or endless
 * response never fills the disk before the size check. The outcome is what
 * `PendingDownload.failure` hands the store.
 */
export function watchTransfer(options: {
  /** Settles when the browser is done with it: null, or why it failed. */
  done: Promise<string | null>;
  /** Bytes received so far, when they can be measured. */
  size(): Promise<number | undefined>;
  cancel(): Promise<void>;
  cap?: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string | null> {
  const cap = options.cap ?? DOWNLOAD_FILE_CAP;
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const outcome = new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(poll); settle();
    };
    const stop = (message: string) => finish(() => { void options.cancel().catch(() => undefined); reject(new DownloadRefused(message)); });
    const timer = setTimeout(() => stop(`It was still downloading after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes, so it was stopped.`), timeoutMs);
    const poll = setInterval(() => {
      void options.size().then((bytes) => {
        if (bytes !== undefined && bytes > cap) stop(`That download is larger than ${kb(cap)}, the most agents may download per file.`);
      }, () => undefined);
    }, options.pollMs ?? DOWNLOAD_POLL_MS);
    timer.unref?.(); poll.unref?.();
    options.done.then((reason) => finish(() => resolve(reason)), (error: unknown) => finish(() => resolve(error instanceof Error ? error.message : String(error))));
  });
  // Nobody may ask before it settles (the action ended first): never an unhandled rejection.
  outcome.catch(() => undefined);
  return outcome;
}

export class DownloadStore {
  readonly fileCap: number;
  readonly agentCap: number;
  readonly retentionDays: number;
  readonly #now: () => number;
  readonly #home: string;
  readonly #chromeFolder: () => string | undefined;
  readonly #dataDir: string | undefined;
  constructor(readonly root: string, options: DownloadStoreOptions = {}) {
    this.fileCap = options.fileCap ?? DOWNLOAD_FILE_CAP;
    this.agentCap = options.agentCap ?? DOWNLOAD_AGENT_CAP;
    this.retentionDays = options.retentionDays ?? DOWNLOAD_RETENTION_DAYS;
    this.#now = options.now ?? Date.now;
    this.#home = options.homeDir ?? os.homedir();
    this.#chromeFolder = options.chromeFolder ?? (() => undefined);
    this.#dataDir = options.dataDir;
  }

  /** The folder the owner's Chrome saves to: the setting, `~` expanded, else `~/Downloads`. */
  chromeFolder(): string {
    const set = this.#chromeFolder()?.trim();
    if (!set) return path.join(this.#home, 'Downloads');
    if (set === '~' || set.startsWith('~/')) return path.join(this.#home, set.slice(1));
    return path.resolve(set);
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

  /**
   * The finished file a Chrome download left, read only when it plainly is
   * that file: its complete path resolved (no symlinked folder can lead out),
   * inside the folder Chrome saves to, under no dot-directory and not in
   * buddi's data dir, a plain file written in the last minutes with the size
   * Chrome said. It is opened once, then checked and read through that one
   * descriptor, so nothing swapped in after the check is what gets read.
   */
  async #ownerFile(file: string, reported: number | undefined): Promise<Readable> {
    const folderWord = this.#chromeFolder()?.trim() ? 'your Chrome’s download folder' : 'your Downloads folder';
    const refuse = () => new DownloadRefused(`That download could not be read from ${folderWord}.`);
    if (!path.isAbsolute(file)) throw refuse();
    let real: string;
    let folder: string;
    try { real = await realpath(file); folder = await realpath(this.chromeFolder()); } catch { throw refuse(); }
    if (real === folder || !inside(real, folder)) throw refuse();
    for (const kept of [this.root, this.#dataDir]) if (kept && inside(real, await resolvedOr(kept))) throw refuse();
    if (path.dirname(real).split(path.sep).some((part) => part.startsWith('.'))) throw refuse();
    let link = true;
    try { link = (await lstat(file)).isSymbolicLink(); } catch { /* refused below */ }
    if (link) throw refuse();

    let handle: FileHandle;
    try { handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw refuse(); }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw refuse();
      // The descriptor is still the file at that resolved path: nothing was swapped between the check and the open.
      const again = await realpath(real).catch(() => '');
      const there = again === real ? await stat(real).catch(() => undefined) : undefined;
      if (!there || there.ino !== info.ino || there.dev !== info.dev) throw refuse();
      if (Math.abs(this.#now() - info.mtimeMs) > OWNER_FILE_FRESH_MS) throw refuse();
      if (reported !== undefined && reported >= 0 && info.size !== reported) throw refuse();
      if (info.size > this.fileCap) throw new DownloadRefused(`That download is ${kb(info.size)}; agents may download at most ${kb(this.fileCap)} per file.`);
      return handle.createReadStream({ start: 0, autoClose: true });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** Wait for the transfer to end, stopping it when the run is cancelled. */
  async #settle(pending: PendingDownload, signal: AbortSignal | undefined): Promise<void> {
    if (!pending.failure && !signal) return;
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DownloadRefused('The run was stopped, so the download was stopped too.'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    stopped.catch(() => undefined);
    try {
      const failure = await Promise.race([pending.failure?.() ?? Promise.resolve(null), stopped]).catch((error: unknown) => {
        if (error instanceof DownloadRefused) throw error;
        return null;
      });
      if (failure) throw new DownloadRefused(`The download did not finish: ${failure}.`);
    } catch (error) {
      if (signal?.aborted) await pending.cancel?.().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Copy one download into the agent's area for today. Refuses, and leaves nothing behind, when a cap is hit. */
  async save(agent: string, pending: PendingDownload, options: { signal?: AbortSignal } = {}): Promise<StoredDownload> {
    await this.#settle(pending, options.signal);
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

  /** The files waiting, newest day first. */
  async waiting(): Promise<WaitingDownload[]> {
    const found: WaitingDownload[] = [];
    let agents: import('node:fs').Dirent[] = [];
    try { agents = await readdir(this.root, { withFileTypes: true }); } catch { return found; }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      let days: import('node:fs').Dirent[] = [];
      try { days = await readdir(path.join(this.root, agent.name), { withFileTypes: true }); } catch { continue; }
      for (const day of days) {
        if (!day.isDirectory() || !DAY.test(day.name)) continue;
        let names: import('node:fs').Dirent[] = [];
        try { names = await readdir(path.join(this.root, agent.name, day.name), { withFileTypes: true }); } catch { continue; }
        for (const entry of names) {
          if (!entry.isFile()) continue;
          let size = 0;
          try { size = (await stat(path.join(this.root, agent.name, day.name, entry.name))).size; } catch { continue; }
          found.push({ id: `${agent.name}/${day.name}/${entry.name}`, agent: agent.name, day: day.name, name: entry.name, size, mime: downloadMime(entry.name) });
        }
      }
    }
    return found.sort((a, b) => b.day.localeCompare(a.day) || a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
  }

  /** The file behind a waiting id, or a refusal when the id is not one of the area's files. */
  async #waitingFile(id: string): Promise<{ path: string; agent: string; day: string; name: string }> {
    const parts = typeof id === 'string' ? id.split('/') : [];
    const [agent, day, name] = parts;
    if (parts.length !== 3 || !agent || !day || !name || agentFolder(agent) !== agent || !DAY.test(day) || name !== downloadName(name)) {
      throw new DownloadRefused('That file is not in the downloads area.');
    }
    const file = path.join(this.root, agent, day, name);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try { info = await lstat(file); } catch { /* below */ }
    if (!info?.isFile()) throw new DownloadRefused('That file is no longer in the downloads area.');
    return { path: file, agent, day, name };
  }

  /** Read one waiting file, to file it again. */
  async readWaiting(id: string): Promise<{ bytes: Buffer; agent: string; name: string; mime: string }> {
    const found = await this.#waitingFile(id);
    const handle = await open(found.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return { bytes: await handle.readFile(), agent: found.agent, name: found.name, mime: downloadMime(found.name) }; }
    finally { await handle.close(); }
  }

  /** Remove one waiting file (it was filed), and its day and agent folders once empty. */
  async removeWaiting(id: string): Promise<void> {
    const found = await this.#waitingFile(id);
    await unlink(found.path);
    const dayDir = path.dirname(found.path);
    try { if ((await readdir(dayDir)).length === 0) await rm(dayDir, { recursive: true, force: true }); } catch { /* fine */ }
    const agentDir = path.dirname(dayDir);
    try { if ((await readdir(agentDir)).length === 0) await rm(agentDir, { recursive: true, force: true }); } catch { /* fine */ }
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
