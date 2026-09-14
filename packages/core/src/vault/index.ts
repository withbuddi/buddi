/**
 * The vault: OS keychain first, encrypted file where there is no keychain.
 *
 * Which one a process gets is a machine fact, not an agent's choice:
 * `BUDDI_VAULT` names it explicitly (`keychain` | `file` | `memory` | `none`),
 * and otherwise macOS means the keychain and everything else means the file.
 */
import os from 'node:os';
import { createFileVault } from './file.js';
import { createKeychainVault } from './keychain.js';
import { createMemoryVault } from './memory.js';
import type { Vault, VaultKind } from './types.js';

export * from './types.js';
export * from './resolve.js';
export { createFileVault, defaultVaultFile, sameSecret } from './file.js';
export { createKeychainVault, defaultRunSecurity, INDEX_ACCOUNT } from './keychain.js';
export type { RunResult, RunSecurity } from './keychain.js';
export { createMemoryVault } from './memory.js';

export interface CreateVaultOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** What `BUDDI_VAULT` may say. `none` is "this process has no vault at all". */
export type VaultSelection = VaultKind | 'none';

export function vaultSelection(opts: CreateVaultOptions = {}): VaultSelection {
  const env = opts.env ?? process.env;
  const explicit = (env.BUDDI_VAULT ?? '').trim().toLowerCase();
  if (explicit === 'keychain' || explicit === 'file' || explicit === 'memory') return explicit;
  if (explicit === 'none' || explicit === 'off') return 'none';
  const platform = opts.platform ?? os.platform();
  return platform === 'darwin' ? 'keychain' : 'file';
}

/**
 * The vault this machine uses, or `undefined` when the owner turned it off —
 * in which case every secret comes from the environment, as on day 1.
 */
export function createVault(opts: CreateVaultOptions = {}): Vault | undefined {
  const env = opts.env ?? process.env;
  switch (vaultSelection(opts)) {
    case 'keychain':
      return createKeychainVault();
    case 'file':
      return createFileVault({ env });
    case 'memory':
      return createMemoryVault();
    case 'none':
      return undefined;
  }
}
