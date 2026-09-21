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
import { compareSemver, parseSemver, readPluginsFile, type InstalledPlugin } from '@buddi/core';
import { InstallRefusal } from './refusals.js';
import { recordFile } from './load.js';
import { rejectStaged, stagePlugin, type StageOptions, type StagedPlugin } from './stage.js';

// The comparison itself lives in `@buddi/core` (`semver.ts`): the supervisor's
// version check and the dashboard's disk fallback ask the same question of the
// same code. Re-exported here because this is where callers have always found it.
export { compareSemver, parseSemver, type Semver } from '@buddi/core';

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
