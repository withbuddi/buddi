/**
 * The vault: OS keychain first, encrypted file where there is no keychain.
 *
 * Which one a process gets is a machine fact, not an agent's choice:
 * `BUDDI_VAULT` names it explicitly (`keychain` | `file` | `memory` | `none`),
 * and otherwise macOS means the keychain and everything else means the file.
 */
import os from 'node:os';
import { createFileVault, defaultVaultFile, hasVaultKey } from './file.js';
import { createKeychainVault } from './keychain.js';
import { createMemoryVault } from './memory.js';
import type { Vault, VaultKind } from './types.js';

export * from './types.js';
export * from './resolve.js';
export {
  createFileVault,
  defaultVaultFile,
  generateVaultKey,
  hasVaultKey,
  sameSecret,
} from './file.js';
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
      return createKeychainVault({ service: env.BUDDI_VAULT_SERVICE });
    case 'file':
      return createFileVault({ env });
    case 'memory':
      return createMemoryVault();
    case 'none':
      return undefined;
  }
}

/**
 * The variable that *is* the file vault's key. Named once, so every message
 * that has to tell someone about it spells it the same way.
 */
export const VAULT_KEY_VAR = 'BUDDI_VAULT_KEY';

/**
 * What this machine's vault is, and whether it can be opened — without opening
 * it, and without touching a secret.
 *
 * This exists because "the file vault is locked" was, for a stranger on Linux,
 * indistinguishable from "buddi is broken": the message named a variable and no
 * command. Every surface that has to say something about the vault — the
 * doctor's row, `buddi init`, `buddi vault`, `buddi db secure` — asks this, so
 * they all say the same true thing and offer the same fix.
 */
export interface VaultState {
  selection: VaultSelection;
  /** True when a vault exists but has no key to open it. */
  locked: boolean;
  /** Where the file vault's bytes are, when that is the vault in use. */
  file?: string;
  /** One sentence naming the fix. Empty when there is nothing to fix. */
  advice: string;
}

export function vaultState(opts: CreateVaultOptions = {}): VaultState {
  const env = opts.env ?? process.env;
  const selection = vaultSelection(opts);
  if (selection !== 'file') return { selection, locked: false, advice: '' };
  const file = defaultVaultFile(env);
  if (hasVaultKey(env)) return { selection, locked: false, file, advice: '' };
  return {
    selection,
    locked: true,
    file,
    advice:
      `this machine has no keychain, so secrets live in an encrypted file at ${file} ` +
      `and ${VAULT_KEY_VAR} is the key that opens it. Run \`buddi init\` — it generates one ` +
      `and writes it to .env — or set ${VAULT_KEY_VAR} yourself.`,
  };
}
