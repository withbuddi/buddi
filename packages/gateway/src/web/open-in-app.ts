/**
 * Open in app (docs/files.md, "Office documents"): a file in Files opened in
 * the owner's own app — Word, Excel, Numbers, LibreOffice — on the computer
 * buddi runs on, and what he saves there brought back as his next version.
 *
 * One session per file, its working copy and its record side by side in a
 * folder the server names itself, `<data>/open/<fileId>/`: the copy (the
 * file's own name, cleaned) and `.buddi.json` — the version the copy is
 * based on, what buddi last put there or brought back (hash, size, mtime),
 * and the session's state. The record survives a restart: the watch
 * resumes, and nothing a previous run left is overwritten or removed
 * unseen. Nothing in a request is a path.
 *
 * The rules, all of them under one lock per file (`lock`), taken before a
 * session is looked at:
 *
 *  - **Only whole saves come back.** A change must hold still, be read
 *    through a handle that follows no link and be the same file, size and
 *    time after the read, and be a whole package of its kind
 *    (`officePackageProblem`); otherwise it is looked at again later. It is
 *    imported through the one owner save (`saveOwnerBytes`, the file's lock,
 *    over the version the copy is based on) as a version by `owner`.
 *  - **A refused save waits.** A version saved meanwhile refuses it with the
 *    one conflict shape; the page offers Keep mine (saved over it) or Show
 *    theirs, which stops the watch but keeps the copy, with Save mine as new
 *    file while it holds work Files does not have.
 *  - **Unimported work is never removed.** A copy is removed only when it
 *    holds exactly what Files has and no app holds it (its lock file,
 *    `~$Plan.docx`, `.~lock.Plan.docx#`, is beside it): after two idle
 *    hours, after a day, or once he took theirs. Reopening never writes over
 *    a copy that holds anything else; it is imported, or raises the bar.
 *  - **Never through a link.** Every access checks each folder from the data
 *    dir down with lstat (a link or a junction is refused) and reads the
 *    copy without following one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open as openFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  CHANGED_SINCE,
  currentVersion,
  extensionFor,
  getFile,
  nativeEnvironment,
  officeKindOf,
  officePackageProblem,
  opensInApp,
  readArtifactBytes,
  recordArtifactUse,
  resolveDataDir,
  safeFileName,
  saveNewFile,
  type EnvLike,
  type FileRecord,
} from '@buddi/core';
import { isAnswer, linkOnTheWay, liveFile, saveOwnerBytes, versionRef, type Answer } from './file-content.js';

/** What an opener said: it handed the file over, or it did not answer in time. */
export type Launched = 'opened' | 'unconfirmed';
/** How the copy is handed to the owner's default app. Rejects when the opener refused it. */
export type Launch = (file: string) => Promise<Launched>;

/**
 * The opener for this platform, with only the desktop's own variables: never
 * buddi's secrets, and never a shell command line — on Windows the path
 * reaches PowerShell's Start-Process as an environment variable, not as code.
 * A nonzero exit is a failure everywhere; no answer in ten seconds is
 * "unconfirmed", not success.
 */
export function defaultLaunch(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Launch {
  const desktop = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];
  const base = { ...nativeEnvironment(env), ...Object.fromEntries(desktop.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key] as string])) };
  return (file) => {
    const [command, args, childEnv] = platform === 'darwin'
      ? ['open', [file], base] as const
      : platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:BUDDI_OPEN_FILE -ErrorAction Stop'], { ...base, BUDDI_OPEN_FILE: file }] as const
        : ['xdg-open', [file], base] as const;
    return runOpener(command, [...args], childEnv, timeoutMs);
  };
}

/** Run an opener: resolved when it exits 0, rejected on a nonzero exit, unconfirmed at the deadline. */
export function runOpener(command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Launched> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, env });
    const timer = setTimeout(() => { child.unref(); resolve('unconfirmed'); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve('opened');
      else reject(new Error(`the system's opener answered ${code ?? signal}`));
    });
  });
}

/** An app's lock or scratch file beside a document, or buddi's record: never the document. */
export function isAppScratch(name: string): boolean {
  return name.startsWith('~$') || name.startsWith('.') || /\.(tmp|temp|bak|wbk)$/i.test(name) || name.endsWith('~');
}

/** An app's lock file: it holds the document open. */
function isAppLock(name: string): boolean {
  return name.startsWith('~$') || name.startsWith('.~lock.');
}

