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
import { parsePluginSpec } from './spec.js';
import { InstallRefusal } from './refusals.js';
import { packageUses, recordFile } from './load.js';
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
  /**
   * Take the new version from this npm package instead of from where the
   * installed one came. Browse passes it: a plugin installed from a directory
   * or a file, once it is listed on withbuddi.com, updates to the published
   * package, and the record follows (its source becomes the registry). A
   * path is refused here; only a package name may replace a source.
   */
  from?: string;
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
  // What the installed version declared it reaches, so the card can say what
  // the new one adds. Unreadable is nothing: the card then lists every area.
  const installedUses = packageUses(record.entry);
  const { from, ...stageOpts } = opts;
  if (from !== undefined && parsePluginSpec(from).kind !== 'registry') {
    throw new InstallRefusal('bad-from', `"${from}" is not an npm package; an update from elsewhere names a package.`);
  }
  const staged = await stagePlugin(from ?? specFor(record, opts.version), {
    ...stageOpts,
    env,
    previous,
    previousUses: installedUses.ok ? installedUses.uses : [],
    previousSource: record.source,
  });

  let newer = true;
  if (opts.allowDowngrade !== true) {
    try {
      newer = isNewerVersion(staged.version, record.version);
      // A folder the owner builds in is reread at the same version: a refresh
      // ("Reinstall from folder"). Its migrations ledger is unchanged — the
      // same version runs nothing new — and it is approved like any update.
      if (!newer && isRefresh(record, staged, from)) newer = true;
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

/**
 * Is this stage the installed folder read again at the same version? Only a
 * directory install, from that same directory, at an equal version.
 */
export function isRefresh(record: Pick<InstalledPlugin, 'version' | 'source'>, staged: Pick<StagedPlugin, 'version'>, from?: string): boolean {
  if (from !== undefined || record.source.kind !== 'directory') return false;
  const a = parseSemver(staged.version);
  const b = parseSemver(record.version);
  return a !== undefined && b !== undefined && compareSemver(a, b) === 0;
}

/** What to stage for this record: the same source, at the asked-for version. */
function specFor(record: InstalledPlugin, version?: string): string {
  if (record.source.kind === 'registry') {
    return `${record.source.name}@${version ?? 'latest'}`;
  }
  if (record.source.kind === 'tarball') return record.source.path;
  return record.source.path;
}
