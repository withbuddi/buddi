/**
 * The backup engine.
 *
 * It lives in core, not in the CLI, because three callers need the same one:
 * `buddi backup` in a developer checkout, the packaged installation's
 * supervisor (a scheduled backup must not depend on a CLI being on PATH), and
 * the dashboard. Nothing in here reads `process.env` or looks for a repository
 * root; every path arrives in an options object.
 *
 * Two things a caller has to know about `restoreBackup`, because neither is
 * visible from the type:
 *
 *  - **`afterDatabase`** runs once the database is loaded and committed, before
 *    any file is written, and inside the region the pre-restore snapshot
 *    covers. If it throws, the whole restore rolls back. It is where the
 *    supervisor writes the recovery row: a restored installation whose recovery
 *    row was not written would start its loops on week-old work, so that
 *    failure has to undo the restore rather than be reported next to it.
 *  - **`<dataDir>/restored-plugins.json`** is written by a successful restore
 *    (mode 0600) whenever the archive carried a `plugins.json`. Nothing is
 *    installed — installing runs migrations and fetches packages, which a
 *    restore must not do — so this is the record of what the archive expected,
 *    for the recovery checklist to compare against what is installed here.
 */
export * from './manifest.js';
export * from './archive.js';
export * from './prune.js';
export * from './dump.js';
export * from './load.js';
export * from './create.js';
export * from './verify.js';
export * from './restore.js';
export * from './phases.js';
export { buddiVersion } from './version.js';
export * from './crypt.js';
export * from './passphrase.js';
