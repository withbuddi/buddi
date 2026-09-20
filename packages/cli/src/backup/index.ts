/**
 * `buddi backup` — the command surface.
 *
 * Every verb prints what it did in plain sentences and returns an exit code; no
 * verb prints a secret, and the one that could (`create`, over `.env`) refuses
 * to write an archive at all if scrubbing left anything behind.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  BACKUP_PASSPHRASE_KEY,
  DEFAULT_KEEP,
  ENCRYPTED_SUFFIX,
  createBackup,
  createPool,
  createVault,
  databaseFootprint,
  encryptFile,
  formatAge,
  formatBytes,
  generatePassphrase,
  listArchives,
  normalizePassphrase,
  pruneArchives,
  restoreBackup,
  urlForDatabase,
  verifyBackup,
  writeEnvelope,
  type BackupManifest,
  type CreateOptions,
  type RestoreOptions,
  type Vault,
} from '@buddi/core';
import { BACKUP_DIR } from '../paths.js';
import { installationOptions, pluginMigrations } from './options.js';
import { createBackupScheduler } from './schedule.js';

export {
  BACKUP_LABEL,
  buildBackupPlist,
  buildBackupTimer,
  createBackupScheduler,
} from './schedule.js';

export type BackupAction = 'create' | 'list' | 'verify' | 'restore' | 'prune' | 'schedule';
export type ScheduleAction = 'install' | 'uninstall' | 'status';

export interface BackupCommand {
  action: BackupAction;
  out?: string | undefined;
  noArtifacts?: boolean;
  prune?: number | undefined;
  keep?: number | undefined;
  archive?: string | undefined;
  into?: string | undefined;
  yes?: boolean;
  force?: boolean;
  /** `restore --files` — the private directories and artifacts as well. */
  files?: boolean;
  /** `create --encrypt`. */
  encrypt?: boolean;
  /** `verify|restore --passphrase "<words>"`. */
  passphrase?: string | undefined;
  scheduleAction?: ScheduleAction | undefined;
}

/** What opened (or will open) an encrypted archive, and where it came from. */
export interface ResolvedPassphrase {
  passphrase: string | undefined;
  source: 'flag' | 'vault' | 'prompt' | 'none';
}

/**
 * The passphrase for a `.age` archive: the flag, then the vault, then a prompt.
 *
 * The flag first because an owner restoring on a **new machine** has the words
 * on paper and no vault yet — that is the case the whole feature exists for.
 * The vault second, so a scheduled encrypted backup and a same-machine restore
 * need nothing typed. The prompt last, and only on a terminal: a cron job must
 * fail with a sentence rather than wait forever for a human who is asleep.
 */
export async function resolvePassphrase(opts: {
  archive: string;
  given?: string | undefined;
  vault?: Vault | undefined;
  ask?: ((question: string) => Promise<string>) | undefined;
  isTty?: boolean | undefined;
}): Promise<ResolvedPassphrase> {
  if (opts.given !== undefined && opts.given.trim() !== '') {
    return { passphrase: normalizePassphrase(opts.given), source: 'flag' };
  }
  if (!opts.archive.endsWith(ENCRYPTED_SUFFIX)) return { passphrase: undefined, source: 'none' };

  if (opts.vault) {
    try {
      const stored = await opts.vault.get(BACKUP_PASSPHRASE_KEY);
      if (stored !== null && stored.trim() !== '') {
        return { passphrase: normalizePassphrase(stored), source: 'vault' };
      }
    } catch {
      // A locked vault is not the end of the road: the owner can still type it.
    }
  }

  const tty = opts.isTty ?? process.stdin.isTTY === true;
  if (tty && opts.ask) {
    const typed = await opts.ask(`Passphrase for ${path.basename(opts.archive)}: `);
    if (typed.trim() !== '') return { passphrase: normalizePassphrase(typed), source: 'prompt' };
  }
  return { passphrase: undefined, source: 'none' };
}

/** The sentence an owner has to act on, printed once, when one is generated. */
export const WRITE_IT_DOWN =
  'Write these six words down on paper and keep them away from this machine. ' +
  'They are the ONLY thing that opens this archive: buddi cannot recover it, ' +
  'and a copy that lives only in this keychain dies with this machine.';

