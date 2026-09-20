/**
 * The backup manifest and everything about it that is a pure function.
 *
 * A backup is only worth having if the owner can *prove* it is good without
 * restoring it, so the manifest is the proof: what was in the database when the
 * archive was written, which migrations the schema was at, which files are
 * inside and what they hash to, and — the part that matters most — which
 * secrets exist on the machine but are deliberately **not** in the archive.
 *
 * Nothing in this file touches the disk, the database or a child process. That
 * is the point: the scrubbing rule that keeps credentials out of a backup is
 * the kind of thing that has to be testable with odd input, not with a live
 * `.env`.
 */

import { VAULT_PLACEHOLDER, VAULT_PLACEHOLDER_LINE } from '../vault/resolve.js';

/** Archive layout. These names are the format — changing one is a format change. */
export const MANIFEST_NAME = 'manifest.json';
/** The database, as text: one COPY file per table plus three small indexes. */
export const DB_DIR_NAME = 'db';
export const TABLES_NAME = `${DB_DIR_NAME}/tables.json`;
export const SEQUENCES_NAME = `${DB_DIR_NAME}/sequences.json`;
export const DB_MIGRATIONS_NAME = `${DB_DIR_NAME}/migrations.json`;
export const ENV_NAME = 'env.txt';
export const PRIVATE_DIR_NAME = 'private';
export const ARTIFACTS_DIR_NAME = 'artifacts';
/** The installed-plugins record, copied in as it was. */
export const PLUGINS_NAME = 'plugins.json';

/** One table's COPY file, inside the archive. */
export function copyFileName(schema: string, table: string): string {
  return `${DB_DIR_NAME}/${schema}.${table}.copy`;
}

export const ARCHIVE_PREFIX = 'buddi-backup-';
export const ARCHIVE_SUFFIX = '.tar.gz';
/** The encrypted form, written beside a `<name>.json` envelope. */
export const ENCRYPTED_SUFFIX = '.age';
/** What `restore` calls the snapshot it takes of the target before it starts. */
export const PRE_RESTORE_PREFIX = 'pre-restore-';

/**
 * Bumped only when an older archive would be read wrongly by this code.
 *
 * 2 is the driver-based dump: `db/` holds COPY text per table rather than one
 * `pg_dump` custom-format file. Format 1 archives cannot be restored by this
 * build at all, so they are refused rather than half-read.
 */
export const MANIFEST_FORMAT = 2;

/** Directory mode 0700, archive mode 0600 — a backup is the whole installation. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** How many archives `buddi backup prune` keeps when nobody says otherwise. */
export const DEFAULT_KEEP = 14;

/** A backup older than this is stale enough for the doctor to say so. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

export interface MemberChecksum {
  /** Archive-relative POSIX path. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface MigrationRecord {
  schema: string;
  filename: string;
  appliedAt: string | null;
  /** sha256 of the migration file as it exists in this build, when found. */
  sha256: string | null;
}

export interface TableCount {
  /** `schema.table`. */
  table: string;
  rows: number;
}

/** One table in the dump, in the order the loader must copy it back. */
export interface DumpedTable {
  schema: string;
  table: string;
  /** Column names, in the order the COPY file has them. */
  columns: string[];
  rows: number;
}

/** One sequence, so a restored installation's next id is not id 1 again. */
export interface DumpedSequence {
  schema: string;
  name: string;
  /** Text, because a sequence is bigint and a bigint is not a JS number. */
  lastValue: string;
  isCalled: boolean;
}

/**
 * Which migrations the dumped schema was at: core's own, then one entry per
 * plugin schema. Restore rebuilds exactly this much and no more.
 */
export interface DumpedMigrations {
  core: string[];
  plugins: Record<string, { schema: string; filenames: string[] }>;
}

export interface PrivateDirRecord {
  /** Where it was resolved from on the machine that made the backup. */
  source: string;
  /** Archive-relative directory the copy lives under. */
  archivePath: string;
  files: number;
  bytes: number;
}

