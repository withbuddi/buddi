/**
 * Updating an installed plugin.
 *
 * An update is a stage plus the same two approvals, and that is deliberate:
 * the new version is somebody else's code just as much as the first one was,
 * it may have grown a tool, a host or a schema, and "it was fine last month"
 * is not a security property. So `updatePlugin` only stages; approving is the
 * same call the first install uses.
 *
 * The one rule an update adds is **newer only**. Downgrading a plugin means
 * running migrations backwards, which this system has never been able to do —
 * the ledger in `core.migrations` records what was applied and nothing knows
 * how to undo it. Refusing here, with the two versions named, is the honest
 * version of that limitation.
 */
import { readPluginsFile, type InstalledPlugin } from '@buddi/core';
import { InstallRefusal } from './refusals.js';
import { recordFile } from './load.js';
import { rejectStaged, stagePlugin, type StageOptions, type StagedPlugin } from './stage.js';

/** A version, taken apart the way semver 2.0.0 says to. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated identifiers after `-`, empty for a release. */
  prerelease: Array<string | number>;
}

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parse a version, or refuse it.
 *
 * The version string decides whether an update is allowed to happen, so
 * something that is not a version is not a comparison this can do: `latest`,
 * `2`, `1.0.0.0` and an empty string all used to parse into numbers here (via
 * `parseInt` and a `|| 0`) and compare as if they meant something. Build
 * metadata is parsed and then ignored, which is what the specification says to
 * do with it.
 */
export function parseSemver(version: string): Semver | undefined {
  const match = SEMVER.exec(version.trim());
  if (!match) return undefined;
  const prerelease = (match[4] ?? '')
    .split('.')
    .filter((id) => id !== '')
    .map((id) => (/^\d+$/.test(id) ? Number.parseInt(id, 10) : id));
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
    patch: Number.parseInt(match[3] as string, 10),
    prerelease,
  };
}

/** -1, 0 or 1, by semver's own precedence rules. Build metadata is ignored. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A release outranks any prerelease of the same numbers.
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    // A shorter set of identifiers is lower, when everything before was equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = typeof left === 'number';
    const rightNumeric = typeof right === 'number';
    // Numeric identifiers always compare lower than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left === right) continue;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Refuses anything that is not a semver rather than guessing: a version this
 * cannot read is a version it cannot say is newer, and "not newer" is the
 * answer that stops an update, so guessing here is how a downgrade gets
 * through.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) {
    throw new InstallRefusal(
      'bad-version',
      `"${a === undefined ? candidate : current}" is not a version this can compare (major.minor.patch, ` +
        'optionally with a -prerelease). An update is allowed only when the new version is provably ' +
        'newer than the installed one, and this comparison cannot be made.',
    );
  }
  return compareSemver(a, b) > 0;
}

export interface UpdateOptions extends StageOptions {
  /** The version to move to. `latest` when nothing is said. */
  version?: string;
  /** Stage an older version anyway. The CLI never passes it; nothing else does. */
  allowDowngrade?: boolean;
}

/**
 * Stage the next version of an installed plugin. Approving it is the caller's
 * next step, and it is the same approval as a first install.
 */
export async function updatePlugin(name: string, opts: UpdateOptions = {}): Promise<StagedPlugin> {
  const env = opts.env ?? process.env;
  const contents = readPluginsFile(recordFile(env));
  const record: InstalledPlugin | undefined = contents.plugins.find((p) => p.name === name.trim());
  if (record === undefined) {
    throw new InstallRefusal(
      'not-installed',
      `"${name}" is not installed here, so there is nothing to update. ${
        contents.plugins.length === 0
          ? 'Nothing is installed beyond what this build ships.'
          : `Installed: ${contents.plugins.map((p) => p.name).join(', ')}.`
      }`,
    );
  }

  const previous = { name: record.name, version: record.version };
  const staged = await stagePlugin(specFor(record, opts.version), {
    ...opts,
    env,
    previous,
  });

  let newer = true;
  if (opts.allowDowngrade !== true) {
    try {
      newer = isNewerVersion(staged.version, record.version);
    } catch (err) {
      // A version nobody can compare is still unapproved code on disk.
      rejectStaged(staged.id, env);
      throw err;
    }
  }
  if (!newer) {
    // The stage holds unapproved third-party code; it goes, exactly as a
    // rejection would remove it.
    rejectStaged(staged.id, env);
    throw new InstallRefusal(
      'not-newer',
      `${record.name} ${record.version} is installed and ${staged.version} is what that resolves to now, ` +
        'which is not newer. Migrations only run forward here, so a downgrade is not an upgrade with a ' +
        'smaller number: uninstall it and install the version you want, deciding what happens to its data.',
    );
  }
  return staged;
}

/** What to stage for this record: the same source, at the asked-for version. */
function specFor(record: InstalledPlugin, version?: string): string {
  if (record.source.kind === 'registry') {
    return `${record.source.name}@${version ?? 'latest'}`;
  }
  if (record.source.kind === 'tarball') return record.source.path;
  return record.source.path;
}
