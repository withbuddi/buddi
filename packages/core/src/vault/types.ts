/**
 * The vault port (ARCHITECTURE.md, "Secrets and operations").
 *
 * A secrets *table* would hand mail and model credentials to anyone with the
 * database file, so secrets never live in Postgres. They live in the OS
 * keychain, or — where there is no keychain (CI, a Linux box, a test) — in a
 * file encrypted with a key held outside the database.
 *
 * Three rules hold for every implementation:
 *
 *  - **Values are never logged.** Not on success, not in an error message, not
 *    in a thrown stack. Errors name the *secret*, never its content.
 *  - **Locked is a typed problem, not a hang.** An unattended mission that
 *    needs a locked vault fails with `VaultLockedError`; it does not prompt,
 *    and it does not wait for a human who is asleep.
 *  - **Absent is `null`, not an error.** "This machine has no such secret" is a
 *    configuration fact the caller decides about — usually by falling back to
 *    the environment (the documented day-1 path) and failing closed after that.
 */

export type VaultKind = 'keychain' | 'file' | 'memory';

/**
 * Where secrets live. Every method is async because the keychain is a process
 * call; the in-memory one resolves immediately and satisfies the same contract.
 */
export interface Vault {
  readonly kind: VaultKind;
  /** The secret's value, or `null` when this machine holds no such secret. */
  get(name: string): Promise<string | null>;
  /** Store (or replace) a secret. */
  set(name: string, value: string): Promise<void>;
  /** Remove a secret. `false` when there was nothing to remove. */
  delete(name: string): Promise<boolean>;
  /** The names this vault holds, sorted. Names only — never values. */
  list(): Promise<string[]>;
}

/**
 * The vault exists but will not open: a locked keychain, a denied prompt, a
 * file vault with no `BUDDI_VAULT_KEY`. Fail closed — never fall back to a
 * prompt, and never wait.
 */
export class VaultLockedError extends Error {
  override readonly name = 'VaultLockedError';
  readonly code = 'vault-locked';
  constructor(message: string) {
    super(message);
  }
}

/**
 * There is no usable vault on this machine at all (no `security` binary, an
 * unwritable vault file). Distinct from locked: the caller may reasonably fall
 * back to the environment, which is exactly what `resolveSecret` does.
 */
export class VaultUnavailableError extends Error {
  override readonly name = 'VaultUnavailableError';
  readonly code = 'vault-unavailable';
  constructor(message: string) {
    super(message);
  }
}

/** The keychain service every buddi secret is filed under. */
export const VAULT_SERVICE = 'buddi';

/**
 * Secret names are environment-variable shaped on purpose: the same name that
 * appears in `.env` is the name in the keychain, so `import-env` is a move and
 * not a translation. Anything else is refused before it reaches the keychain.
 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function assertSecretName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid secret name: ${JSON.stringify(name)} (letters, digits and underscore; must not start with a digit)`,
    );
  }
  return name;
}

/** A value that is present but empty is not a secret. */
export function assertSecretValue(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`refusing to store an empty secret: ${name}`);
  }
  return value;
}
