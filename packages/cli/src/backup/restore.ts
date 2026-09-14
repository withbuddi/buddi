/**
 * `buddi backup restore` — put an installation back.
 *
 * Three rules, in the order they matter:
 *
 * 1. **Never silently destroy a live installation.** A target with rows in it
 *    needs `--yes` *and* the database name typed back. One confirmation is the
 *    number a person clicks through without reading.
 * 2. **Say what happened.** Every step reports "did" or "did not", including the
 *    things this command cannot do — the vault above all. A restore that leaves
 *    the owner guessing which half worked is not a restore.
 * 3. **Nothing is restored from an archive that did not verify.** The checksums
 *    run first, every time; `--force` does not skip them.
 */
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from '@buddi/core';
import { agentSearchPath } from '@buddi/gateway';
import { REPO_ROOT } from '../paths.js';
import { extractAll, walkFiles } from './archive.js';
import {
  ARTIFACTS_DIR_NAME,
  DIR_MODE,
  DUMP_NAME,
  ENV_NAME,
  PRIVATE_DIR_NAME,
  checkRestoreGuard,
  formatBytes,
  type BackupManifest,
} from './manifest.js';
import {
  createDatabase,
  databaseExists,
  databaseFootprint,
  parseDatabaseUrl,
  restoreDatabase,
  urlForDatabase,
} from './pg.js';
import { verifyArchive } from './verify.js';

export interface RestoreOptions {
  archive: string;
  /** Restore into another database on the same server. Created if missing. */
  into?: string | undefined;
  yes?: boolean;
  /** Overwrite a private directory that already has files in it. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * How the owner is asked to type the database name. Injected so the guard is
   * testable and so `--yes` in a script is not silently a different command.
   */
  confirm?: (prompt: string) => Promise<string>;
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
}

/** Ask on the terminal. Returns '' when there is no terminal to ask on. */
export async function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const env = opts.env ?? process.env;
  const did: string[] = [];
  const didNot: string[] = [];
  const next: string[] = [];
  const stop = (manifest: BackupManifest | null): RestoreReport => ({
    ok: false,
    did,
    didNot,
    next,
    manifest,
  });

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — run `buddi init`');
  const serverTarget = parseDatabaseUrl(databaseUrl);

  /* 0. verify before touching anything ------------------------------- */
  const verification = await verifyArchive(opts.archive);
  if (!verification.ok || verification.manifest === null) {
    didNot.push(
      `nothing — ${path.basename(opts.archive)} did not verify: ${verification.problems.join('; ')}`,
    );
    return stop(verification.manifest);
  }
  const manifest = verification.manifest;
  did.push(`verified ${path.basename(opts.archive)} (${formatBytes(verification.bytes)})`);

  const database = opts.into ?? manifest.database.name;

  /* 1. the guard ----------------------------------------------------- */
  const exists = await databaseExists({ repoRoot: REPO_ROOT, target: serverTarget, database });
  let footprint = { tables: 0, rows: 0 };
  if (exists) {
    const pool = createPool(urlForDatabase(databaseUrl, database));
    try {
      footprint = await databaseFootprint(pool);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  let typed: string | undefined;
  if (footprint.rows > 0 && opts.yes) {
    const ask = opts.confirm ?? promptLine;
    typed = await ask(
      `This will REPLACE ${footprint.rows} row(s) in "${database}". Type the database name to confirm: `,
    );
  }
  const guard = checkRestoreGuard({
    database,
    existingTables: footprint.tables,
    existingRows: footprint.rows,
    yes: opts.yes === true,
    typed,
  });
  if (!guard.ok) {
    didNot.push(`nothing — ${guard.message}`);
    return stop(manifest);
  }

  /* 2. unpack -------------------------------------------------------- */
  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-restore-'));
  try {
    await extractAll(opts.archive, stage);

    /* 3. the database ------------------------------------------------ */
    if (!exists) {
      await createDatabase({ repoRoot: REPO_ROOT, target: serverTarget, database });
      did.push(`created database "${database}"`);
    }
    const notice = await restoreDatabase({
      repoRoot: REPO_ROOT,
      target: serverTarget,
      database,
      inFile: path.join(stage, DUMP_NAME),
    });
    const restoredRows = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
    did.push(
      `restored ${manifest.tables.length} table(s) / ${restoredRows} row(s) into "${database}" ` +
        `(pg_restore --single-transaction: all or nothing)${notice === '' ? '' : ` [${notice.split('\n')[0]}]`}`,
    );
    did.push(`  ${guard.note}`);

    /* 4. the private directories ------------------------------------- */
    const search = agentSearchPath(env);
    for (const [kind, record, dest] of [
      ['agents', manifest.private.agents, search.owner.dir],
      ['skills', manifest.private.skills, search.owner.skillsDir],
    ] as const) {
      if (record === null) {
        didNot.push(`private ${kind} — the archive holds none`);
        continue;
      }
      const source = path.join(stage, record.archivePath);
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
      await cp(source, dest, { recursive: true, force: true, dereference: true });
      await chmod(dest, DIR_MODE).catch(() => {});
      did.push(`restored ${record.files} private ${kind} file(s) to ${dest}`);
    }

    /* 5. the artifacts ------------------------------------------------ */
    const artifactSource = path.join(stage, ARTIFACTS_DIR_NAME);
    const dataDir = env.BUDDI_DATA_DIR ? path.resolve(env.BUDDI_DATA_DIR) : path.join(REPO_ROOT, 'data');
    if (!manifest.artifacts.included) {
      didNot.push(
        `artifacts — this archive was made with --no-artifacts (${manifest.artifacts.skipped ?? 'skipped'}); ` +
          'the rows in core.artifacts point at files that are not here',
      );
      next.push('restore the artifact files from another backup, or expect broken attachment references');
    } else if (!existsSync(artifactSource)) {
      didNot.push('artifacts — the archive records none');
    } else {
      const dest = path.join(dataDir, ARTIFACTS_DIR_NAME);
      await cp(artifactSource, dest, { recursive: true, force: true, dereference: true });
      did.push(`restored ${manifest.artifacts.count} artifact file(s) to ${dest}`);
    }

    /* 6. `.env` — never written over ---------------------------------- */
    if (existsSync(path.join(stage, ENV_NAME))) {
      didNot.push(
        `.env — the archive holds a scrubbed copy (${ENV_NAME}) with every secret replaced by "<vault>". ` +
          'It is NOT written over your .env; compare them by hand.',
      );
    }

    /* 7. the vault — the whole point of saying what was not done ------ */
    didNot.push(
      'the vault — no secret value is in a buddi backup, by design. ' +
        `Set ${manifest.secrets.names.length} secret(s) by hand.`,
    );
    for (const command of manifest.secrets.restoreWith) next.push(command);
    next.push('buddi doctor');
    next.push('buddi service restart');

    return { ok: true, did, didNot, next, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
