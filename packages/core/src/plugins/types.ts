/**
 * What it means for a plugin to be *installed* here.
 *
 * Until now "installed" meant "compiled in": a line in the gateway's
 * `createToolRegistry`. That is fine for the four plugins this repository
 * ships and impossible for anybody else's — installing the finance plugin on a
 * stranger's machine meant editing their code. So installation becomes a
 * record: a small file the owner owns, listing what was installed, from where,
 * and at which version.
 *
 * The record is the *only* source of truth for what loads. It deliberately
 * does not live in Postgres: `buddi plugins list` has to answer with the
 * database down, which is exactly when an owner is trying to find out what is
 * configured. Postgres keeps what it already kept — the plugin's own schema and
 * the migration ledger — and that split is what makes uninstall recoverable:
 * removing the record stops the code loading and touches no data at all.
 *
 * Core defines the shape and reads and writes the file. It never *loads* the
 * code: resolving an entry point and importing it is the composition root's
 * job, in the gateway, because core may not import a plugin (principle 6, and
 * `scripts/check-boundaries.mjs` now checks the dynamic form too).
 */

/** Where an installed plugin came from. One kind today; see `docs/plugins.md`. */
export type PluginSource = {
  kind: 'directory';
  /** Absolute path to the plugin package directory (the one with package.json). */
  path: string;
};

/** One installed plugin, as the record file carries it. */
export interface InstalledPlugin {
  /** The manifest's own `name`. Unique: it is also the Postgres schema owner. */
  name: string;
  /** The version recorded at install time — what an upgrade is compared against. */
  version: string;
  source: PluginSource;
  /**
   * The module the gateway imports, absolute. Resolved once at install from the
   * package's `main`/`exports`, so a later boot never re-guesses it.
   */
  entry: string;
  /** ISO 8601, for `buddi plugins list`. */
  installedAt: string;
  /** The Postgres schema the manifest claimed at install. Uninstall needs it. */
  schema: string;
}

/** The whole record file. Versioned so a future format can be recognised. */
export interface PluginsFile {
  version: 1;
  plugins: InstalledPlugin[];
}

export const PLUGINS_FILE_VERSION = 1 as const;

/** The file's name inside the owner's private directory. */
export const PLUGINS_FILE = 'plugins.json';

/** Pin the record file somewhere else (tests, a second installation). */
export const PLUGINS_FILE_ENV = 'BUDDI_PLUGINS_FILE';
