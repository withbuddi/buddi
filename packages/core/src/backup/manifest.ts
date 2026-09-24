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
/** Where a restore leaves that record, for the recovery checklist to read. */
export const RESTORED_PLUGINS_NAME = 'restored-plugins.json';

/**
 * The only three directories a restore will ever write out of an archive.
 *
 * The manifest says where the private directories live *inside* the archive,
 * and a manifest is not a trusted document: it arrives with the archive, from
 * wherever the archive came from. So the restore does not follow that path, it
 * checks it against this list. Anything else — an absolute path, a `..`, a
 * different directory entirely — is refused rather than resolved.
 */
export const PRIVATE_AGENTS_PATH = `${PRIVATE_DIR_NAME}/agents`;
export const PRIVATE_SKILLS_PATH = `${PRIVATE_DIR_NAME}/skills`;

/**
 * Is this archive-relative path one we are willing to read from?
 *
 * Returns the reason it is not, or null when it is fine. Absolute paths, `..`
 * components, Windows drive letters and backslashes are all ways of naming a
 * file outside the extraction directory, and a backup restored as root writing
 * `../../etc/…` is the failure this exists to make impossible.
 */
export function memberPathProblem(member: string): string | null {
  const name = JSON.stringify(member);
  if (member.trim() === '') return 'an empty path';
  if (member.startsWith('/') || /^[A-Za-z]:[\\/]/.test(member)) return `${name} is an absolute path`;
  if (member.includes('\\')) return `${name} holds a backslash`;
  const parts = member.split('/');
  if (parts.includes('..')) return `${name} climbs out of the archive with ".."`;
  if (parts.includes('~')) return `${name} names a home directory`;
  return null;
}

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
    /** The owner secrets among the vault names, as the lines that restore them. */
    ownerSecrets: string[];
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

/**
 * `<name>.tar.gz.age` without its `.age`, so one rule covers both forms.
 *
 * An encrypted archive is still an archive: a `list` that cannot see one, a
 * `prune` that never removes one and a doctor that reports "no backup has ever
 * been taken" are all the same bug, and it is the bug an owner discovers on the
 * day they need the backup.
 */
function archiveStem(name: string): string {
  return name.endsWith(ENCRYPTED_SUFFIX) ? name.slice(0, -ENCRYPTED_SUFFIX.length) : name;
}

export function isArchiveName(name: string): boolean {
  const stem = archiveStem(name);
  return (
    stem.startsWith(ARCHIVE_PREFIX) &&
    stem.endsWith(ARCHIVE_SUFFIX) &&
    /^\d{8}-\d{6}$/.test(stem.slice(ARCHIVE_PREFIX.length, -ARCHIVE_SUFFIX.length))
  );
}

/** Is this the encrypted form? */
export function isEncryptedArchiveName(name: string): boolean {
  return name.endsWith(ENCRYPTED_SUFFIX);
}

/** The instant in the name, or null when the name is not one of ours. */
export function archiveTime(name: string): Date | null {
  if (!isArchiveName(name)) return null;
  const stem = archiveStem(name);
  const s = stem.slice(ARCHIVE_PREFIX.length, -ARCHIVE_SUFFIX.length);
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
  const body = value.trimEnd();
  if ((first === '"' || first === "'") && body.length >= 2 && body.endsWith(first)) {
    return body.slice(1, -1);
  }
  return value;
}

/** Does this text end the quoted value that `quote` opened? */
function closesQuote(text: string, quote: string): boolean {
  const body = text.trimEnd();
  return body.length >= 1 && body.endsWith(quote) && !body.endsWith(`\\${quote}`);
}

/** One `KEY=value` in a `.env`, however many lines its value takes. */
interface EnvEntry {
  key: string;
  /** The raw text after `=`, newlines and all. */
  value: string;
  commented: boolean;
  /** The first line's leading whitespace, kept in the rewrite. */
  indent: string;
  /** Line indexes, inclusive. */
  start: number;
  end: number;
}

/**
 * Parse a `.env` into entries, keeping a quoted value that runs over several
 * lines in one piece.
 *
 * A private key is the ordinary case of this: `KEY="-----BEGIN…` followed by
 * twenty lines of base64 and a closing quote. Scrubbing that line by line
 * replaced the first line and left the key itself in the archive — which
 * `assertNoSecretValues` then refused to write at all, so no backup was
 * possible on such a machine. The whole value is the unit.
 */
function parseEnvEntries(lines: readonly string[]): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const parsed = splitLine(line);
    if (parsed === null) continue;
    const indent = line.slice(0, line.length - line.trimStart().length);
    let value = parsed.value;
    let end = i;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !(value.length >= 2 && closesQuote(value, quote))) {
      for (let j = i + 1; j < lines.length; j += 1) {
        value += `\n${lines[j] ?? ''}`;
        // An unterminated quote is a broken file, not an invitation to swallow
        // the rest of it: without a closing line the entry stays one line.
        if (closesQuote(lines[j] ?? '', quote)) {
          end = j;
          break;
        }
      }
      if (end === i) value = parsed.value;
    }
    out.push({ key: parsed.key, value, commented: parsed.commented, indent, start: i, end });
    i = end;
  }
  return out;
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

  const lines = text.split('\n');
  const rewritten = [...lines];
  // Lines a multi-line value occupied and that are gone from the rewrite.
  const dropped = new Set<number>();

  for (const entry of parseEnvEntries(lines)) {
    const { key, value, commented, indent } = entry;
    const bare = unquote(value).trim();
    const replace = (line: string): void => {
      rewritten[entry.start] = line;
      for (let i = entry.start + 1; i <= entry.end; i += 1) dropped.add(i);
    };

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
      replace(
        commented
          ? `${indent}# ${key}=${VAULT_PLACEHOLDER_LINE}`
          : `${indent}${key}=${VAULT_PLACEHOLDER_LINE}`,
      );
      continue;
    }

    const url = redactUrlPassword(value);
    if (url !== null) {
      redacted.add(key);
      replace(commented ? `${indent}# ${key}=${url}` : `${indent}${key}=${url}`);
    }
  }

  return {
    text: rewritten.filter((_, i) => !dropped.has(i)).join('\n'),
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
  for (const entry of parseEnvEntries(text.split('\n'))) {
    if (!isSecretName(entry.key, known)) continue;
    const bare = unquote(entry.value).trim();
    // One- and two-character "secrets" would match half the file by accident;
    // they are also not secrets. Below this length there is nothing to leak.
    if (bare.length >= 3 && bare !== VAULT_PLACEHOLDER) values.push(bare);
    // A multi-line value is also checked line by line: a scrub that replaced
    // the first line and left the other twenty would otherwise pass, because
    // the whole value is not in the text any more either.
    if (bare.includes('\n')) {
      for (const piece of bare.split('\n')) {
        const trimmed = piece.trim();
        if (trimmed.length >= 3 && trimmed !== VAULT_PLACEHOLDER) values.push(trimmed);
      }
    }
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
  } else if (m.format < MANIFEST_FORMAT) {
    // Format 1 was one `pg_dump` custom-format file. Nothing in this build can
    // read it, and half-reading it would be worse than saying so.
    problems.push(
      `format ${m.format} is an older backup than this build can read (it reads format ${MANIFEST_FORMAT}); ` +
        'restore it with the buddi it was made by',
    );
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
