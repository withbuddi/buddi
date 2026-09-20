/**
 * `restoreBackup` — put an installation back.
 *
 * Four rules, in the order they matter:
 *
 * 1. **Nothing is restored from an archive that did not verify.** The checksums
 *    run first, every time; `force` does not skip them.
 * 2. **Never silently destroy a live installation.** A target with rows in it
 *    needs the database name typed back. The engine only reports the guard's
 *    verdict; the caller is what asks the question.
 * 3. **A snapshot of the target first, the database second, the files third.**
 *    If any step after the snapshot fails, the snapshot goes back in, so a
 *    half-restored installation cannot exist. The snapshot is kept and named in
 *    the report either way.
 * 4. **Say what happened.** Every step reports "did" or "did not", including
 *    the things this command cannot do — the vault above all.
 */
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../db.js';
import { extractAll, walkFiles } from './archive.js';
import { createBackup, type CreateOptions, type OnProgress } from './create.js';
import { loadDatabase, type LoadReport, type MigrationSource } from './load.js';
import {
  ARTIFACTS_DIR_NAME,
  DIR_MODE,
  ENV_NAME,
  PRE_RESTORE_PREFIX,
  PRIVATE_DIR_NAME,
  checkRestoreGuard,
  formatBytes,
  type BackupManifest,
} from './manifest.js';
import { PHASE } from './phases.js';
import { openArchive, verifyBackup } from './verify.js';

export interface RestoreOptions extends CreateOptions {
  archive: string;
  /** Restore into another database on the same server. Created if missing. */
  into?: string | undefined;
  /** The guard's second half: the owner typed the database name back. */
  yes?: boolean | undefined;
  typed?: string | undefined;
  /** Overwrite a private directory that already has files in it. */
  force?: boolean | undefined;
  /** Required when the archive is a `.age` one. */
  passphrase?: string | undefined;
  /** The migrations each installed plugin ships, so its schema can be rebuilt. */
  pluginMigrations?: readonly MigrationSource[] | undefined;
  coreMigrationsDir?: string | undefined;
  /** `false` skips the pre-restore snapshot. The report always says which. */
  snapshot?: boolean | undefined;
  onProgress?: OnProgress | undefined;
}

export interface RestoreReport {
  ok: boolean;
  /** What was restored, in order. */
  did: string[];
  /** What was deliberately not restored, and why. Always includes the vault. */
  didNot: string[];
  /** What the owner has to do next, in order. */
  next: string[];
  manifest: BackupManifest | null;
  /** The pre-restore copy of the target, when one was taken. */
  snapshot: string | null;
  /** True when a step failed and the snapshot was put back. */
  rolledBack: boolean;
  database: LoadReport | null;
}

/** The same URL pointed at another database on the same server. */
export function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The database a URL names. */
export function databaseIn(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

const DB_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function assertDatabaseName(name: string): string {
  if (!DB_NAME.test(name)) {
    throw new Error(
      `refusing to use ${JSON.stringify(name)} as a database name (letters, digits, _ and $)`,
    );
  }
  return name;
}

/**
 * Create the target database if it is not there, over the driver.
 *
 * The admin connection is the same server's `postgres` database, because
 * `create database` cannot run inside the database it creates. No `psql`, no
 * container, nothing but the connection the installation already has.
 */
export async function ensureDatabase(databaseUrl: string, database: string): Promise<boolean> {
  assertDatabaseName(database);
  const admin = createPool(urlForDatabase(databaseUrl, 'postgres'));
  try {
    const { rows } = await admin.query(`select 1 from pg_database where datname = $1`, [database]);
    if (rows.length > 0) return false;
    await admin.query(`create database "${database}"`);
    return true;
  } finally {
    await admin.end().catch(() => {});
  }
}

/** How full the target is, for the guard. */
export async function databaseFootprint(pool: Pool): Promise<{ tables: number; rows: number }> {
  const { rows } = await pool.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as "table"
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname not in ('pg_catalog','information_schema','pg_toast')
        and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'`,
  );
  let total = 0;
  for (const row of rows) {
    const { rows: counted } = await pool.query<{ n: string }>(
      `select count(*)::text as n from "${row.schema}"."${row.table}"`,
    );
    total += Number(counted[0]?.n ?? '0');
  }
  return { tables: rows.length, rows: total };
}

function snapshotName(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `${PRE_RESTORE_PREFIX}${stamp}.tar.gz`;
}

