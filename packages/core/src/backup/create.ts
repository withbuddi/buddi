/**
 * `createBackup` — one archive that is the whole installation, minus every
 * secret.
 *
 * The archive is staged in a temp directory and tarred at the end, so a failure
 * halfway leaves no half-written backup where a good one used to be. The
 * manifest is written last, after every member has been hashed: a manifest is a
 * claim about files, and it is only written once the files exist.
 *
 * Nothing here reads `process.env` or looks for a repository: every path the
 * engine touches arrives in the options. That is what lets the same code run in
 * a developer checkout, in a packaged installation and under the supervisor.
 */
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../db.js';
import { KNOWN_SECRETS } from '../vault/resolve.js';
import type { Vault } from '../vault/types.js';
import { createArchive, sha256File, tarAvailable, walkFiles } from './archive.js';
import { dumpDatabase } from './dump.js';
import {
  ARTIFACTS_DIR_NAME,
  DIR_MODE,
  ENV_NAME,
  FILE_MODE,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
  PLUGINS_NAME,
  PRIVATE_DIR_NAME,
  VAULT_NOTE,
  archiveName,
  assertNoSecretValues,
  formatBytes,
  restoreCommandsFor,
  scrubEnv,
  secretValuesIn,
  type BackupManifest,
  type MemberChecksum,
  type PrivateDirRecord,
} from './manifest.js';
import { PHASE } from './phases.js';
import { buddiVersion } from './version.js';

/** One installed plugin, as the manifest records it. */
export interface PluginRecord {
  name: string;
  version: string;
  schema: string;
  /** `registry`, a tarball path, or a directory — what it was installed from. */
  source: string;
}

/** Where this build keeps one schema's migrations, for their checksums. */
export interface MigrationDir {
  schema: string;
  dir: string;
}

export type ProgressStep = { phase: string; detail?: string };
export type OnProgress = (step: ProgressStep) => void;

export interface CreateOptions {
  /** The database to dump. One of these two is required. */
  databaseUrl?: string | undefined;
  pool?: Pool | undefined;
  /** Where the archive lands. */
  backupsDir: string;
  /** The installation's data directory; artifacts live under it. */
  dataDir: string;
  /** The owner's private directories, when this installation has them. */
  agentsDir?: string | undefined;
  skillsDir?: string | undefined;
  /** The installed-plugins record, copied into the archive as it stands. */
  pluginsFile?: string | undefined;
  /** The `.env` to scrub and carry. */
  envFile?: string | undefined;
  /** Secret names on top of the shape rule. Defaults to core's own list. */
  knownSecrets?: readonly string[] | undefined;
  /** The owner's timezone, so a restored installation means the same "today". */
  timezone?: string | undefined;
  /** Leave the artifact files out; the manifest records that they were skipped. */
  noArtifacts?: boolean | undefined;
  /** Migration directories this build ships, for per-file checksums. */
  migrationDirs?: readonly MigrationDir[] | undefined;
  /** What the manifest says is installed. */
  plugins?: readonly PluginRecord[] | undefined;
  /** `false` means "do not consult one at all". */
  vault?: Vault | false | undefined;
  now?: (() => Date) | undefined;
  /** The archive's base name, without directory. Defaults to the stamped one. */
  name?: string | undefined;
  onProgress?: OnProgress | undefined;
}

export interface CreateResult {
  archive: string;
  bytes: number;
  manifest: BackupManifest;
}

/** sha256 of every migration file this build ships, keyed `schema/filename`. */
export async function migrationChecksums(
  dirs: readonly MigrationDir[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { schema, dir } of dirs) {
    if (dir.trim() === '') continue;
    for (const file of await walkFiles(dir)) {
      if (!file.rel.endsWith('.sql')) continue;
      out.set(`${schema}/${file.rel}`, await sha256File(file.abs));
    }
  }
  return out;
}

