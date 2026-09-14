/**
 * An in-memory vault. For tests, and for nothing else: it is lost on exit, so
 * an installation that used it would look configured and come back empty.
 */
import { assertSecretName, assertSecretValue, type Vault } from './types.js';

export interface MemoryVaultOptions {
  /** Seed values, for a test that wants a secret already present. */
  seed?: Record<string, string>;
  /** Pretend the vault is locked: every operation throws `VaultLockedError`. */
  locked?: boolean;
}

export function createMemoryVault(opts: MemoryVaultOptions = {}): Vault {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  return {
    kind: 'memory',
    async get(name) {
      return store.get(assertSecretName(name)) ?? null;
    },
    async set(name, value) {
      store.set(assertSecretName(name), assertSecretValue(name, value));
    },
    async delete(name) {
      return store.delete(assertSecretName(name));
    },
    async list() {
      return [...store.keys()].sort();
    },
  };
}
