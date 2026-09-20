/**
 * The backup engine.
 *
 * It lives in core, not in the CLI, because three callers need the same one:
 * `buddi backup` in a developer checkout, the packaged installation's
 * supervisor (a scheduled backup must not depend on a CLI being on PATH), and
 * the dashboard. Nothing in here reads `process.env` or looks for a repository
 * root; every path arrives in an options object.
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
