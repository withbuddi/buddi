/**
 * Open in app (docs/files.md, "Office documents"): a file in Files opened in
 * the owner's own app — Word, Excel, Numbers, LibreOffice — on the computer
 * buddi runs on, and what he saves there brought back as his next version.
 *
 * The newest version is exported to a working copy the server names itself,
 * `<data>/open/<fileId>/<name>` — nothing in a request is a path — and handed
 * to the system's default app (`open`, `xdg-open`, the Windows shell). The
 * copy is then watched: a change that has settled (an app writes in steps)
 * is imported through the one owner save (`saveOwnerBytes`, the file's lock,
 * over the version exported), so it is a version by `owner` like an edit on
 * the Canvas. A version saved meanwhile refuses it with the one conflict
 * shape, and the page offers Show theirs / Keep mine. Only the copy itself
 * is read; the app's lock and scratch files beside it (`~$Plan.docx`,
 * `.~lock.Plan.docx#`) are never imported, and say only that it is still open.
 *
 * A copy goes when it has been idle (no change, and no app's lock file
 * beside it) for two hours, after 24 hours whatever, and when the owner takes
 * theirs; a change not yet imported is imported first. Copies a previous run
 * left are swept at start once they are a day old.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  CHANGED_SINCE,
  currentVersion,
  extensionFor,
  getFile,
  nativeEnvironment,
  opensInApp,
  readArtifactBytes,
  resolveDataDir,
  safeFileName,
  type EnvLike,
} from '@buddi/core';
import { inside, isAnswer, linkOnTheWay, liveFile, saveOwnerBytes, versionRef, type Answer } from './file-content.js';

/** How the copy is handed to the owner's default app. Resolves once the opener accepted it. */
export type Launch = (file: string) => Promise<void>;

/** The opener for this platform, with only the desktop's own variables: never buddi's secrets. */
export function defaultLaunch(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Launch {
  const desktop = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];
  const childEnv = { ...nativeEnvironment(env), ...Object.fromEntries(desktop.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key] as string])) };
  // No shell anywhere: a file name is an argument, never a command line.
  const [command, args]: [string, (file: string) => string[]] = platform === 'darwin'
    ? ['open', (file) => [file]]
    : platform === 'win32'
      ? ['rundll32.exe', (file) => ['url.dll,FileProtocolHandler', file]]
      : ['xdg-open', (file) => [file]];
  return (file) => new Promise((resolve, reject) => {
    const child = spawn(command, args(file), { stdio: 'ignore', detached: true, windowsHide: true, env: childEnv });
    const timer = setTimeout(() => { child.unref(); resolve(); }, 10_000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || platform === 'win32') resolve();
      else reject(new Error(`the opener said ${code}`));
    });
  });
}

/** An app's lock or scratch file beside a document: never the document. */
export function isAppScratch(name: string): boolean {
  return name.startsWith('~$') || name.startsWith('.~lock.') || name.startsWith('.') || /\.(tmp|temp|bak|wbk)$/i.test(name) || name.endsWith('~');
}

interface Session {
  fileId: string;
  /** The folder the copy is in, `<data>/open/<fileId>`. */
  dir: string;
  /** The copy. */
  file: string;
  name: string;
  /** The version the copy is based on: what an import names as its base. */
  base: number;
  /** The bytes buddi last put there or brought back, by hash. */
  known: string;
  openedAt: number;
  /** The last time the copy changed. */
  activeAt: number;
  /** What the copy looked like at the last look, and since when. */
  seen: { size: number; mtimeMs: number; since: number } | null;
  /** An import refused: what won, and the bytes waiting (by hash). */
  conflict: { conflict: 'newer' | 'workspace'; current: ReturnType<typeof versionRef>; sha256: string } | null;
  /** The last version brought back. */
  saved: { version: number; at: number } | null;
  /** Taken back by an import in progress: no second one starts. */
  busy: boolean;
  deleted: boolean;
}

export interface OpenInAppOptions {
  pool: Pool;
  env: EnvLike;
  ownerId: string;
  launch?: Launch;
  now?: () => number;
  /** How often the copies are looked at. */
  pollMs?: number;
  /** How long a change must hold still before it is imported. */
  settleMs?: number;
  /** A copy with no change and no app's lock this long is closed. */
  idleMs?: number;
  /** A copy is closed after this, whatever. */
  maxAgeMs?: number;
}