/**
 * The passphrase an encrypted backup is written with.
 *
 * Resolved *before* anything is written, so a locked vault stops the command
 * rather than leaving a plain archive on disk that was supposed to be
 * encrypted. A generated one is stored and printed once; a stored one is used
 * in silence, because printing a secret nobody asked for is how it ends up in
 * a scrollback someone else reads.
 */
export async function ensureBackupPassphrase(
  vault: Vault | undefined,
): Promise<{ passphrase: string; generated: boolean }> {
  if (!vault) {
    throw new Error(
      'there is no vault on this machine to keep the backup passphrase in — ' +
        'set BUDDI_VAULT_KEY, or take a plain backup and encrypt it yourself',
    );
  }
  const stored = await vault.get(BACKUP_PASSPHRASE_KEY);
  if (stored !== null && stored.trim() !== '') {
    return { passphrase: normalizePassphrase(stored), generated: false };
  }
  const passphrase = generatePassphrase();
  await vault.set(BACKUP_PASSPHRASE_KEY, passphrase);
  return { passphrase, generated: true };
}

/** A one-screen summary of what an archive holds. */
export function describeManifest(manifest: BackupManifest): string[] {
  const rows = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  const nonEmpty = manifest.tables.filter((t) => t.rows > 0);
  const lines = [
    `  buddi        ${manifest.buddiVersion} on ${manifest.host}, tz ${manifest.timezone}`,
    `  database     ${manifest.database.name}: ${manifest.tables.length} table(s), ${rows} row(s)`,
    `  migrations   ${manifest.migrations.length} applied` +
      (manifest.migrations.length === 0
        ? ''
        : ` (latest ${manifest.migrations[manifest.migrations.length - 1]?.schema}/${manifest.migrations[manifest.migrations.length - 1]?.filename})`),
    `  artifacts    ${
      manifest.artifacts.included
        ? `${manifest.artifacts.count} file(s), ${formatBytes(manifest.artifacts.bytes)}`
        : `NOT included — ${manifest.artifacts.skipped ?? 'skipped'}`
    }`,
    `  private      agents ${manifest.private.agents?.files ?? 0} file(s), skills ${manifest.private.skills?.files ?? 0} file(s)`,
    `  members      ${manifest.members.length} file(s), each with a sha256`,
    `  secrets      ${
      manifest.secrets.names.length === 0
        ? 'none were set on that machine'
        : `${manifest.secrets.names.length} name(s), NO values: ${manifest.secrets.names.join(', ')}` +
          (manifest.secrets.fromVault.length > 0
            ? ` (${manifest.secrets.fromVault.length} in the vault)`
            : '')
    }`,
  ];
  if (manifest.secrets.redacted.length > 0) {
    lines.push(`  redacted     embedded password(s) in ${manifest.secrets.redacted.join(', ')}`);
  }
  if (nonEmpty.length > 0) {
    lines.push(
      `  biggest      ${[...nonEmpty]
        .sort((a, b) => b.rows - a.rows)
        .slice(0, 5)
        .map((t) => `${t.table}=${t.rows}`)
        .join(', ')}`,
    );
  }
  return lines;
}