export interface BackupManifest {
  format: number;
  createdAt: string;
  /** The owner's timezone, so a restored installation means the same "today". */
  timezone: string;
  /** `@buddi/core`'s own package version. Never `git describe`: a packaged
   * install is not a git checkout, and a version that only a checkout can
   * answer is a version that reads "unknown" on every machine that matters. */
  buddiVersion: string;
  /** The server's major version, from `select version()`. */
  postgresMajor: number;
  host: string;
  /** Never a password: the connection string is recorded in pieces. */
  database: { name: string; host: string; port: string; user: string };
  migrations: MigrationRecord[];
  tables: TableCount[];
  /** The plugins installed when the backup was taken, by name and version. */
  plugins: Array<{ name: string; version: string; schema: string; source: string }>;
  artifacts: {
    included: boolean;
    count: number;
    bytes: number;
    /** Present only when they were left out. */
    skipped?: string;
  };
  private: { agents: PrivateDirRecord | null; skills: PrivateDirRecord | null };
  /**
   * Secret **names**, never values. The archive holds no credential at all;
   * this list is what the owner has to put back by hand after a restore.
   */
  secrets: {
    /**
     * Every secret name this installation uses — from `.env` and from the
     * vault's own listing. Names, never values.
     */
    names: string[];
    /** Of those, the ones that were in the vault when the backup was taken. */
    fromVault: string[];
    /** Values redacted inside a non-secret line (a URL password). */
    redacted: string[];
    note: string;
    restoreWith: string[];
  };
  members: MemberChecksum[];
}

/** The sentence the manifest carries about the vault. Stated, not implied. */
export const VAULT_NOTE =
  'No secret value is in this archive. The vault is NOT backed up: after a restore, ' +
  'set each name below by hand with `buddi vault set <NAME>` (or put it in .env).';

export function restoreCommandsFor(names: readonly string[]): string[] {
  return names.map((name) => `buddi vault set ${name}`);
}

/* ------------------------------------------------------------------ *
 * Archive names
 * ------------------------------------------------------------------ */

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `buddi-backup-YYYYMMDD-HHMMSS.tar.gz`, in *local* time.
 *
 * Local because the owner reads this name in a file listing next to a memory of
 * when they did something, and a UTC stamp on a machine in New York is a puzzle.
 */
export function archiveName(at: Date): string {
  const stamp =
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `${ARCHIVE_PREFIX}${stamp}${ARCHIVE_SUFFIX}`;
}

export function isArchiveName(name: string): boolean {
  return (
    name.startsWith(ARCHIVE_PREFIX) &&
    name.endsWith(ARCHIVE_SUFFIX) &&
    /^\d{8}-\d{6}$/.test(name.slice(ARCHIVE_PREFIX.length, -ARCHIVE_SUFFIX.length))
  );
}

/** The instant in the name, or null when the name is not one of ours. */
export function archiveTime(name: string): Date | null {
  if (!isArchiveName(name)) return null;
  const s = name.slice(ARCHIVE_PREFIX.length, -ARCHIVE_SUFFIX.length);
  const date = new Date(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(9, 11)),
    Number(s.slice(11, 13)),
    Number(s.slice(13, 15)),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ------------------------------------------------------------------ *
 * Scrubbing `.env`
 * ------------------------------------------------------------------ */

// The marker `buddi vault import-env` already writes. One definition, in the
// vault, so a scrubbed `.env` and a hydrated one cannot drift apart.

/**
 * Names that are secrets by shape, on top of the ones buddi knows by name.
 *
 * `BUDDI_VAULT_KEY` is the reason this exists and is not negotiable: it is the
 * key to the file vault, so an archive containing it would carry every secret
 * the vault holds even though no secret value is in the archive.
 */
export const SECRET_NAME_PATTERN =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|KEY|CREDENTIAL|CREDENTIALS|COOKIE|SESSION)$/;

export interface ScrubOptions {
  /** `KNOWN_SECRETS` from core, plus anything the caller wants forced. */
  known?: readonly string[];
}

export interface ScrubResult {
  /** The rewritten file. Comments, ordering and non-secret lines survive. */
  text: string;
  /**
   * Secret NAMES this installation uses, sorted.
   *
   * A name already holding the `"<vault>"` marker counts: the secret exists, it
   * just lives in the keychain rather than in the file. An installation that
   * has run `buddi vault import-env` is the *normal* one, and a backup whose
   * manifest said "no secrets" for it would be lying about the one thing the
   * manifest is for.
   */
  names: string[];
  /** Of those, the ones the file says are in the vault rather than in `.env`. */
  inVault: string[];
  /** Non-secret keys whose value held an embedded password (a URL). */
  redacted: string[];
}

export function isSecretName(name: string, known: readonly string[] = []): boolean {
  if (known.includes(name)) return true;
  return SECRET_NAME_PATTERN.test(name);
}

/** Strip one matching pair of surrounding quotes, the way `dotenv` does. */
function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/** `[key, rawValue]` for a `.env` line, comments and `export ` included. */
function splitLine(line: string): { key: string; value: string; commented: boolean } | null {
  let body = line.trim();
  if (body === '') return null;
  let commented = false;
  if (body.startsWith('#')) {
    commented = true;
    body = body.replace(/^#+\s*/, '');
  }
  body = body.replace(/^export\s+/, '');
  const idx = body.indexOf('=');
  if (idx <= 0) return null;
  const key = body.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: body.slice(idx + 1).trim(), commented };
}

