/**
 * A private, disposable Codex profile for a caller that runs its own `codex`
 * child (the image plugin's `codex exec`). Chat does not use the binary; this
 * is the one remaining place a Codex credential is written to disk, and only
 * for as long as that child runs.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAuthJson, readCodexTokens, type CodexTokens } from './codex-oauth.js';

/**
 * The whole environment a native Codex child gets: a short allowlist, so no
 * ambient provider key (OPENAI_API_KEY and the like) and no owner CODEX_HOME
 * reaches it.
 */
export function codexChildEnv(profileDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.CODEX_HOME = profileDir;
  return env;
}

/** Clean only marked, private profiles whose parent AND native child have exited. */
export async function cleanupCodexSessions(root = tmpdir()): Promise<void> {
  const dead = (pid: unknown) => {
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
    try { process.kill(Number(pid), 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  for (const name of await readdir(root)) {
    if (!/^buddi-codex-session-[A-Za-z0-9]+$/.test(name)) continue;
    const dir = join(root, name);
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) continue;
      const marker = join(dir, 'owner.json');
      const markerStat = await lstat(marker);
      if (!markerStat.isFile() || markerStat.size > 1024) continue;
      const owner = JSON.parse(await readFile(marker, 'utf8')) as { version?: number; parent?: number; child?: number | null };
      if (owner.version === 1 && dead(owner.parent) && (owner.child === null || dead(owner.child))) await rm(dir, { recursive: true, force: true });
    } catch { /* Not a recognizable owned orphan. Never guess or broaden cleanup. */ }
  }
}

export interface StagedCodexProfile {
  home: string;
  workspace: string;
  env: Record<string, string>;
  /** The credential as the child left it (it may have refreshed). Call only after the child exited. */
  credential(): Promise<CodexTokens | null>;
  dispose(): Promise<void>;
}

export async function stageCodexProfile(tokens: CodexTokens): Promise<StagedCodexProfile> {
  if (process.platform === 'win32') throw new Error('A Codex profile needs a verified private-directory ACL on Windows before it can run.');
  await cleanupCodexSessions();
  const dir = await mkdtemp(join(tmpdir(), 'buddi-codex-session-'));
  const home = join(dir, 'profile');
  const workspace = join(dir, 'workspace');
  const authFile = join(home, 'auth.json');
  try {
    await chmod(dir, 0o700);
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ version: 1, parent: process.pid, child: null }), { mode: 0o600, flag: 'wx' });
    await writeFile(authFile, codexAuthJson(tokens), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    home, workspace, env: codexChildEnv(home),
    async credential() {
      if (disposed) throw new Error('Codex profile already disposed.');
      const stat = await lstat(authFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return null;
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid native credential file.');
      return readCodexTokens(await readFile(authFile, 'utf8'));
    },
    async dispose() {
      if (disposed) return;
      await rm(dir, { recursive: true, force: true });
      disposed = true;
    },
  };
}
