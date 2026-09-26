/**
 * The macOS keychain vault, driven through the `security` CLI.
 *
 *   security add-generic-password -U -s buddi -a <name> -w <value>
 *   security find-generic-password    -s buddi -a <name> -w
 *   security delete-generic-password  -s buddi -a <name>
 *
 * No shell is involved (`execFile`, an argv array), so a value containing
 * quotes, `$` or newlines is stored verbatim. The one honest caveat: `security`
 * takes the value as an argument, so it is briefly visible in `ps` to the same
 * user — acceptable for a single-owner machine, and noted rather than hidden.
 *
 * `security` has no "list the accounts under a service" that does not dump the
 * whole keychain (which prompts, and prints far more than buddi's own
 * secrets), so the vault keeps its own index *inside the keychain*, under a
 * reserved account name. The index holds names only.
 */
import { execFile } from 'node:child_process';
import {
  assertSecretName,
  assertSecretValue,
  VAULT_SERVICE,
  VaultLockedError,
  VaultUnavailableError,
  type Vault,
} from './types.js';

/** The reserved account that holds the name index. Never a real secret name. */
export const INDEX_ACCOUNT = 'buddi.index';

/** `security` exit codes buddi distinguishes. */
const ERR_NOT_FOUND = 44;
/** "User interaction is not allowed" / "authorization denied" — a locked vault. */
const LOCKED_CODES = new Set([45, 51, 36]);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How the vault runs `security`. Injected in tests; never a shell. */
export type RunSecurity = (args: readonly string[]) => Promise<RunResult>;

export const defaultRunSecurity: RunSecurity = (args) =>
  new Promise((resolve, reject) => {
    execFile('security', [...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code;
      if (err && (code === 'ENOENT' || code === undefined)) {
        // No `security` binary at all: this machine has no keychain vault.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new VaultUnavailableError('the macOS `security` command is not available'));
          return;
        }
      }
      resolve({
        code: typeof code === 'number' ? code : err ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });

export interface KeychainVaultOptions {
  service?: string;
  run?: RunSecurity;
}

function failed(action: string, name: string, res: RunResult): Error {
  if (LOCKED_CODES.has(res.code)) {
    return new VaultLockedError(
      `the keychain refused to ${action} ${name} (security exit ${res.code}) — unlock it with: security unlock-keychain ~/Library/Keychains/login.keychain-db, then try again`,
    );
  }
  // `stderr` from `security` names the service and account, never the value.
  return new VaultUnavailableError(
    `keychain ${action} of ${name} failed (security exit ${res.code}): ${res.stderr.trim() || 'no detail'}`,
  );
}

export function createKeychainVault(opts: KeychainVaultOptions = {}): Vault {
  const service = opts.service ?? VAULT_SERVICE;
  const run = opts.run ?? defaultRunSecurity;

  const read = async (account: string): Promise<string | null> => {
    const res = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (res.code === ERR_NOT_FOUND) return null;
    if (res.code !== 0) throw failed('read', account, res);
    // `-w` prints the password and a trailing newline; a value never ends in one.
    return res.stdout.replace(/\n$/, '');
  };

  const put = async (account: string, value: string): Promise<void> => {
    const res = await run([
      'add-generic-password',
      '-U',
      '-s',
      service,
      '-a',
      account,
      '-w',
      value,
    ]);
    if (res.code !== 0) throw failed('write', account, res);
  };

  const drop = async (account: string): Promise<boolean> => {
    const res = await run(['delete-generic-password', '-s', service, '-a', account]);
    if (res.code === ERR_NOT_FOUND) return false;
    if (res.code !== 0) throw failed('delete', account, res);
    return true;
  };

  const names = async (): Promise<string[]> => {
    const raw = await read(INDEX_ACCOUNT);
    if (raw === null || raw.trim() === '') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      return [];
    }
  };

  const writeNames = async (list: readonly string[]): Promise<void> => {
    await put(INDEX_ACCOUNT, JSON.stringify([...new Set(list)].sort()));
  };

  return {
    kind: 'keychain',
    async get(name) {
      return read(assertSecretName(name));
    },
    async set(name, value) {
      assertSecretName(name);
      assertSecretValue(name, value);
      await put(name, value);
      const list = await names();
      if (!list.includes(name)) await writeNames([...list, name]);
    },
    async delete(name) {
      assertSecretName(name);
      const removed = await drop(name);
      const list = await names();
      if (list.includes(name)) await writeNames(list.filter((n) => n !== name));
      return removed;
    },
    async list() {
      return (await names()).filter((n) => n !== INDEX_ACCOUNT).sort();
    },
  };
}