/** Copy a private directory into the stage. Returns null when there is nothing. */
async function stagePrivateDir(
  source: string | undefined,
  stageDir: string,
  archivePath: string,
): Promise<PrivateDirRecord | null> {
  if (!source || !existsSync(source)) return null;
  const files = await walkFiles(source);
  if (files.length === 0) return null;
  const dest = path.join(stageDir, archivePath);
  await mkdir(path.dirname(dest), { recursive: true, mode: DIR_MODE });
  await cp(source, dest, { recursive: true, dereference: true });
  return {
    source,
    archivePath,
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}

export async function createBackup(opts: CreateOptions): Promise<CreateResult> {
  const now = (opts.now ?? ((): Date => new Date()))();
  const progress = opts.onProgress ?? ((): void => {});
  const known = opts.knownSecrets ?? KNOWN_SECRETS;

  if (!(await tarAvailable())) {
    throw new Error('tar is not on PATH — a backup needs it to write the archive');
  }
  if (!opts.pool && !opts.databaseUrl) {
    throw new Error('createBackup needs a pool or a databaseUrl');
  }

  const outDir = path.resolve(opts.backupsDir);
  await mkdir(outDir, { recursive: true, mode: DIR_MODE });
  await chmod(outDir, DIR_MODE).catch(() => {});

  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-backup-'));
  const pool = opts.pool ?? createPool(opts.databaseUrl as string);
  try {
    /* 1. the database ------------------------------------------------ */
    progress({ phase: PHASE.database, detail: 'copying every table out' });
    const dumped = await dumpDatabase(pool, stage);
    const checksums = await migrationChecksums(opts.migrationDirs ?? []);
    const migrations = dumped.records.map((record) => ({
      ...record,
      sha256: checksums.get(`${record.schema}/${record.filename}`) ?? null,
    }));

    /* 2. `.env`, with every secret value removed --------------------- */
    progress({ phase: PHASE.files, detail: 'staging the files' });
    const secretNames = new Set<string>();
    const vaultNames = new Set<string>();
    let envRedacted: string[] = [];
    if (opts.envFile && existsSync(opts.envFile)) {
      const raw = await readFile(opts.envFile, 'utf8');
      const scrubbed = scrubEnv(raw, { known });
      // The mechanism, not the promise: if anything the file called a secret is
      // still in the text we are about to archive, no archive is written.
      assertNoSecretValues(scrubbed.text, secretValuesIn(raw, known));
      await writeFile(path.join(stage, ENV_NAME), scrubbed.text, { mode: FILE_MODE });
      for (const name of scrubbed.names) secretNames.add(name);
      for (const name of scrubbed.inVault) vaultNames.add(name);
      envRedacted = scrubbed.redacted;
    }

    // `.env` is only half the answer on an installation that has run
    // `buddi vault import-env`: the names that matter most may exist only in
    // the keychain. Ask it for its *names* — never a value — so the manifest
    // can list every secret the owner will have to put back.
    if (opts.vault) {
      try {
        for (const name of await opts.vault.list()) {
          secretNames.add(name);
          vaultNames.add(name);
        }
      } catch {
        // A locked or absent vault is not a reason to refuse a backup: the
        // database, the agents and the artifacts are all still worth having.
      }
    }
    const envNames = [...secretNames].sort();

    /* 3. the private agents and skills ------------------------------- */
    const agentsRecord = await stagePrivateDir(opts.agentsDir, stage, `${PRIVATE_DIR_NAME}/agents`);
    const skillsRecord = await stagePrivateDir(opts.skillsDir, stage, `${PRIVATE_DIR_NAME}/skills`);

    /* 4. the installed-plugins record -------------------------------- */
    if (opts.pluginsFile && existsSync(opts.pluginsFile)) {
      await cp(opts.pluginsFile, path.join(stage, PLUGINS_NAME));
      await chmod(path.join(stage, PLUGINS_NAME), FILE_MODE).catch(() => {});
    }

    /* 5. the artifact store ------------------------------------------ */
    const artifactsSource = path.join(opts.dataDir, ARTIFACTS_DIR_NAME);
    const artifactFiles = await walkFiles(artifactsSource);
    const artifactBytes = artifactFiles.reduce((sum, f) => sum + f.bytes, 0);
    if (!opts.noArtifacts && artifactFiles.length > 0) {
      await cp(artifactsSource, path.join(stage, ARTIFACTS_DIR_NAME), {
        recursive: true,
        dereference: true,
      });
    }

    /* 6. hash every member, then write the manifest ------------------ */
    const staged = await walkFiles(stage);
    const members: MemberChecksum[] = [];
    for (const file of staged) {
      members.push({ path: file.rel, bytes: file.bytes, sha256: await sha256File(file.abs) });
    }

    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      createdAt: now.toISOString(),
      timezone: opts.timezone ?? 'UTC',
      buddiVersion: buddiVersion(),
      postgresMajor: dumped.postgresMajor,
      host: os.hostname(),
      database: databaseFacts(opts),
      migrations,
      tables: dumped.tables.map((t) => ({ table: `${t.schema}.${t.table}`, rows: t.rows })),
      plugins: [...(opts.plugins ?? [])],
      artifacts: {
        included: !opts.noArtifacts,
        count: opts.noArtifacts ? 0 : artifactFiles.length,
        bytes: opts.noArtifacts ? 0 : artifactBytes,
        ...(opts.noArtifacts
          ? {
              skipped:
                `--no-artifacts: ${artifactFiles.length} file(s), ${formatBytes(artifactBytes)} ` +
                `under ${artifactsSource} are NOT in this archive`,
            }
          : {}),
      },
      private: { agents: agentsRecord, skills: skillsRecord },
      secrets: {
        names: envNames,
        fromVault: [...vaultNames].sort(),
        redacted: envRedacted,
        note: VAULT_NOTE,
        restoreWith: restoreCommandsFor(envNames),
      },
      members,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(stage, MANIFEST_NAME), manifestText, { mode: FILE_MODE });

    /* 7. one archive ------------------------------------------------- */
    progress({ phase: PHASE.archive, detail: 'writing the archive' });
    const archive = path.join(outDir, opts.name ?? archiveName(now));
    await createArchive(stage, archive);
    await chmod(archive, FILE_MODE);
    const bytes = (await stat(archive)).size;
    return { archive, bytes, manifest };
  } finally {
    if (!opts.pool) await pool.end().catch(() => {});
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** The connection, in pieces and without its password. */
function databaseFacts(opts: CreateOptions): BackupManifest['database'] {
  if (!opts.databaseUrl) return { name: '', host: '', port: '', user: '' };
  try {
    const url = new URL(opts.databaseUrl);
    return {
      name: decodeURIComponent(url.pathname.replace(/^\//, '')),
      host: url.hostname,
      port: url.port || '5432',
      user: decodeURIComponent(url.username) || 'postgres',
    };
  } catch {
    return { name: '', host: '', port: '', user: '' };
  }
}

/** The manifest's own checksum — printed so an owner can note it somewhere. */
export function manifestDigest(manifest: BackupManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest.members)).digest('hex').slice(0, 16);
}