async function create(command: BackupCommand, env: NodeJS.ProcessEnv): Promise<number> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set — run `buddi init`');
  const opts: CreateOptions = {
    ...installationOptions(env),
    ...(command.out === undefined ? {} : { backupsDir: path.resolve(command.out) }),
    ...(command.noArtifacts ? { noArtifacts: true } : {}),
  };
  // Before the archive exists, not after: a vault that will not open must stop
  // the command rather than leave a plain archive where an encrypted one was
  // asked for.
  const secret = command.encrypt ? await ensureBackupPassphrase(createVault({ env })) : null;

  const started = Date.now();
  const result = await createBackup(opts);
  if (secret !== null) {
    const encrypted = `${result.archive}${ENCRYPTED_SUFFIX}`;
    await encryptFile(result.archive, encrypted, secret.passphrase);
    const envelope = await writeEnvelope(encrypted);
    // The plaintext goes: leaving it beside the ciphertext would make the
    // encryption a decoration.
    await rm(result.archive, { force: true });
    console.log(`wrote ${encrypted}`);
    console.log(`  encrypted with age (passphrase), envelope ${path.basename(envelope.path)}`);
    console.log(`  ${formatBytes(envelope.envelope.bytes)} in ${((Date.now() - started) / 1000).toFixed(1)}s, mode 0600`);
    if (secret.generated) {
      console.log(`\nyour backup passphrase:\n\n    ${secret.passphrase}\n`);
      console.log(WRITE_IT_DOWN);
      console.log(`It is also in the vault as ${BACKUP_PASSPHRASE_KEY}.`);
    } else {
      console.log(`  passphrase: the one in the vault (${BACKUP_PASSPHRASE_KEY})`);
    }
    for (const line of describeManifest(result.manifest)) console.log(line);
    console.log(`\n${result.manifest.secrets.note}`);
    for (const line of result.manifest.secrets.restoreWith) console.log(`  ${line}`);
    console.log(`\nverify it: buddi backup verify ${encrypted}`);
    if (command.prune !== undefined) {
      const pruned = await pruneArchives(command.prune, path.dirname(encrypted));
      console.log(
        `pruned: kept ${pruned.kept.length}, removed ${pruned.removed.length}` +
          (pruned.removed.length === 0 ? '' : ` (${formatBytes(pruned.freedBytes)} freed)`),
      );
    }
    return 0;
  }
  console.log(`wrote ${result.archive}`);
  console.log(`  ${formatBytes(result.bytes)} in ${((Date.now() - started) / 1000).toFixed(1)}s, mode 0600`);
  for (const line of describeManifest(result.manifest)) console.log(line);
  console.log(`\n${result.manifest.secrets.note}`);
  for (const line of result.manifest.secrets.restoreWith) console.log(`  ${line}`);
  console.log(`\nverify it: buddi backup verify ${result.archive}`);

  if (command.prune !== undefined) {
    const pruned = await pruneArchives(command.prune, path.dirname(result.archive));
    console.log(
      `pruned: kept ${pruned.kept.length}, removed ${pruned.removed.length}` +
        (pruned.removed.length === 0 ? '' : ` (${formatBytes(pruned.freedBytes)} freed)`),
    );
  }
  return 0;
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

async function list(env: NodeJS.ProcessEnv): Promise<number> {
  void env;
  const archives = await listArchives(BACKUP_DIR);
  if (archives.length === 0) {
    console.log(`no backups in ${BACKUP_DIR} — run \`buddi backup create\``);
    return 0;
  }
  console.log(`${archives.length} backup(s) in ${BACKUP_DIR}, newest first\n`);
  const now = Date.now();
  for (const archive of archives) {
    console.log(
      `  ${archive.name}  ${formatBytes(archive.bytes).padStart(9)}  ${formatAge(now - archive.at)}`,
    );
  }
  const total = archives.reduce((sum, a) => sum + a.bytes, 0);
  console.log(`\n${formatBytes(total)} total`);
  return 0;
}

/**
 * An archive that is not there is a typo, not a crash. Both `verify` and
 * `restore` resolve a bare name against the backup directory first, so
 * `buddi backup verify buddi-backup-20260914-033000.tar.gz` works from anywhere.
 */
function resolveArchive(archive: string): string | null {
  const direct = path.resolve(archive);
  if (existsSync(direct)) return direct;
  const inBackupDir = path.join(BACKUP_DIR, archive);
  if (!archive.includes(path.sep) && existsSync(inBackupDir)) return inBackupDir;
  return null;
}

function missing(archive: string): number {
  console.error(`no such archive: ${archive}`);
  console.error(`  looked in ${path.resolve(archive)} and ${BACKUP_DIR}`);
  console.error('  `buddi backup list` shows what you have');
  return 1;
}