/** A URL with its password replaced, or null when there was nothing to redact. */
function redactUrlPassword(value: string): string | null {
  const bare = unquote(value);
  try {
    const url = new URL(bare);
    if (!url.password) return null;
    url.password = '***';
    return value === bare ? url.toString() : `"${url.toString()}"`;
  } catch {
    return null;
  }
}

/**
 * Rewrite `.env` so it can be kept forever with no credential in it.
 *
 * Every secret-shaped line becomes `NAME="<vault>"` — the same marker the vault
 * import leaves, so a restored file is immediately readable by buddi and says
 * "ask the vault" rather than "this secret is missing". A commented-out secret
 * line is scrubbed too: `# GMAIL_APP_PASSWORD=hunter2` is still a credential in
 * a file, whatever the `#` in front of it suggests.
 *
 * The caller is expected to follow this with `assertNoSecretValues`. Scrubbing
 * that quietly missed a line is the one failure mode worth a hard stop.
 */
export function scrubEnv(text: string, opts: ScrubOptions = {}): ScrubResult {
  const known = opts.known ?? [];
  const names = new Set<string>();
  const inVault = new Set<string>();
  const redacted = new Set<string>();

  const lines = text.split('\n').map((line) => {
    const parsed = splitLine(line);
    if (parsed === null) return line;
    const { key, value, commented } = parsed;
    const bare = unquote(value).trim();

    if (isSecretName(key, known)) {
      // A name with no value at all is not a secret anyone holds; keep the
      // line readable (an empty `.env.example`-shaped line) and do not claim
      // it. A `<vault>` marker, on the other hand, IS a secret this
      // installation uses — it is simply already where it belongs.
      if (bare === VAULT_PLACEHOLDER) {
        names.add(key);
        inVault.add(key);
      } else if (bare !== '') {
        names.add(key);
      }
      const prefix = line.slice(0, line.indexOf(line.trim()[0] ?? ''));
      return commented
        ? `${prefix}# ${key}=${VAULT_PLACEHOLDER_LINE}`
        : `${prefix}${key}=${VAULT_PLACEHOLDER_LINE}`;
    }

    const url = redactUrlPassword(value);
    if (url !== null) {
      redacted.add(key);
      const prefix = line.slice(0, line.indexOf(line.trim()[0] ?? ''));
      return commented ? `${prefix}# ${key}=${url}` : `${prefix}${key}=${url}`;
    }
    return line;
  });

  return {
    text: lines.join('\n'),
    names: [...names].sort(),
    inVault: [...inVault].sort(),
    redacted: [...redacted].sort(),
  };
}

/**
 * Every value the original file held under a secret-shaped name. Used to prove
 * the scrubbed text carries none of them.
 */
export function secretValuesIn(text: string, known: readonly string[] = []): string[] {
  const values: string[] = [];
  for (const line of text.split('\n')) {
    const parsed = splitLine(line);
    if (parsed === null) continue;
    if (!isSecretName(parsed.key, known)) continue;
    const bare = unquote(parsed.value).trim();
    // One- and two-character "secrets" would match half the file by accident;
    // they are also not secrets. Below this length there is nothing to leak.
    if (bare.length >= 3 && bare !== VAULT_PLACEHOLDER) values.push(bare);
  }
  return values;
}

/**
 * Throw when any secret value survived the scrub. Belt and braces on purpose:
 * this is the assertion that makes "secrets are never included" a mechanism
 * rather than a promise.
 */
