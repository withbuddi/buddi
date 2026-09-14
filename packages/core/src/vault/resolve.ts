/**
 * Resolving one secret: vault first, environment second.
 *
 * The environment is the *documented day-1 fallback* (ARCHITECTURE.md,
 * "Credential kinds": «Secrets come from the vault; in the day-1 build they
 * come from `.env` via an explicit env-name reference»), not an accident — but
 * it is a fallback, so a secret the owner moved into the keychain wins over a
 * stale copy left in `.env`.
 *
 * Three outcomes, no fourth: a value with its source, or a typed problem.
 * Nothing here prompts, and nothing here logs a value.
 */
import { VaultLockedError, VaultUnavailableError, type Vault } from './types.js';

/**
 * What `buddi vault import-env` leaves behind in `.env`: a marker saying "this
 * secret moved to the vault". It is never treated as a value.
 */
export const VAULT_PLACEHOLDER = '<vault>';

/**
 * How the marker is *written* into `.env`: quoted.
 *
 * Bare `<vault>` is a here-document redirection to `sh`/`zsh`, so a `.env`
 * holding `NAME=<vault>` blows up under `set -a; . ./.env` — the shell
 * incantation every CI script and half the docs use. Double quotes cost
 * nothing (`dotenv` strips them) and keep the file sourceable.
 */
export const VAULT_PLACEHOLDER_LINE = `"${VAULT_PLACEHOLDER}"`;

/**
 * Is this value the marker rather than a secret?
 *
 * Both spellings count: `dotenv` hands back `<vault>` with the quotes already
 * stripped, while anything reading the file's text raw (`init`, `import-env`)
 * still sees `"<vault>"`. Older files written before the quoting fix are the
 * unquoted form, and stay readable.
 */
export function isVaultPlaceholder(value: string): boolean {
  return unquote(value.trim()) === VAULT_PLACEHOLDER;
}

/** Strip one matching pair of surrounding quotes, the way `dotenv` does. */
function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The secrets buddi knows how to move into the keychain. `import-env` walks
 * this list; nothing else in `.env` (a database URL, a timezone) is a secret.
 */
export const KNOWN_SECRETS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'GMAIL_APP_PASSWORD',
];

export type SecretSource = 'vault' | 'env';

export type SecretProblem = {
  code: 'missing-secret' | 'vault-locked' | 'vault-unavailable';
  message: string;
};

export type SecretResolution =
  | { ok: true; name: string; value: string; source: SecretSource }
  | { ok: false; name: string; problem: SecretProblem };

export interface ResolveSecretOptions {
  /** Absent means "this build has no vault": the environment is the only path. */
  vault?: Vault | undefined;
  env?: NodeJS.ProcessEnv;
}

/** Is this environment value a real one, or the moved-to-the-vault marker? */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || isVaultPlaceholder(value)) return undefined;
  return value;
}

export async function resolveSecret(
  name: string,
  opts: ResolveSecretOptions = {},
): Promise<SecretResolution> {
  const env = opts.env ?? {};
  const vault = opts.vault;

  if (vault) {
    try {
      const value = await vault.get(name);
      if (value !== null && value.trim() !== '') {
        return { ok: true, name, value: value.trim(), source: 'vault' };
      }
    } catch (err) {
      if (err instanceof VaultLockedError) {
        // Fail closed: a locked vault is not an invitation to use whatever is
        // lying around in `.env`. The owner unlocks it, or nothing runs.
        return { ok: false, name, problem: { code: 'vault-locked', message: err.message } };
      }
      if (err instanceof VaultUnavailableError) {
        // No vault on this machine — the day-1 path is still open below.
        const fallback = envValue(env, name);
        if (fallback !== undefined) {
          return { ok: true, name, value: fallback, source: 'env' };
        }
        return {
          ok: false,
          name,
          problem: { code: 'vault-unavailable', message: err.message },
        };
      }
      throw err;
    }
  }

  const fromEnv = envValue(env, name);
  if (fromEnv !== undefined) return { ok: true, name, value: fromEnv, source: 'env' };

  return {
    ok: false,
    name,
    problem: {
      code: 'missing-secret',
      message: `secret ${name} is not in the vault and ${name} is not set in the environment`,
    },
  };
}

export interface ResolvedSecrets {
  /** A copy of `env` with every secret that resolved written into it. */
  env: NodeJS.ProcessEnv;
  /** Where each resolved secret came from — for a startup banner, never a value. */
  sources: Record<string, SecretSource>;
  /** Secrets that did not resolve. Not fatal here: the caller decides. */
  problems: Record<string, SecretProblem>;
}

/**
 * Resolve several secrets into an environment overlay.
 *
 * This is how the composition root keeps everything downstream unchanged: the
 * provider port, the Telegram client and the email plugin all still read a
 * named environment variable, and the vault is what filled it in. Nothing
 * mutates `process.env`; the overlay is a copy.
 */
export async function resolveSecrets(
  names: readonly string[],
  opts: ResolveSecretOptions = {},
): Promise<ResolvedSecrets> {
  const base = opts.env ?? {};
  const out: NodeJS.ProcessEnv = { ...base };
  const sources: Record<string, SecretSource> = {};
  const problems: Record<string, SecretProblem> = {};

  for (const name of names) {
    const resolution = await resolveSecret(name, { ...opts, env: base });
    if (resolution.ok) {
      out[name] = resolution.value;
      sources[name] = resolution.source;
    } else {
      // A placeholder must never survive as if it were the secret.
      if (out[name] !== undefined && envValue(base, name) === undefined) delete out[name];
      problems[name] = resolution.problem;
    }
  }

  return { env: out, sources, problems };
}