const RECORD = '.buddi.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 60 * 60 * 1000;

type SessionState = 'watching' | 'conflict' | 'detached' | 'deleted';

/** What `.buddi.json` holds: enough to resume the session after a restart. */
interface SessionRecord {
  v: 1;
  fileId: string;
  /** The copy's name in its folder. */
  name: string;
  /** The version the copy is based on: what an import names as its base. */
  base: number;
  /** What buddi last put in the copy or brought back from it. */
  known: { sha256: string; size: number; mtimeMs: number };
  state: SessionState;
  /** An import refused: what won, and the bytes waiting (by hash). */
  conflict?: { conflict: 'newer' | 'workspace'; current: ReturnType<typeof versionRef>; sha256: string };
  /** The last version a save brought back. */
  saved?: { version: number; at: number };
  openedAt: number;
  activeAt: number;
}

interface Session extends SessionRecord {
  /** The copy's size and time at the last look, and since when they held. */
  seen: { size: number; mtimeMs: number; since: number } | null;
}

export interface OpenInAppOptions {
  pool: Pool;
  env: EnvLike;
  ownerId: string;
  launch?: Launch;
  now?: () => number;
  /** How often the copies are looked at. */
  pollMs?: number;
  /** How long a change must hold still before it is read. */
  settleMs?: number;
  /** A copy with nothing new, no app's lock and no change this long is removed. */
  idleMs?: number;
  /** A copy with nothing new and no app's lock is removed after this, whatever. */
  maxAgeMs?: number;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What reading the copy found. */
type Read =
  | { kind: 'ok'; bytes: Buffer; stat: Stats }
  | { kind: 'missing' }
  /** Being written: the file, its size or its time changed while it was read. */
  | { kind: 'changing' }
  | { kind: 'refused'; reason: string };

export class OpenInApp {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly timer: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;
  private readonly launch: Launch;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly idleMs: number;
  private readonly maxAgeMs: number;
  /** The sessions a previous run left, read back: every call waits for it. */
  readonly ready: Promise<void>;

  constructor(private readonly opts: OpenInAppOptions) {
    this.launch = opts.launch ?? defaultLaunch(process.platform, process.env);
    this.now = opts.now ?? Date.now;
    this.settleMs = opts.settleMs ?? 1_500;
    this.idleMs = opts.idleMs ?? 2 * HOUR;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * HOUR;
    this.ready = this.resume().catch(() => {});
    this.timer = setInterval(() => { void this.lookAll(); }, opts.pollMs ?? 1_000);
    this.timer.unref();
    this.sweeper = setInterval(() => { void this.sweep(); }, 10 * 60 * 1000);
    this.sweeper.unref();
  }

  /** Stop watching (the server is closing). Copies and records stay for the next start. */
  close(): void {
    clearInterval(this.timer);
    clearInterval(this.sweeper);
  }

  /**
   * One lock per file: whatever touches a session — open, a look, an import,
   * a choice, the sweep — runs after the one before it finished. Taken
   * synchronously, so nothing interleaves between the call and its first await.
   */
  private lock<T>(fileId: string, run: () => Promise<T>): Promise<T> {
    const before = this.locks.get(fileId) ?? Promise.resolve();
    const result = before.then(run, run);
    const tail = result.catch(() => {});
    this.locks.set(fileId, tail);
    void tail.then(() => { if (this.locks.get(fileId) === tail) this.locks.delete(fileId); });
    return result;
  }

  /* ---------------- paths, every one checked ---------------- */

  private async data(): Promise<string> {
    return realpath(resolveDataDir(this.opts.env));
  }

  /** A session's folder and copy, from its id and name only; null when either is not one. */
  private async where(fileId: string, name: string): Promise<{ data: string; dir: string; file: string } | null> {
    if (!UUID.test(fileId) || name === '' || name !== path.basename(name) || name.startsWith('.') || name.includes('\\')) return null;
    const data = await this.data();
    const dir = path.join(data, 'open', fileId);
    return { data, dir, file: path.join(dir, name) };
  }