export function assertNoSecretValues(scrubbed: string, values: readonly string[]): void {
  const leaked = values.filter((v) => scrubbed.includes(v));
  if (leaked.length > 0) {
    throw new Error(
      `refusing to write the backup: ${leaked.length} secret value(s) survived scrubbing .env`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * Is this text a COPY file at all?
 *
 * There is no magic number to check — a COPY file of an empty table is
 * genuinely zero bytes — so the shape is what can be checked: every line is
 * tab-separated with the column count the manifest claims. That is enough to
 * catch the failure this guards, which is an error message or a truncated
 * transfer sitting where table data should be.
 */
export function copyFileProblem(
  text: string,
  table: { schema: string; table: string; columns: string[]; rows: number },
): string | null {
  const name = `${table.schema}.${table.table}`;
  if (text === '') {
    return table.rows === 0 ? null : `${name}: the COPY file is empty, manifest says ${table.rows} row(s)`;
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length !== table.rows) {
    return `${name}: the COPY file has ${lines.length} line(s), manifest says ${table.rows} row(s)`;
  }
  const wrong = lines.findIndex((line) => line.split('\t').length !== table.columns.length);
  if (wrong !== -1) {
    return `${name}: line ${wrong + 1} has ${lines[wrong]?.split('\t').length} field(s), not ${table.columns.length}`;
  }
  return null;
}

/** Problems with the manifest's *shape*. Empty means it is readable. */
export function manifestProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object') return ['manifest.json is not an object'];
  const m = raw as Record<string, unknown>;
  if (typeof m.format !== 'number') problems.push('format is missing');
  else if (m.format > MANIFEST_FORMAT) {
    problems.push(`format ${m.format} is newer than this build understands (${MANIFEST_FORMAT})`);
  }
  for (const key of ['createdAt', 'timezone', 'buddiVersion'] as const) {
    if (typeof m[key] !== 'string' || (m[key] as string) === '') problems.push(`${key} is missing`);
  }
  if (!Array.isArray(m.members) || m.members.length === 0) problems.push('members is empty');
  else {
    for (const member of m.members as MemberChecksum[]) {
      if (typeof member?.path !== 'string' || !/^[0-9a-f]{64}$/.test(member?.sha256 ?? '')) {
        problems.push(`a member entry is malformed (${JSON.stringify(member?.path ?? null)})`);
        break;
      }
    }
  }
  if (typeof m.postgresMajor !== 'number') problems.push('postgresMajor is missing');
  if (!Array.isArray(m.tables)) problems.push('tables is missing');
  if (!Array.isArray(m.migrations)) problems.push('migrations is missing');
  const secrets = m.secrets as Record<string, unknown> | undefined;
  if (!secrets || !Array.isArray(secrets.names)) problems.push('secrets.names is missing');
  else if (secrets.names.length > 0 && !Array.isArray(secrets.restoreWith)) {
    problems.push('secrets.restoreWith is missing');
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Prune
 * ------------------------------------------------------------------ */

export interface ArchiveEntry {
  name: string;
  /** Milliseconds since the epoch — the name's stamp, or the file's mtime. */
  at: number;
  bytes: number;
}

export interface PruneSelection {
  keep: ArchiveEntry[];
  remove: ArchiveEntry[];
}

/**
 * Newest `keep` survive; the rest go. Ties break on the name, which is a
 * timestamp, so the result never depends on directory order.
 *
 * `keep` below 1 is refused rather than clamped: `--keep 0` reads like "delete
 * every backup I have", and a prune that does that on a typo is not a feature.
 */
export function selectForPrune(entries: readonly ArchiveEntry[], keep: number): PruneSelection {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep needs an integer of at least 1 (got ${keep})`);
  }
  const sorted = [...entries].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  return { keep: sorted.slice(0, keep), remove: sorted.slice(keep) };
}

/* ------------------------------------------------------------------ *
 * The non-empty-database guard
 * ------------------------------------------------------------------ */

export interface RestoreGuardInput {
  database: string;
  /** Tables already in the target, outside the system schemas. */
  existingTables: number;
  /** Rows across those tables. A migrated-but-empty database is not precious. */
  existingRows: number;
  yes: boolean;
  /** What the owner typed at the prompt, when they were asked. */
  typed?: string | undefined;
}

export type RestoreGuard = { ok: true; note: string } | { ok: false; message: string };

/**
 * May this restore proceed?
 *
 * An empty database is a free pass — that is the ordinary "new machine" case
 * and stopping to ask would be theatre. Anything with rows in it needs BOTH
 * `--yes` and the database name typed back, because the failure this guards is
 * the owner restoring last week's archive over the live installation, and one
 * confirmation is exactly the number a person clicks through.
 */
export function checkRestoreGuard(input: RestoreGuardInput): RestoreGuard {
  if (input.existingTables === 0) {
    return { ok: true, note: `${input.database} is empty — restoring into it` };
  }
  if (input.existingRows === 0) {
    return {
      ok: true,
      note: `${input.database} has ${input.existingTables} table(s) but no rows — restoring into it`,
    };
  }
  if (!input.yes) {
    return {
      ok: false,
      message:
        `${input.database} already holds ${input.existingRows} row(s) in ${input.existingTables} table(s). ` +
        'Refusing to restore over it. Re-run with --yes (you will be asked to type the database name), ' +
        `or restore somewhere else with --into ${input.database}_restore.`,
    };
  }
  if (input.typed === undefined) {
    return {
      ok: false,
      message: `--yes was given but the database name was never confirmed (expected "${input.database}")`,
    };
  }
  if (input.typed.trim() !== input.database) {
    return {
      ok: false,
      message: `that is not the database name — expected "${input.database}", got "${input.typed.trim()}". Nothing was changed.`,
    };
  }
  return {
    ok: true,
    note: `${input.database} confirmed by name — its ${input.existingRows} row(s) will be replaced`,
  };
}

/* ------------------------------------------------------------------ *
 * Reporting helpers
 * ------------------------------------------------------------------ */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
