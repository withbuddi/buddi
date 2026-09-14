/**
 * `buddi backup create` — one archive that is the whole installation, minus
 * every secret.
 *
 * The archive is staged in a temp directory and tarred at the end, so a failure
 * halfway leaves no half-written backup where a good one used to be. The
 * manifest is written last, after every member has been hashed: a manifest is a
 * claim about files, and it is only written once the files exist.
 */
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  KNOWN_SECRETS,
  createPool,
  createVault,
  timezoneFromEnv,
  type PluginManifest,
  type Vault,
} from '@buddi/core';
import { agentSearchPath, installedManifests } from '@buddi/gateway';
import { BACKUP_DIR, ENV_FILE, REPO_ROOT } from '../paths.js';
import { run } from '../proc.js';
import { createArchive, sha256File, tarAvailable, walkFiles } from './archive.js';
import {
  ARTIFACTS_DIR_NAME,
  DIR_MODE,
  DUMP_NAME,
  ENV_NAME,
  FILE_MODE,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
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
import { dumpDatabase, migrationRecords, parseDatabaseUrl, tableCounts } from './pg.js';

export interface CreateOptions {
  /** Where the archive lands. Default `<data dir>/backups`. */
  out?: string | undefined;
  /** Leave the artifact files out — the manifest records that they were skipped. */
  noArtifacts?: boolean;
  /** Run a prune afterwards, keeping this many. What the nightly job passes. */
  prune?: number | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injected in tests. `false` means "do not consult one at all". */
  vault?: Vault | false | undefined;
}

export interface CreateResult {
  archive: string;
  bytes: number;
  manifest: BackupManifest;
}

/**
 * `git describe`, falling back to the package version.
 *
 * Which *code* wrote a dump is part of whether it can be restored, and a tag
 * plus a commit says that far better than a version constant nobody bumps.
 */
export async function buddiVersion(repoRoot: string = REPO_ROOT): Promise<string> {
  const res = await run('git', ['describe', '--tags', '--always', '--dirty'], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  const described = res.stdout.trim();
  if (res.code === 0 && described !== '') return described;
  try {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    return `v${pkg.version ?? '0.0.0'} (not a git checkout)`;
  } catch {
    return 'unknown';
  }
}

/** sha256 of every migration file this build ships, keyed `schema/filename`. */
export async function migrationChecksums(
  manifests: PluginManifest[] = installedManifests(),
): Promise<Map<string, string>> {
  const dirs: Array<[string, string]> = [[CORE_SCHEMA, CORE_MIGRATIONS_DIR]];
  for (const m of manifests) {
    if (m.migrationsDir && m.migrationsDir.trim() !== '') dirs.push([m.schema, m.migrationsDir]);
  }
  const out = new Map<string, string>();
  for (const [schema, dir] of dirs) {
    for (const file of await walkFiles(dir)) {
      if (!file.rel.endsWith('.sql')) continue;
      out.set(`${schema}/${file.rel}`, await sha256File(file.abs));
    }
  }
  return out;
}

/** Copy a private directory into the stage. Returns null when there is nothing. */
async function stagePrivateDir(
  source: string,
  stageDir: string,
  archivePath: string,
): Promise<PrivateDirRecord | null> {
  if (!existsSync(source)) return null;
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

export async function createBackup(opts: CreateOptions = {}): Promise<CreateResult> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? (() => new Date()))();

  if (!(await tarAvailable())) {
    throw new Error('tar is not on PATH — buddi backup needs it to write the archive');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — run `buddi init`');
  const target = parseDatabaseUrl(databaseUrl);

  const outDir = opts.out ? path.resolve(opts.out) : BACKUP_DIR;
  await mkdir(outDir, { recursive: true, mode: DIR_MODE });
  await chmod(outDir, DIR_MODE).catch(() => {});

  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-backup-'));
  try {
    /* 1. the database ------------------------------------------------ */
    const dumpFile = path.join(stage, DUMP_NAME);
    await dumpDatabase({ repoRoot: REPO_ROOT, target, outFile: dumpFile });

    const pool = createPool(databaseUrl);
    let tables;
    let migrations;
    try {
      tables = await tableCounts(pool);
      migrations = await migrationRecords(pool, await migrationChecksums());
    } finally {
      await pool.end().catch(() => {});
    }

    /* 2. `.env`, with every secret value removed --------------------- */
    const secretNames = new Set<string>();
    const vaultNames = new Set<string>();
    let envRedacted: string[] = [];
    if (existsSync(ENV_FILE)) {
      const raw = await readFile(ENV_FILE, 'utf8');
      const scrubbed = scrubEnv(raw, { known: KNOWN_SECRETS });
      // The mechanism, not the promise: if anything the file called a secret is
      // still in the text we are about to archive, no archive is written.
      assertNoSecretValues(scrubbed.text, secretValuesIn(raw, KNOWN_SECRETS));
      await writeFile(path.join(stage, ENV_NAME), scrubbed.text, { mode: FILE_MODE });
      for (const name of scrubbed.names) secretNames.add(name);
      for (const name of scrubbed.inVault) vaultNames.add(name);
      envRedacted = scrubbed.redacted;
    }

    // `.env` is only half the answer on an installation that has run
    // `buddi vault import-env`: the names that matter most may exist only in
    // the keychain. Ask it for its *names* — never a value — so the manifest
    // can list every secret the owner will have to put back.
    const vault = opts.vault === false ? undefined : (opts.vault ?? createVault({ env }));
    if (vault) {
      try {
        for (const name of await vault.list()) {
          secretNames.add(name);
          vaultNames.add(name);
        }
      } catch {
        // A locked or absent vault is not a reason to refuse a backup: the
        // database, the agents and the artifacts are all still worth having.
        // The `.env` names above are then the manifest's best answer.
      }
    }
    const envNames = [...secretNames].sort();

    /* 3. the private agents and skills ------------------------------- */
    const search = agentSearchPath(env);
    const agentsRecord = await stagePrivateDir(
      search.owner.dir,
      stage,
      `${PRIVATE_DIR_NAME}/agents`,
    );
    const skillsRecord = await stagePrivateDir(
      search.owner.skillsDir,
      stage,
      `${PRIVATE_DIR_NAME}/skills`,
    );

    /* 4. the artifact store ------------------------------------------ */
    const dataDir = env.BUDDI_DATA_DIR ? path.resolve(env.BUDDI_DATA_DIR) : path.join(REPO_ROOT, 'data');
    const artifactsSource = path.join(dataDir, ARTIFACTS_DIR_NAME);
    const artifactFiles = await walkFiles(artifactsSource);
    const artifactBytes = artifactFiles.reduce((sum, f) => sum + f.bytes, 0);
    if (!opts.noArtifacts && artifactFiles.length > 0) {
      await cp(artifactsSource, path.join(stage, ARTIFACTS_DIR_NAME), {
        recursive: true,
        dereference: true,
      });
    }

    /* 5. hash every member, then write the manifest ------------------ */
    const staged = await walkFiles(stage);
    const members: MemberChecksum[] = [];
    for (const file of staged) {
      members.push({ path: file.rel, bytes: file.bytes, sha256: await sha256File(file.abs) });
    }

    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      createdAt: now.toISOString(),
      timezone: timezoneFromEnv(env),
      buddiVersion: await buddiVersion(),
      host: os.hostname(),
      database: {
        name: target.database,
        host: target.host,
        port: target.port,
        user: target.user,
      },
      migrations,
      tables,
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

    /* 6. one archive ------------------------------------------------- */
    const archive = path.join(outDir, archiveName(now));
    await createArchive(stage, archive);
    await chmod(archive, FILE_MODE);
    const bytes = (await stat(archive)).size;
    return { archive, bytes, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** The manifest's own checksum — printed so an owner can note it somewhere. */
export function manifestDigest(manifest: BackupManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest.members)).digest('hex').slice(0, 16);
}