/** Copy one staged directory over an installation directory. */
async function putBack(source: string, dest: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  await cp(source, dest, { recursive: true, force: true, dereference: true });
  await chmod(dest, DIR_MODE).catch(() => {});
  return true;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const progress = opts.onProgress ?? ((): void => {});
  const did: string[] = [];
  const didNot: string[] = [];
  const next: string[] = [];
  let snapshot: string | null = null;
  let rolledBack = false;
  const stop = (manifest: BackupManifest | null): RestoreReport => ({
    ok: false,
    did,
    didNot,
    next,
    manifest,
    snapshot,
    rolledBack,
    database: null,
  });

  if (!opts.databaseUrl) throw new Error('restoreBackup needs a databaseUrl');

  /* 0. verify before touching anything ------------------------------- */
  const verification = await verifyBackup({
    archive: opts.archive,
    ...(opts.passphrase === undefined ? {} : { passphrase: opts.passphrase }),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  if (!verification.ok || verification.manifest === null) {
    didNot.push(
      `nothing — ${path.basename(opts.archive)} did not verify: ${verification.problems.join('; ')}`,
    );
    return stop(verification.manifest);
  }
  const manifest = verification.manifest;
  did.push(`verified ${path.basename(opts.archive)} (${formatBytes(verification.bytes)})`);

  const database = opts.into ?? databaseIn(opts.databaseUrl);
  const targetUrl = urlForDatabase(opts.databaseUrl, database);

  /* 1. the guard ----------------------------------------------------- */
  const created = await ensureDatabase(opts.databaseUrl, database);
  if (created) did.push(`created database "${database}"`);

  const pool = createPool(targetUrl);
  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-restore-'));
  try {
    const footprint = created ? { tables: 0, rows: 0 } : await databaseFootprint(pool);
    const guard = checkRestoreGuard({
      database,
      existingTables: footprint.tables,
      existingRows: footprint.rows,
      yes: opts.yes === true,
      typed: opts.typed,
    });
    if (!guard.ok) {
      didNot.push(`nothing — ${guard.message}`);
      return stop(manifest);
    }

    /* 2. the pre-restore snapshot of the TARGET ---------------------- */
    let snapshotStage: string | null = null;
    if (opts.snapshot !== false && footprint.tables > 0) {
      progress({ phase: PHASE.snapshot, detail: `copying "${database}" before it is replaced` });
      const taken = await createBackup({
        ...opts,
        databaseUrl: targetUrl,
        pool: undefined,
        name: snapshotName(new Date()),
        onProgress: undefined,
      });
      snapshot = taken.archive;
      did.push(`snapshotted "${database}" first: ${snapshot} (${formatBytes(taken.bytes)})`);
      snapshotStage = path.join(stage, 'snapshot');
      await extractAll(snapshot, snapshotStage);
    } else {
      didNot.push(
        `no pre-restore snapshot — ${footprint.tables === 0 ? `"${database}" is empty` : 'it was turned off'}`,
      );
    }

    /* 3. unpack the archive ------------------------------------------ */
    progress({ phase: PHASE.archive, detail: 'unpacking' });
    const opened = await openArchive(opts.archive, opts.passphrase, stage);
    if (opened.problem !== undefined) {
      didNot.push(`nothing — ${opened.problem}`);
      return stop(manifest);
    }
    const from = path.join(stage, 'archive');
    await extractAll(opened.path, from);

    /* 4. the database, then the files -------------------------------- */
    let loaded: LoadReport;
    try {
      progress({ phase: PHASE.database, detail: `loading into "${database}"` });
      loaded = await loadDatabase(pool, from, {
        ...(opts.coreMigrationsDir ? { coreMigrationsDir: opts.coreMigrationsDir } : {}),
        ...(opts.pluginMigrations ? { pluginMigrations: opts.pluginMigrations } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });

      progress({ phase: PHASE.files, detail: 'artifacts and the private directories' });
      await restoreFiles(opts, from, manifest, did, didNot, next);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      didNot.push(`the restore failed: ${why}`);
      if (snapshotStage !== null) {
        progress({ phase: PHASE.rolledBack, detail: why });
        try {
          await loadDatabase(pool, snapshotStage, {
            ...(opts.coreMigrationsDir ? { coreMigrationsDir: opts.coreMigrationsDir } : {}),
            ...(opts.pluginMigrations ? { pluginMigrations: opts.pluginMigrations } : {}),
          });
          await putBack(path.join(snapshotStage, `${PRIVATE_DIR_NAME}/agents`), opts.agentsDir ?? '');
          await putBack(path.join(snapshotStage, `${PRIVATE_DIR_NAME}/skills`), opts.skillsDir ?? '');
          await putBack(
            path.join(snapshotStage, ARTIFACTS_DIR_NAME),
            path.join(opts.dataDir, ARTIFACTS_DIR_NAME),
          );
          rolledBack = true;
          did.push(`rolled "${database}" back to the pre-restore snapshot (${snapshot})`);
        } catch (rollbackErr) {
          didNot.push(
            `the rollback ALSO failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
          next.push(`restore ${snapshot} by hand — it is the copy taken before this run`);
        }
      } else {
        next.push('there was no snapshot to roll back to; restore from another archive');
      }
      return stop(manifest);
    }

    const rows = loaded.loaded.reduce((sum, t) => sum + t.rows, 0);
    did.push(
      `restored ${loaded.loaded.length} table(s) / ${rows} row(s) into "${database}", ` +
        `${loaded.sequences} sequence(s) reset`,
    );
    did.push(`  ${guard.note}`);
    if (loaded.applied.length > 0) {
      did.push(
        `applied ${loaded.applied.length} migration(s) newer than the dump ` +
          `(${loaded.applied.map((a) => `${a.schema}/${a.filename}`).join(', ')})`,
      );
    }
    if (loaded.triggersLeftOn) {
      didNot.push(
        'session_replication_role = replica — this role may not set it; the tables were loaded ' +
          'parent-first instead, which is equivalent here',
      );
    }
    for (const missing of loaded.notLoaded) {
      didNot.push(
        `${missing.table ?? `schema "${missing.schema}"`} (${missing.rows} row(s)) — ${missing.reason}`,
      );
      if (missing.table === undefined) {
        next.push(`buddi plugins install <the plugin that owns "${missing.schema}">, then restore again`);
      }
    }

    /* 5. the vault — the whole point of saying what was not done ------ */
    didNot.push(
      'the vault — no secret value is in a buddi backup, by design. ' +
        `Set ${manifest.secrets.names.length} secret(s) by hand.`,
    );
    for (const command of manifest.secrets.restoreWith) next.push(command);
    next.push('buddi doctor');
    next.push('buddi service restart');

    return { ok: true, did, didNot, next, manifest, snapshot, rolledBack, database: loaded };
  } finally {
    await pool.end().catch(() => {});
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** The private directories, the artifacts, and the two things never written. */
async function restoreFiles(
  opts: RestoreOptions,
  from: string,
  manifest: BackupManifest,
  did: string[],
  didNot: string[],
  next: string[],
): Promise<void> {
  for (const [kind, record, dest] of [
    ['agents', manifest.private.agents, opts.agentsDir],
    ['skills', manifest.private.skills, opts.skillsDir],
  ] as const) {
    if (record === null) {
      didNot.push(`private ${kind} — the archive holds none`);
      continue;
    }
    if (!dest) {
      didNot.push(`private ${kind} — this installation has no ${kind} directory to restore into`);
      continue;
    }
    const source = path.join(from, record.archivePath);
    if (!existsSync(source)) {
      didNot.push(`private ${kind} — ${record.archivePath} is not in the archive`);
      continue;
    }
    const occupied = (await walkFiles(dest)).length;
    if (occupied > 0 && !opts.force) {
      didNot.push(
        `private ${kind} — ${dest} already holds ${occupied} file(s); re-run with --force to overwrite`,
      );
      next.push(`inspect ${dest}, then \`buddi backup restore … --force\` if the archive should win`);
      continue;
    }
    await putBack(source, dest);
    did.push(`restored ${record.files} private ${kind} file(s) to ${dest}`);
  }

  const artifactSource = path.join(from, ARTIFACTS_DIR_NAME);
  if (!manifest.artifacts.included) {
    didNot.push(
      `artifacts — this archive was made with --no-artifacts (${manifest.artifacts.skipped ?? 'skipped'}); ` +
        'the rows in core.artifacts point at files that are not here',
    );
    next.push('restore the artifact files from another backup, or expect broken attachment references');
  } else if (!existsSync(artifactSource)) {
    didNot.push('artifacts — the archive records none');
  } else {
    const dest = path.join(opts.dataDir, ARTIFACTS_DIR_NAME);
    await putBack(artifactSource, dest);
    did.push(`restored ${manifest.artifacts.count} artifact file(s) to ${dest}`);
  }

  if (existsSync(path.join(from, ENV_NAME))) {
    didNot.push(
      `.env — the archive holds a scrubbed copy (${ENV_NAME}) with every secret replaced by "<vault>". ` +
        'It is NOT written over your .env; compare them by hand.',
    );
  }
}
