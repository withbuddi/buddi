/**
 * What it means for a plugin to be *installed* here.
 *
 * Until now "installed" meant "compiled in": a line in the gateway's
 * `createToolRegistry`. That is fine for the plugins this repository
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
 *
 * Version 2 adds provenance. A directory source is a developer pointing at a
 * build on their own disk and there is nothing to record beyond the path; a
 * package that came from a registry was fetched, hashed and published by
 * somebody, and the owner approved exactly that hash. Those facts are the only
 * thing that lets doctor say later "this is not what you approved", so they are
 * part of the record rather than a log line. A v1 file still reads: every entry
 * in it is a directory source with no provenance, which is precisely true.
 */

/** Where an installed plugin came from. */
export type PluginSource =
  /** A built package directory on this disk. The developer path, unchanged. */
  | { kind: 'directory'; path: string }
  /** An npm package. `version` is the exact resolved one, never a range. */
  | { kind: 'registry'; name: string; version: string; registry?: string }
  /** A `.tgz` on disk. Never public; the owner had the file. */
  | { kind: 'tarball'; path: string };

/**
 * What the owner was shown and agreed to, and what doctor compares against.
 *
 * Absent on a directory source: nothing was fetched, so there is no publisher
 * and no registry hash, and the files change every time the developer rebuilds.
 */
export interface PluginProvenance {
  /** The registry's Subresource Integrity string, `sha512-…`, as npm reports it. */
  integrity?: string;
  /** Whoever npm says published this version. A name, not an identity. */
  publisher?: string;
  /** sha256 over the installed package's files, excluding node_modules. */
  installedHash?: string;
  /** ISO 8601: when the owner approved it. */
  approvedAt?: string;
  /** The integrity the owner typed back at approval. Equal to `integrity`. */
  approvedIntegrity?: string;
}

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
  /** How it got here and what was approved. Absent for a directory source. */
  provenance?: PluginProvenance;
  /**
   * Written *before* the package files are moved into place, and cleared once
   * they are.
   *
   * An install renames a directory and writes a record, and a machine that
   * dies between the two leaves one of them done. Recording the intent first
   * means the leftover is always a record that says "I was placing this",
   * never a directory nothing knows about: the sweep at start can tell the two
   * apart, and `buddi plugins list` can say what happened instead of showing
   * a plugin that loads from nowhere.
   */
  placing?: boolean;
}

/** A Postgres schema name a plugin may claim: a plain lowercase identifier. */
export const PLUGIN_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Is this a schema name that can be quoted into SQL and mean what it says?
 *
 * A manifest is a string somebody else wrote and it reaches `create schema`,
 * `drop schema` and `set search_path`. Core's migrator already refuses
 * anything else; this is the same rule, available early enough to refuse the
 * plugin rather than fail halfway through installing it.
 */
export function isPluginSchemaName(schema: string): boolean {
  return PLUGIN_SCHEMA.test(schema) && schema.length <= 63;
}

/** The whole record file. Versioned so a future format can be recognised. */
export interface PluginsFile {
  version: 2;
  plugins: InstalledPlugin[];
}

export const PLUGINS_FILE_VERSION = 2 as const;

/** Versions of the record this build can read. It always writes the newest. */
export const PLUGINS_FILE_READABLE_VERSIONS: readonly number[] = [1, 2];

/** The file's name inside the owner's private directory. */
export const PLUGINS_FILE = 'plugins.json';

/** Pin the record file somewhere else (tests, a second installation). */
export const PLUGINS_FILE_ENV = 'BUDDI_PLUGINS_FILE';

/** The source, in the words `plugins list` and the Plugins page print. */
export function describeSource(source: PluginSource): string {
  if (source.kind === 'directory') return `directory ${source.path}`;
  if (source.kind === 'tarball') return `tarball ${source.path}`;
  const registry = source.registry === undefined ? '' : ` (${source.registry})`;
  return `npm ${source.name}@${source.version}${registry}`;
}