const HOUR = 60 * 60 * 1000;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class OpenInApp {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;
  private readonly launch: Launch;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly idleMs: number;
  private readonly maxAgeMs: number;

  constructor(private readonly opts: OpenInAppOptions) {
    this.launch = opts.launch ?? defaultLaunch(process.platform, process.env);
    this.now = opts.now ?? Date.now;
    this.settleMs = opts.settleMs ?? 1_500;
    this.idleMs = opts.idleMs ?? 2 * HOUR;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * HOUR;
    this.timer = setInterval(() => { void this.lookAll(); }, opts.pollMs ?? 1_000);
    this.timer.unref();
    this.sweeper = setInterval(() => { void this.sweep(); }, 10 * 60 * 1000);
    this.sweeper.unref();
    void this.sweepLeftovers().catch(() => {});
  }

  /** Stop watching (the server is closing). Copies stay for the next start's sweep. */
  close(): void {
    clearInterval(this.timer);
    clearInterval(this.sweeper);
  }

  /** `<data>/open`, as a real path: the one root every copy lies under. */
  private async root(): Promise<string> {
    const data = await realpath(resolveDataDir(this.opts.env));
    return path.join(data, 'open');
  }

  /**
   * `POST /api/files/:id/open`: the newest version as a working copy, handed
   * to the owner's app. Open already: the same copy again, brought up to the
   * newest version first when nothing in it changed.
   */
  async open(id: string): Promise<Answer> {
    const found = await liveFile(this.opts.pool, id);
    if (isAnswer(found)) return found;
    const { file, current } = found;
    if (!opensInApp(file.mime, file.name)) return { status: 415, body: { error: 'only an Office document opens in an app from here' } };
    const root = await this.root();
    const dir = path.join(root, file.id);
    const stem = (file.name ?? 'Document').replace(/\.[A-Za-z0-9]{1,8}$/, '');
    const name = `${safeFileName(stem, 100, 'Document')}.${extensionFor(file.mime, file.name)}`;
    const copy = path.join(dir, name);
    if (!inside(root, copy) || path.dirname(copy) !== dir) return { status: 400, body: { error: 'this file cannot be opened here' } };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Never through a link: every folder from the data dir down is looked at.
    if ((await linkOnTheWay(path.dirname(root), dir)) !== null) return { status: 409, body: { error: 'buddi’s folder for opened files is a link, so nothing was opened' } };

    const held = this.sessions.get(file.id);
    const there = await this.copyHash(copy);
    // Open already, with nothing in the copy buddi did not put there: brought up to the newest version.
    const stale = held !== undefined && there === held.known && !held.conflict && held.base !== current.version;
    if (!held || there === null || stale) {
      const bytes = await readArtifactBytes(this.opts.env, current);
      await this.writeCopy(copy, bytes);
      const at = this.now();
      const info = await stat(copy);
      this.sessions.set(file.id, {
        fileId: file.id, dir, file: copy, name, base: current.version, known: sha256(bytes), openedAt: held?.openedAt ?? at, activeAt: at,
        seen: { size: info.size, mtimeMs: info.mtimeMs, since: at }, conflict: null, saved: held?.saved ?? null, busy: false, deleted: false,
      });
    }
    const session = this.sessions.get(file.id)!;
    try {
      await this.launch(session.file);
    } catch (err) {
      return { status: 502, body: { error: `No app on this computer opened ${session.name} (${err instanceof Error ? err.message : String(err)}).` } };
    }
    return this.answer(session);
  }

  /** `GET /api/files/:id/open`: whether the file is open in an app, and what came back. */
  async status(id: string): Promise<Answer> {
    const fileId = await this.fileIdOf(id);
    const session = fileId ? this.sessions.get(fileId) : undefined;
    if (!session) return { status: 200, body: { open: false } };
    await this.look(session);
    return this.answer(session);
  }

  /**
   * `POST /api/files/:id/open/resolve`: after a refused import, keep his
   * (`mine`: the copy saved over the version that won) or theirs (the copy
   * is closed; the newest version stays as it is).
   */
  async resolve(id: string, body: Record<string, unknown>): Promise<Answer> {
    const keep = body.keep;
    if (keep !== 'mine' && keep !== 'theirs') return { status: 400, body: { error: "`keep` must be 'mine' or 'theirs'" } };
    const fileId = await this.fileIdOf(id);
    const session = fileId ? this.sessions.get(fileId) : undefined;
    if (!session) return { status: 404, body: { error: 'this file is not open in an app' } };
    if (keep === 'theirs') {
      await this.end(session, false);
      return { status: 200, body: { open: false, closed: true } };
    }
    if (!session.conflict) return this.answer(session);
    const conflict = session.conflict;
    session.base = conflict.current.version;
    session.conflict = null;
    await this.importCopy(session, { overwriteWorkspace: conflict.conflict === 'workspace' });
    return this.answer(session);
  }

  /** Look at every copy once: what the poll does, and what a test calls. */
  async lookAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.look(session).catch(() => {})));
  }

  /** Close the copies that are idle or a day old, importing a change first. */
  async sweep(): Promise<void> {
    const at = this.now();
    for (const session of [...this.sessions.values()]) {
      const old = at - session.openedAt >= this.maxAgeMs;
      const idle = at - session.activeAt >= this.idleMs && !(await this.appHoldsIt(session));
      if (old || idle) await this.end(session, true);
    }
  }

  private async fileIdOf(id: string): Promise<string | null> {
    const found = await liveFile(this.opts.pool, id);
    if (!isAnswer(found)) return found.file.id;
    // A deleted file's copy is still known by its id.
    return this.sessions.has(id) ? id : null;
  }

  private answer(session: Session): Answer {
    return {
      status: 200,
      body: {
        open: true, fileId: session.fileId, name: session.name, base: session.base,
        ...(session.saved ? { savedVersion: session.saved.version, savedAt: new Date(session.saved.at).toISOString() } : {}),
        ...(session.conflict ? { conflict: session.conflict.conflict, current: session.conflict.current, error: `${CHANGED_SINCE}: v${session.conflict.current.version} is newer.` } : {}),
        ...(session.deleted ? { deleted: true } : {}),
      },
    };
  }

  private async copyHash(file: string): Promise<string | null> {
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile()) return null;
    return sha256(await readFile(file));
  }

  /** Bytes put in place whole: staged beside the copy, renamed over it. */
  private async writeCopy(file: string, bytes: Buffer): Promise<void> {
    const leaf = await lstat(file).catch(() => null);
    if (leaf && !leaf.isFile()) throw new Error('the working copy is not a file');
    const staged = path.join(path.dirname(file), `.${path.basename(file)}.buddi-${process.pid}-${this.now()}`);
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
    await rename(staged, file);
  }

  /** One look at a copy: a change is imported once it held still for `settleMs`. */
  private async look(session: Session): Promise<void> {
    if (session.busy || session.deleted) return;
    const info = await lstat(session.file).catch(() => null);
    // Gone (an app saving by replacing it) or not a plain file: nothing to read this time.
    if (!info || !info.isFile()) { session.seen = null; return; }
    const at = this.now();
    const same = session.seen && session.seen.size === info.size && session.seen.mtimeMs === info.mtimeMs;
    if (!same) {
      session.seen = { size: info.size, mtimeMs: info.mtimeMs, since: at };
      session.activeAt = at;
      if (this.settleMs > 0) return;
    }
    if (at - session.seen!.since < this.settleMs || info.size === 0) return;
    const bytes = await readFile(session.file);
    const hash = sha256(bytes);
    if (hash === session.known || hash === session.conflict?.sha256) return;
    await this.importCopy(session, {}, bytes);
  }

  /** The copy as the owner's next version over `base`, through the one owner save. */
  private async importCopy(session: Session, opts: { overwriteWorkspace?: boolean }, given?: Buffer): Promise<void> {
    session.busy = true;
    try {
      const bytes = given ?? await readFile(session.file);
      const file = await getFile(this.opts.pool, session.fileId);
      if (!file || file.deletedAt !== null || !(await currentVersion(this.opts.pool, file.id))) { session.deleted = true; return; }
      const out = await saveOwnerBytes(this.opts.pool, this.opts.env, file, { bytes, base: session.base, ...(opts.overwriteWorkspace ? { overwriteWorkspace: true } : {}) }, this.opts.ownerId);
      const body = out.body as { version?: number; conflict?: string; current?: ReturnType<typeof versionRef>; deleted?: boolean };
      if (out.status === 200 && typeof body.version === 'number') {
        session.base = body.version;
        session.known = sha256(bytes);
        session.saved = { version: body.version, at: this.now() };
        session.conflict = null;
      } else if (out.status === 409 && (body.conflict === 'newer' || body.conflict === 'workspace') && body.current) {
        session.conflict = { conflict: body.conflict, current: body.current, sha256: sha256(bytes) };
      } else if (out.status === 404) {
        session.deleted = true;
      }
      // 'busy' (a command is running): the next look tries again.
    } finally {
      session.busy = false;
    }
  }

  /** Is an app still holding the copy: its lock file beside it. */
  private async appHoldsIt(session: Session): Promise<boolean> {
    const names = await readdir(session.dir).catch(() => [] as string[]);
    return names.some((name) => name !== session.name && isAppScratch(name) && (name.startsWith('~$') || name.startsWith('.~lock.')));
  }

  /** The copy goes; with `importFirst`, a change not yet brought back is imported first. */
  private async end(session: Session, importFirst: boolean): Promise<void> {
    if (importFirst && !session.conflict && !session.deleted) {
      const hash = await this.copyHash(session.file);
      if (hash !== null && hash !== session.known) await this.importCopy(session, {});
      // Refused meanwhile: his change stays on disk until he chooses.
      if (session.conflict) return;
    }
    this.sessions.delete(session.fileId);
    const root = await this.root().catch(() => null);
    if (root && inside(root, session.dir)) await rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }

  /** Folders a previous run left under `open/`, once a day old. */
  private async sweepLeftovers(): Promise<void> {
    const root = await this.root().catch(() => null);
    if (!root) return;
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names) {
      if (this.sessions.has(name)) continue;
      const dir = path.join(root, name);
      const info = await lstat(dir).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink() || this.now() - info.mtimeMs >= this.maxAgeMs) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
