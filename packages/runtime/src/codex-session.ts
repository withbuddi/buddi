/** Native credentials are staged only in a private, disposable Codex profile. */
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CODEX_EXPERIMENT_CONFIG, codexConfigArgs } from './codex-policy.js';
import { spawnCodexRpc, type CodexRpc } from './codex-rpc.js';

export interface CodexSession {
  rpc: CodexRpc;
  cwd: string;
  /** Call only after the child has stopped, so refreshed credentials are stable. */
  credential(): Promise<string | null>;
  dispose(): Promise<void>;
}

/** Shape validation only; never decode, log or expose the tokens. */
export function validateCodexCredential(value: string): string {
  try {
    // macOS `security -w` hex-encodes passwords containing control characters,
    // including the newlines in Codex's pretty-printed auth.json. Decode only
    // here, where a subscription JSON envelope is expected: a generic vault
    // reader must not reinterpret an ordinary API key that happens to be hex.
    if (Buffer.byteLength(value) > 128 * 1024) throw new Error();
    if (/^(?:[0-9a-f]{2})+$/i.test(value)) {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex'));
    }
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error();
    const data = JSON.parse(value) as Record<string, unknown>;
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || data.OPENAI_API_KEY ||
      (data.auth_mode !== undefined && data.auth_mode !== 'chatgpt')) throw new Error();
    // Persist one line so subsequent Keychain reads don't need the legacy
    // decoding path. Preserve all native fields, including refresh metadata.
    return JSON.stringify(data);
  } catch { throw new Error('Invalid Codex subscription credential. Reconnect the account.'); }
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

export async function openCodexSession(credential: string | null, executable = 'codex'): Promise<CodexSession> {
  if (process.platform === 'win32') throw new Error('Codex experiment needs a verified private-directory ACL on Windows before it can run.');
  if (credential !== null) credential = validateCodexCredential(credential);
  // Do not silently accept changed native tool behavior after a binary update.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const version = await promisify(execFile)(executable, ['--version'], { env, timeout: 5_000, maxBuffer: 4096 })
    .catch(() => { throw new Error('Codex executable is missing or unavailable on the host.'); });
  if (version.stdout.trim() !== 'codex-cli 0.155.0') throw new Error('Codex experiment requires the verified CLI version 0.155.0.');
  await cleanupCodexSessions();
  const dir = await mkdtemp(join(tmpdir(), 'buddi-codex-session-'));
  const profileDir = join(dir, 'profile');
  const cwd = join(dir, 'workspace');
  const authFile = join(profileDir, 'auth.json');
  let rpc: CodexRpc | undefined;
  try {
    await chmod(dir, 0o700);
    await mkdir(profileDir, { mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ version: 1, parent: process.pid, child: null }), { mode: 0o600, flag: 'wx' });
    if (credential !== null) await writeFile(authFile, credential, { mode: 0o600, flag: 'wx' });
    rpc = spawnCodexRpc({ executable, profileDir, cwd, args: codexConfigArgs(CODEX_EXPERIMENT_CONFIG) });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ version: 1, parent: process.pid, child: rpc.processId ?? null }), { mode: 0o600 });
    let disposed = false;
    return {
      rpc, cwd,
      async credential() {
        if (disposed) throw new Error('Codex session already disposed.');
        const stat = await lstat(authFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return null;
        if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid native credential file.');
        return validateCodexCredential(await readFile(authFile, 'utf8'));
      },
      async dispose() {
        if (disposed) return;
        // If the process cannot be stopped, retain its private directory: never
        // pretend cleanup succeeded while a process may recreate credential files.
        await rpc!.close();
        await rm(dir, { recursive: true, force: true });
        disposed = true;
      },
    };
  } catch (error) {
    if (rpc) await rpc.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
