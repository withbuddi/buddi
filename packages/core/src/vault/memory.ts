/**
 * An in-memory vault. For tests, and for nothing else: it is lost on exit, so
 * an installation that used it would look configured and come back empty.
 */
import { assertSecretName, assertSecretValue, VaultLockedError, type Vault } from './types.js';

export interface MemoryVaultOptions {
  /** Seed values, for a test that wants a secret already present. */
  seed?: Record<string, string>;
  /** Pretend the vault is locked: every operation throws `VaultLockedError`. */
  locked?: boolean;
}

export function createMemoryVault(opts: MemoryVaultOptions = {}): Vault {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  /** A locked vault answers nothing — not even a name. Fail closed, like the real ones. */
  const openOrThrow = (): void => {
    if (opts.locked) throw new VaultLockedError('the memory vault is locked');
  };
  return {
    kind: 'memory',
    async get(name) {
      openOrThrow();
      return store.get(assertSecretName(name)) ?? null;
    },
    async set(name, value) {
      openOrThrow();
      store.set(assertSecretName(name), assertSecretValue(name, value));
    },
    async delete(name) {
      openOrThrow();
      return store.delete(assertSecretName(name));
    },
    async list() {
      openOrThrow();
      return [...store.keys()].sort();
    },
  };
}
