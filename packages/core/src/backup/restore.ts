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
import { chmod, cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { archiveSafetyProblems, extractAll, walkFiles } from './archive.js';
import { createBackup, type CreateOptions, type OnProgress } from './create.js';
import { loadDatabase, type LoadReport, type MigrationSource } from './load.js';
import {
  ARTIFACTS_DIR_NAME,
  DIR_MODE,
  ENV_NAME,
  FILE_MODE,
  PLUGINS_NAME,
  PRE_RESTORE_PREFIX,
  PRIVATE_AGENTS_PATH,
  PRIVATE_SKILLS_PATH,
  RESTORED_PLUGINS_NAME,
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
  /**
   * Restore the private directories and the artifacts as well as the database.
   *
   * Defaults to true, except with `into`: restoring into *another* database is
   * how an owner inspects an archive beside a working installation, and quietly
   * overwriting that installation's agents and artifacts while doing it would
   * be the opposite of what they asked for. The report always says which.
   */
  files?: boolean | undefined;
  /** `false` skips the pre-restore snapshot. The report always says which. */
  snapshot?: boolean | undefined;
  /**
   * Run after the database has been loaded and committed, before the files.
   *
   * It is inside the region the snapshot covers: a hook that throws rolls the
   * whole restore back, exactly as a failing file step does. The supervisor
   * uses it to write the recovery row — the row that keeps the gateway's loops
   * asleep until the owner has been through the checklist. A restored
   * installation whose recovery row was not written is one that wakes up and
   * acts on a week-old queue, so "the row could not be written" has to mean
   * "the restore did not happen", not "the restore happened anyway".
   */
  afterDatabase?: ((pool: Pool) => Promise<void>) | undefined;
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

/**
 * Quote an identifier that came out of the catalog, not out of our code.
 *
 * `dump.ts`'s `quote` refuses anything that is not a plain identifier, which is
 * right there — we choose those names. Here the names are whatever is in the
 * database, including a table someone created with a quote in its name, and the
 * guard's row count must not be the thing that executes it.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
      `select count(*)::text as n from ${quoteIdentifier(row.schema)}.${quoteIdentifier(row.table)}`,
    );
    total += Number(counted[0]?.n ?? '0');
  }
  return { tables: rows.length, rows: total };
}

function snapshotName(at: Date): string {
  return `${PRE_RESTORE_PREFIX}${stampFor(at)}.tar.gz`;
}

/**
 * One directory swapped into place, and everything needed to undo it.
 *
 * `previous` is where the directory that used to be there is parked. It is not
 * deleted until the whole restore has succeeded, because "the restore failed
 * after it replaced your agents" has to be recoverable.
 */
interface DirectorySwap {
  dest: string;
  previous: string | null;
}

/** What a restore has done to the filesystem so far, so it can be undone. */
interface FileEffects {
  swaps: DirectorySwap[];
  /** Individual files written outside a swapped directory. */
  files: string[];
}

/**
 * Put one staged directory where the installation expects it — by replacing it,
 * not by copying into it.
 *
 * `cp -r` over an existing directory *merges*: an agent the owner deleted last
 * week comes back, and a restore that was supposed to reproduce the archive
 * reproduces the archive plus whatever was lying around. So the copy is made
 * into a sibling, the old directory is moved aside, and the new one is renamed
 * into place — one atomic step, with the previous contents still on disk under
 * `<dest>.previous-<time>` until the restore as a whole succeeds.
 */
async function putBack(source: string, dest: string, stamp: string): Promise<DirectorySwap | null> {
  if (!existsSync(source)) return null;
  // An installation without this directory configured is not an error: it is an
  // installation that has nowhere to put these files, and the report says so.
  if (dest.trim() === '') return null;

  const abs = path.resolve(dest);
  const info = await stat(abs).catch(() => null);
  if (info && !info.isDirectory()) {
    throw new Error(`${abs} exists and is not a directory; refusing to replace it`);
  }

  await mkdir(path.dirname(abs), { recursive: true, mode: DIR_MODE });
  const staging = `${abs}.restoring-${stamp}`;
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, dereference: true });
  await chmod(staging, DIR_MODE).catch(() => {});

  let previous: string | null = null;
  if (info) {
    previous = `${abs}.previous-${stamp}`;
    await rm(previous, { recursive: true, force: true });
    await rename(abs, previous);
  }
  try {
    await rename(staging, abs);
  } catch (err) {
    if (previous !== null) await rename(previous, abs).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { dest: abs, previous };
}

/** Put every swapped directory back the way it was, newest first. */
async function undoSwaps(effects: FileEffects): Promise<void> {
  for (const file of [...effects.files].reverse()) {
    await rm(file, { force: true }).catch(() => {});
  }
  for (const swap of [...effects.swaps].reverse()) {
    await rm(swap.dest, { recursive: true, force: true }).catch(() => {});
    if (swap.previous !== null) await rename(swap.previous, swap.dest).catch(() => {});
  }
}

/** The restore worked: the directories it replaced are not needed any more. */
async function dropPrevious(effects: FileEffects): Promise<void> {
  for (const swap of effects.swaps) {
    if (swap.previous !== null) await rm(swap.previous, { recursive: true, force: true }).catch(() => {});
  }
}

/** A stamp both `.restoring-` and `.previous-` share, so one run is one set. */
function stampFor(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
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
    // Tables are not the only thing worth saving. An installation whose
    // database is empty but whose `agents/` holds a year of the owner's own
    // writing has everything to lose from a restore that goes wrong, and the
    // old "snapshot only when there are tables" rule gave it nothing.
    const restoringFiles = opts.files ?? opts.into === undefined;
    const managed = restoringFiles
      ? [opts.agentsDir, opts.skillsDir, path.join(opts.dataDir, ARTIFACTS_DIR_NAME)].filter(
          (dir): dir is string => typeof dir === 'string' && dir.trim() !== '',
        )
      : [];
    let filesPresent = false;
    for (const dir of managed) {
      if ((await walkFiles(dir)).length > 0) {
        filesPresent = true;
        break;
      }
    }

    let snapshotStage: string | null = null;
    if (opts.snapshot !== false && (footprint.tables > 0 || filesPresent)) {
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
        `no pre-restore snapshot — ${
          opts.snapshot === false
            ? 'it was turned off'
            : `"${database}" is empty and no agent, skill or artifact file is here`
        }`,
      );
    }

    /* 3. unpack the archive ------------------------------------------ */
    progress({ phase: PHASE.archive, detail: 'unpacking' });
    const opened = await openArchive(opts.archive, opts.passphrase, stage);
    if (opened.problem !== undefined) {
      didNot.push(`nothing — ${opened.problem}`);
      return stop(manifest);
    }
    // Verification already read the member list, but `tar` is about to write
    // files as this process, so the list is checked again against the very
    // file that is being unpacked.
    const unsafe = await archiveSafetyProblems(opened.path);
    if (unsafe.length > 0) {
      didNot.push(`nothing — ${path.basename(opts.archive)} holds unsafe paths: ${unsafe.join('; ')}`);
      return stop(manifest);
    }
    const from = path.join(stage, 'archive');
    await extractAll(opened.path, from);

    /* 4. the database, then the files -------------------------------- */
    const effects: FileEffects = { swaps: [], files: [] };
    const stamp = stampFor(new Date());
    let loaded: LoadReport;
    try {
      progress({ phase: PHASE.database, detail: `loading into "${database}"` });
      loaded = await loadDatabase(pool, from, {
        ...(opts.coreMigrationsDir ? { coreMigrationsDir: opts.coreMigrationsDir } : {}),
        ...(opts.pluginMigrations ? { pluginMigrations: opts.pluginMigrations } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });

      // The caller's own step, inside the rollback: see `afterDatabase`.
      if (opts.afterDatabase) await opts.afterDatabase(pool);

      if (restoringFiles) {
        progress({ phase: PHASE.files, detail: 'artifacts and the private directories' });
        await restoreFiles(opts, from, manifest, effects, stamp, did, didNot, next);
      } else {
        didNot.push(
          `the database only — files were not touched; add --files to restore agents, ` +
            'skills and artifacts too',
        );
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      didNot.push(`the restore failed: ${why}`);
      progress({ phase: PHASE.rolledBack, detail: why });
      // The files first, and always: every directory this run replaced is put
      // back from the copy parked beside it, which is the installation's own
      // last state rather than the snapshot's copy of it.
      await undoSwaps(effects);
      if (snapshotStage !== null) {
        try {
          await loadDatabase(pool, snapshotStage, {
            ...(opts.coreMigrationsDir ? { coreMigrationsDir: opts.coreMigrationsDir } : {}),
            ...(opts.pluginMigrations ? { pluginMigrations: opts.pluginMigrations } : {}),
          });
          rolledBack = true;
          did.push(`rolled "${database}" back to the pre-restore snapshot (${snapshot})`);
        } catch (rollbackErr) {
          didNot.push(
            `the rollback ALSO failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
          next.push(`restore ${snapshot} by hand — it is the copy taken before this run`);
        }
      } else {
        // Nothing was here to save, so there is nothing to put back — but the
        // database may be half-loaded, and a half-loaded schema is worse than
        // an empty one. An empty, freshly migrated database is a state buddi
        // can start in; this one is not.
        try {
          await migrate(pool, {
            schema: CORE_SCHEMA,
            dir: opts.coreMigrationsDir ?? CORE_MIGRATIONS_DIR,
          });
          rolledBack = true;
          did.push(
            `"${database}" was empty before this run and was left at a clean, freshly migrated schema`,
          );
          next.push('nothing was lost — the target was empty; try another archive');
        } catch (cleanErr) {
          didNot.push(
            `the database could not be left clean either: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`,
          );
          next.push('there was no snapshot to roll back to; restore from another archive');
        }
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

    // Every step is through: the directories that were moved aside are not
    // coming back, so they stop taking up the owner's disk.
    await dropPrevious(effects);

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
  effects: FileEffects,
  stamp: string,
  did: string[],
  didNot: string[],
  next: string[],
): Promise<void> {
  for (const [kind, record, dest, expected] of [
    ['agents', manifest.private.agents, opts.agentsDir, PRIVATE_AGENTS_PATH],
    ['skills', manifest.private.skills, opts.skillsDir, PRIVATE_SKILLS_PATH],
  ] as const) {
    if (record === null) {
      didNot.push(`private ${kind} — the archive holds none`);
      continue;
    }
    if (!dest || dest.trim() === '') {
      didNot.push(`private ${kind} — this installation has no ${kind} directory to restore into`);
      continue;
    }
    // The manifest arrives with the archive and is not trusted about where in
    // the archive to read from: there is exactly one answer, and anything else
    // — `../../.ssh`, an absolute path, a different directory — is refused.
    if (record.archivePath !== expected) {
      didNot.push(
        `private ${kind} — the archive says they live at ${JSON.stringify(record.archivePath)}, ` +
          `and a buddi archive keeps them at ${expected}; refusing to read from it`,
      );
      continue;
    }
    const source = path.join(from, record.archivePath);
    if (!source.startsWith(`${path.resolve(from)}${path.sep}`)) {
      didNot.push(`private ${kind} — ${record.archivePath} resolves outside the archive`);
      continue;
    }
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
    const swap = await putBack(source, dest, stamp);
    if (swap === null) continue;
    effects.swaps.push(swap);
    did.push(
      `restored ${record.files} private ${kind} file(s) to ${dest}` +
        (swap.previous === null ? '' : ' (what was there is replaced, not merged)'),
    );
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
    const swap = await putBack(artifactSource, dest, stamp);
    if (swap !== null) {
      effects.swaps.push(swap);
      did.push(`restored ${manifest.artifacts.count} artifact file(s) to ${dest}`);
    }
  }

  /* The plugins the archive expected, for the recovery checklist ----- */
  // Not installed, only recorded: installing a plugin runs its migrations and
  // fetches its package, and a restore is not the moment to do either. The
  // checklist reads this file and tells the owner what is missing.
  const pluginsSource = path.join(from, PLUGINS_NAME);
  if (existsSync(pluginsSource)) {
    const dest = path.join(opts.dataDir, RESTORED_PLUGINS_NAME);
    await mkdir(opts.dataDir, { recursive: true, mode: DIR_MODE });
    await cp(pluginsSource, dest, { force: true });
    await chmod(dest, FILE_MODE).catch(() => {});
    effects.files.push(dest);
    did.push(`wrote ${dest} — what the archive had installed, for the recovery checklist`);
  } else {
    didNot.push(`plugins — the archive holds no ${PLUGINS_NAME}, so nothing was recorded for the checklist`);
  }

  if (existsSync(path.join(from, ENV_NAME))) {
    didNot.push(
      `.env — the archive holds a scrubbed copy (${ENV_NAME}) with every secret replaced by "<vault>". ` +
        'It is NOT written over your .env; compare them by hand.',
    );
  }
}