  /** The session's folder, made when missing — every folder on the way checked before and after. */
  private async folder(data: string, dir: string): Promise<string | null> {
    for (const at of [path.join(data, 'open'), dir]) {
      const way = await linkOnTheWay(data, at);
      if (way === 'missing') await mkdir(at, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
      else if (way !== null) return 'its folder in buddi’s data is a link, so buddi did not use it';
      const info = await lstat(at);
      if (!info.isDirectory() || info.isSymbolicLink()) return 'its folder in buddi’s data is not a folder';
    }
    return (await linkOnTheWay(data, dir)) === null ? null : 'its folder in buddi’s data is a link, so buddi did not use it';
  }

  /**
   * The copy's bytes, read without following a link, and only if it was the
   * same file, size and time before and after: a save still being written
   * is `changing`, and looked at again later.
   */
  private async readCopy(fileId: string, name: string): Promise<Read> {
    const at = await this.where(fileId, name);
    if (!at) return { kind: 'refused', reason: 'not a working copy' };
    const way = await linkOnTheWay(at.data, at.file);
    if (way === 'missing') return { kind: 'missing' };
    if (way !== null) return { kind: 'refused', reason: 'the working copy or its folder is a link' };
    let handle;
    try {
      handle = await openFile(at.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing' };
      if (code === 'ELOOP') return { kind: 'refused', reason: 'the working copy is a link' };
      return { kind: 'changing' };
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { kind: 'refused', reason: 'the working copy is not a file' };
      const bytes = await handle.readFile();
      const after = await lstat(at.file).catch(() => null);
      if (!after || !after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.size !== bytes.length || after.mtimeMs !== before.mtimeMs) {
        return { kind: 'changing' };
      }
      if ((await linkOnTheWay(at.data, at.file)) !== null) return { kind: 'refused', reason: 'the working copy or its folder is a link' };
      return { kind: 'ok', bytes, stat: after };
    } finally {
      await handle.close();
    }
  }

  /** Bytes put in place whole, in a checked folder: staged beside, renamed over. */
  private async writeIn(fileId: string, name: string, bytes: Buffer): Promise<Stats> {
    const at = await this.where(fileId, name.startsWith('.') ? 'x' : name);
    if (!at) throw new Error('not a working copy');
    const target = path.join(at.dir, name);
    const problem = await this.folder(at.data, at.dir);
    if (problem) throw new Error(problem);
    const leaf = await lstat(target).catch(() => null);
    if (leaf && !leaf.isFile()) throw new Error('the working copy is not a file');
    const staged = path.join(at.dir, `.${name}.buddi-${randomUUID()}`);
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
    await rename(staged, target);
    return lstat(target);
  }

  private async persist(session: Session): Promise<void> {
    const { seen: _seen, ...record } = session;
    await this.writeIn(session.fileId, RECORD, Buffer.from(JSON.stringify(record)));
  }

  /** Is an app holding the copy: its lock file beside it. */
  private async appHolds(session: Session): Promise<boolean> {
    const at = await this.where(session.fileId, session.name);
    if (!at || (await linkOnTheWay(at.data, at.dir)) !== null) return true;
    const names = await readdir(at.dir).catch(() => [] as string[]);
    return names.some(isAppLock);
  }

  /** The folder goes — only a checked one, never through a link. */
  private async remove(session: Session): Promise<void> {
    this.sessions.delete(session.fileId);
    const at = await this.where(session.fileId, session.name);
    if (at && (await linkOnTheWay(at.data, at.dir)) === null) await rm(at.dir, { recursive: true, force: true });
  }

  /* ---------------- resuming ---------------- */

  /** The sessions a previous run left: each folder's record, read through the same checks. */
  private async resume(): Promise<void> {
    const data = await this.data();
    const root = path.join(data, 'open');
    if ((await linkOnTheWay(data, root)) !== null) return;
    for (const fileId of await readdir(root).catch(() => [] as string[])) {
      if (!UUID.test(fileId)) continue;
      const read = await this.readRecord(data, fileId).catch(() => null);
      if (read) this.sessions.set(fileId, { ...read, seen: null });
    }
  }

  private async readRecord(data: string, fileId: string): Promise<SessionRecord | null> {
    const file = path.join(data, 'open', fileId, RECORD);
    if ((await linkOnTheWay(data, file)) !== null) return null;
    const handle = await openFile(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const record = JSON.parse((await handle.readFile()).toString('utf8')) as SessionRecord;
      const states: SessionState[] = ['watching', 'conflict', 'detached', 'deleted'];
      if (record.v !== 1 || record.fileId !== fileId || typeof record.name !== 'string' || !Number.isInteger(record.base) || !states.includes(record.state)) return null;
      if (!(await this.where(fileId, record.name))) return null;
      return record;
    } finally {
      await handle.close();
    }
  }

  /* ---------------- the routes ---------------- */

  /**
   * `POST /api/files/:id/open`: the newest version as a working copy, handed
   * to the owner's app. A copy already there is never written over while it
   * holds anything Files does not: it is imported (or raises the bar), then
   * opened as it is. One that holds exactly what buddi put there is brought
   * up to the newest version first, unless an app holds it.
   */
  async open(id: string): Promise<Answer> {
    await this.ready;
    const found = await liveFile(this.opts.pool, id);
    if (isAnswer(found)) return found;
    return this.lock(found.file.id, async () => {
      const { file } = found;
      if (!opensInApp(file.mime, file.name)) return { status: 415, body: { error: 'only an Office document opens in an app from here' } };
      const current = await currentVersion(this.opts.pool, file.id);
      if (!current) return { status: 404, body: { error: 'this file was deleted from Files', deleted: true } };
      const stem = (file.name ?? 'Document').replace(/\.[A-Za-z0-9]{1,8}$/, '');
      const name = this.sessions.get(file.id)?.name ?? `${safeFileName(stem, 100, 'Document')}.${extensionFor(file.mime, file.name)}`;
      const at = await this.where(file.id, name);
      if (!at) return { status: 400, body: { error: 'this file cannot be opened here' } };
      try {
        const problem = await this.folder(at.data, at.dir);
        if (problem) return { status: 409, body: { error: problem } };
        let session = this.sessions.get(file.id);
        const there = await this.readCopy(file.id, name);
        if (there.kind === 'refused') return { status: 409, body: { error: `${there.reason}, so nothing was opened` } };
        if (there.kind === 'changing') return { status: 409, body: { error: 'the app is saving it right now; try again in a moment' } };
        const at0 = this.now();
        if (there.kind === 'missing') {
          // No copy: a fresh one of the newest version.
          const bytes = await readArtifactBytes(this.opts.env, current);
          const stat = await this.writeIn(file.id, name, bytes);
          session = {
            v: 1, fileId: file.id, name, base: current.version, known: { sha256: sha256(bytes), size: stat.size, mtimeMs: stat.mtimeMs },
            state: 'watching', openedAt: session?.openedAt ?? at0, activeAt: at0, seen: null, ...(session?.saved ? { saved: session.saved } : {}),
          };
        } else if (session && sha256(there.bytes) === session.known.sha256) {
          // Exactly what buddi put there: brought up to the newest, unless an app holds it.
          if (session.base !== current.version && !(await this.appHolds(session))) {
            const bytes = await readArtifactBytes(this.opts.env, current);
            const stat = await this.writeIn(file.id, name, bytes);
            session.base = current.version;
            session.known = { sha256: sha256(bytes), size: stat.size, mtimeMs: stat.mtimeMs };
          }
          if (session.state === 'detached') { session.state = 'watching'; delete session.conflict; }
        } else {
          // Work Files does not have — his, from before a restart or after Show theirs: brought back, or the bar.
          session = session ?? {
            v: 1, fileId: file.id, name, base: 0, known: { sha256: '', size: -1, mtimeMs: -1 },
            state: 'watching', openedAt: at0, activeAt: at0, seen: null,
          };
          if (session.state === 'detached' || session.state === 'deleted') session.state = 'watching';
          this.sessions.set(file.id, session);
          if (this.whole(file, there.bytes)) await this.importBytes(session, file, there.bytes, there.stat, {});
        }
        session.activeAt = at0;
        this.sessions.set(file.id, session);
        await this.persist(session);
        const launched = await this.launch(at.file);
        return this.answer(session, { launch: launched });
      } catch (err) {
        return { status: 502, body: { error: `${name} could not be opened in an app (${err instanceof Error ? err.message : String(err)}).` } };
      }
    });
  }

  /** `GET /api/files/:id/open`: whether the file is open in an app, and what came back. */
  async status(id: string): Promise<Answer> {
    await this.ready;
    const fileId = await this.fileIdOf(id);
    if (!fileId) return { status: 200, body: { open: false } };
    return this.lock(fileId, async () => {
      const session = this.sessions.get(fileId);
      if (!session) return { status: 200, body: { open: false } };
      await this.look(session);
      return this.answer(session, { unsaved: await this.unsaved(session) });
    });
  }

  /**
   * `POST /api/files/:id/open/resolve`: after a refused import, keep his
   * (`mine`: the copy saved over the version that won) or theirs (the watch
   * stops; the copy stays while it holds work Files does not have); `new`
   * keeps the copy as a new file of his, and then lets it go.
   */
  async resolve(id: string, body: { [key: string]: unknown }): Promise<Answer> {
    const keep = body.keep;
    if (keep !== 'mine' && keep !== 'theirs' && keep !== 'new') return { status: 400, body: { error: "`keep` must be 'mine', 'theirs' or 'new'" } };
    await this.ready;
    const fileId = await this.fileIdOf(id);
    if (!fileId) return { status: 404, body: { error: 'this file is not open in an app' } };
    return this.lock(fileId, async () => {
      const session = this.sessions.get(fileId);
      if (!session) return { status: 404, body: { error: 'this file is not open in an app' } };
      if (keep === 'theirs') {
        session.state = session.state === 'deleted' ? 'deleted' : 'detached';
        await this.persist(session);
        return this.answer(session, { unsaved: await this.unsaved(session) });
      }
      const read = await this.readCopy(fileId, session.name);
      if (read.kind !== 'ok') return { status: 409, body: { error: read.kind === 'refused' ? read.reason : 'the copy is being written or is gone; try again in a moment' } };
      const file = await getFile(this.opts.pool, fileId);
      if (!file) return { status: 404, body: { error: 'no such file' } };
      if (!this.whole(file, read.bytes)) return { status: 409, body: { error: 'the copy is not a whole document yet; save it again in the app' } };
      if (keep === 'mine') {
        const conflict = session.conflict;
        if (!conflict) return this.answer(session, {});
        session.base = conflict.current.version;
        await this.importBytes(session, file, read.bytes, read.stat, { overwriteWorkspace: conflict.conflict === 'workspace' });
        return this.answer(session, {});
      }
      // A new file of his, beside the one he opened: then nothing in the copy is unsaved.
      const stem = session.name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
      const ext = session.name.slice(stem.length);
      const saved = await saveNewFile(this.opts.pool, {
        bytes: read.bytes, mime: file.mime, name: `${stem} (your copy)${ext}`, createdBy: this.opts.ownerId, conversationId: file.conversationId,
        source: { surface: 'files', chatId: file.conversationId, messageId: randomUUID() },
      }, this.opts.env);
      if (file.conversationId) await recordArtifactUse(this.opts.pool, { artifactId: saved.row.id, conversationId: file.conversationId, kind: 'uploaded' });
      session.known = { sha256: sha256(read.bytes), size: read.stat.size, mtimeMs: read.stat.mtimeMs };
      delete session.conflict;
      session.state = 'detached';
      await this.persist(session);
      const savedAs = { fileId: saved.row.fileId, artifactId: saved.row.id, filename: saved.row.filename };
      if (!(await this.appHolds(session))) {
        await this.remove(session);
        return { status: 200, body: { open: false, closed: true, savedAs } };
      }
      return this.answer(session, { savedAs, unsaved: false });
    });
  }

  /** Look at every watched copy once: what the poll does. */
  async lookAll(): Promise<void> {
    await this.ready;
    await Promise.all([...this.sessions.keys()].map((fileId) => this.lock(fileId, async () => {
      const session = this.sessions.get(fileId);
      if (session) await this.look(session);
    }).catch(() => {})));
  }

  /**
   * Remove the copies that hold nothing Files lacks and that no app holds:
   * idle for `idleMs`, older than `maxAgeMs`, or after Show theirs. A change
   * not yet brought back is brought back first; one that cannot be stays.
   */
  async sweep(): Promise<void> {
    await this.ready;
    for (const fileId of [...this.sessions.keys()]) {
      await this.lock(fileId, async () => {
        const session = this.sessions.get(fileId);
        if (!session || (await this.appHolds(session))) return;
        const at = this.now();
        const due = session.state === 'detached' || at - session.openedAt >= this.maxAgeMs || at - session.activeAt >= this.idleMs;
        if (!due) return;
        if (session.state === 'watching') await this.look(session, { settled: true });
        if (await this.unsaved(session)) return;
        await this.remove(session);
      }).catch(() => {});
    }
  }

  /* ---------------- inside the lock ---------------- */

  private async fileIdOf(id: string): Promise<string | null> {
    if (this.sessions.has(id)) return id;
    const found = await liveFile(this.opts.pool, id);
    return isAnswer(found) ? null : found.file.id;
  }

  /** Bytes that are a whole document of the file's kind (a format buddi does not read: any bytes). */
  private whole(file: FileRecord, bytes: Buffer): boolean {
    if (bytes.length === 0) return false;
    const kind = officeKindOf(file.mime, file.name);
    return kind === null || officePackageProblem(bytes, kind) === null;
  }

  /** Does the copy hold anything Files does not (or can it not be told)? */
  private async unsaved(session: Session): Promise<boolean> {
    const read = await this.readCopy(session.fileId, session.name);
    if (read.kind === 'missing') return false;
    if (read.kind !== 'ok') return true;
    return sha256(read.bytes) !== session.known.sha256;
  }

  /** One look at a watched copy: a change is read once it held still for `settleMs`, and brought back if whole. */
  private async look(session: Session, opts: { settled?: boolean } = {}): Promise<void> {
    if (session.state !== 'watching') return;
    const at = await this.where(session.fileId, session.name);
    if (!at || (await linkOnTheWay(at.data, at.file)) !== null) { session.seen = null; return; }
    const info = await lstat(at.file).catch(() => null);
    if (!info || !info.isFile()) { session.seen = null; return; }
    const now = this.now();
    if (info.size === session.known.size && info.mtimeMs === session.known.mtimeMs) { session.seen = null; return; }
    const same = session.seen && session.seen.size === info.size && session.seen.mtimeMs === info.mtimeMs;
    if (!same) {
      session.seen = { size: info.size, mtimeMs: info.mtimeMs, since: now };
      session.activeAt = now;
      if (this.settleMs > 0 && !opts.settled) return;
    }
    if (!opts.settled && now - session.seen!.since < this.settleMs) return;
    const read = await this.readCopy(session.fileId, session.name);
    if (read.kind !== 'ok') return;
    const hash = sha256(read.bytes);
    if (hash === session.known.sha256) {
      // Touched, not changed.
      session.known = { sha256: hash, size: read.stat.size, mtimeMs: read.stat.mtimeMs };
      await this.persist(session);
      return;
    }
    const file = await getFile(this.opts.pool, session.fileId);
    if (!file) return;
    // Half written, or not this kind of document: looked at again later.
    if (!this.whole(file, read.bytes)) return;
    await this.importBytes(session, file, read.bytes, read.stat, {});
  }

  /** The copy as the owner's next version over `base`, through the one owner save; the outcome recorded. */
  private async importBytes(session: Session, file: FileRecord, bytes: Buffer, stat: Stats, opts: { overwriteWorkspace?: boolean }): Promise<void> {
    if (file.deletedAt !== null || !(await currentVersion(this.opts.pool, file.id))) {
      session.state = 'deleted';
      await this.persist(session);
      return;
    }
    const out = await saveOwnerBytes(this.opts.pool, this.opts.env, file, { bytes, base: session.base, ...(opts.overwriteWorkspace ? { overwriteWorkspace: true } : {}) }, this.opts.ownerId);
    const body = out.body as { version?: number; conflict?: string; current?: ReturnType<typeof versionRef> };
    if (out.status === 200 && typeof body.version === 'number') {
      session.base = body.version;
      session.known = { sha256: sha256(bytes), size: stat.size, mtimeMs: stat.mtimeMs };
      session.saved = { version: body.version, at: this.now() };
      session.state = 'watching';
      delete session.conflict;
    } else if (out.status === 409 && (body.conflict === 'newer' || body.conflict === 'workspace') && body.current) {
      session.state = 'conflict';
      session.conflict = { conflict: body.conflict, current: body.current, sha256: sha256(bytes) };
    } else if (out.status === 404) {
      session.state = 'deleted';
    } else {
      // 'busy' (a command is running): the next look tries again.
      return;
    }
    session.seen = null;
    await this.persist(session);
  }

  private answer(session: Session, extra: { [key: string]: unknown }): Answer {
    const conflict = session.state === 'conflict' ? session.conflict : undefined;
    return {
      status: 200,
      body: {
        open: true, fileId: session.fileId, name: session.name, base: session.base, state: session.state,
        ...(session.saved ? { savedVersion: session.saved.version, savedAt: new Date(session.saved.at).toISOString() } : {}),
        ...(conflict ? { conflict: conflict.conflict, current: conflict.current, error: `${CHANGED_SINCE}: v${conflict.current.version} is newer.` } : {}),
        ...(session.state === 'deleted' ? { deleted: true } : {}),
        ...extra,
      },
    };
  }
}