async function verify(command: BackupCommand, env: NodeJS.ProcessEnv): Promise<number> {
  const given = command.archive as string;
  const archive = resolveArchive(given);
  if (archive === null) return missing(given);
  const opened = await resolvePassphrase({
    archive,
    given: command.passphrase,
    vault: createVault({ env }),
    ask: promptLine,
  });
  if (opened.source === 'vault') console.log(`passphrase: the one in the vault\n`);
  const result = await verifyBackup({
    archive,
    ...(opened.passphrase === undefined ? {} : { passphrase: opened.passphrase }),
  });
  console.log(`${result.archive}\n`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(10)}  ${check.detail}`);
  }
  if (result.manifest) {
    console.log('');
    for (const line of describeManifest(result.manifest)) console.log(line);
  }
  if (result.ok) {
    console.log('\nthis archive is intact and restorable');
    return 0;
  }
  console.log('');
  for (const problem of result.problems) console.error(`  ${problem}`);
  console.error('\nthis archive is NOT good — do not rely on it');
  return 1;
}

async function restore(command: BackupCommand, env: NodeJS.ProcessEnv): Promise<number> {
  const archive = resolveArchive(command.archive as string);
  if (archive === null) return missing(command.archive as string);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set — run `buddi init`');
  const installation = installationOptions(env);
  const database = command.into ?? new URL(env.DATABASE_URL).pathname.replace(/^\//, '');

  // The guard's second half is the CLI's to collect: the engine decides, the
  // terminal asks. `--yes` alone is never enough over a database with rows in it.
  let typed: string | undefined;
  if (command.yes) {
    const pool = createPool(urlForDatabase(env.DATABASE_URL, database));
    try {
      const footprint = await databaseFootprint(pool).catch(() => ({ tables: 0, rows: 0 }));
      if (footprint.rows > 0) {
        typed = await promptLine(
          `This will REPLACE ${footprint.rows} row(s) in "${database}". Type the database name to confirm: `,
        );
      }
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const opened = await resolvePassphrase({
    archive,
    given: command.passphrase,
    vault: createVault({ env }),
    ask: promptLine,
  });
  if (opened.source === 'vault') console.log('passphrase: the one in the vault');

  const opts: RestoreOptions = {
    ...installation,
    archive,
    ...(opened.passphrase === undefined ? {} : { passphrase: opened.passphrase }),
    pluginMigrations: pluginMigrations(env),
    ...(command.into === undefined ? {} : { into: command.into }),
    ...(command.yes ? { yes: true } : {}),
    ...(typed === undefined ? {} : { typed }),
    ...(command.force ? { force: true } : {}),
    ...(command.files ? { files: true } : {}),
  };
  const report = await restoreBackup(opts);
  console.log('did:');
  for (const line of report.did) console.log(`  ${line}`);
  console.log('\ndid NOT:');
  for (const line of report.didNot) console.log(`  ${line}`);
  if (report.snapshot !== null) {
    console.log(`\nthe copy taken of the target before this run: ${report.snapshot}`);
  }
  if (report.next.length > 0) {
    console.log('\nnow do this, in order:');
    for (const line of report.next) console.log(`  ${line}`);
  }
  return report.ok ? 0 : 1;
}

async function prune(keep: number): Promise<number> {
  const result = await pruneArchives(keep, BACKUP_DIR);
  console.log(`keeping ${result.kept.length} backup(s) in ${BACKUP_DIR}`);
  for (const removed of result.removed) console.log(`  removed ${removed.name} (${formatBytes(removed.bytes)})`);
  if (result.removed.length === 0) console.log('  nothing to remove');
  else console.log(`  ${formatBytes(result.freedBytes)} freed`);
  return 0;
}

async function schedule(action: ScheduleAction, keep: number): Promise<number> {
  const scheduler = createBackupScheduler();
  if (action === 'status') {
    const status = await scheduler.status();
    console.log(`${scheduler.kind}: ${status.detail}`);
    console.log(`  unit: ${status.unitPath}${status.installed ? '' : ' (absent)'}`);
    console.log(`  log:  ${scheduler.logFile}`);
    const archives = await listArchives(BACKUP_DIR);
    const newest = archives[0];
    console.log(
      `  last: ${newest ? `${newest.name} (${formatAge(Date.now() - newest.at)})` : 'no backup has ever run'}`,
    );
    return status.installed ? 0 : 1;
  }
  const notes = action === 'install' ? await scheduler.install(keep) : await scheduler.uninstall();
  for (const note of notes) console.log(note);
  return 0;
}

export async function runBackup(
  command: BackupCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  switch (command.action) {
    case 'create':
      return create(command, env);
    case 'list':
      return list(env);
    case 'verify':
      return verify(command, env);
    case 'restore':
      return restore(command, env);
    case 'prune':
      return prune(command.keep ?? DEFAULT_KEEP);
    case 'schedule':
      return schedule(command.scheduleAction ?? 'status', command.keep ?? DEFAULT_KEEP);
  }
}
