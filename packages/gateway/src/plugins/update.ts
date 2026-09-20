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
import { InstallRefusal } from './install.js';
import { recordFile } from './load.js';
import { rejectStaged, stagePlugin, type StageOptions, type StagedPlugin } from './stage.js';

/** Split `1.2.3-rc.1` into numbers and a prerelease tail. */
function parts(version: string): { numbers: number[]; pre: string } {
  const [core = '', ...rest] = version.trim().replace(/^v/, '').split('-');
  return {
    numbers: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
    pre: rest.join('-'),
  };
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Enough semver for the one question an update asks. A release beats a
 * prerelease of the same numbers, and two prereleases compare as text, which
 * is right for `rc.1` and `rc.2` and good enough for everything else.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.numbers[i] ?? 0;
    const right = b.numbers[i] ?? 0;
    if (left !== right) return left > right;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === '') return true;
  if (b.pre === '') return false;
  return a.pre > b.pre;
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

  if (opts.allowDowngrade !== true && !isNewerVersion(staged.version, record.version)) {
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
