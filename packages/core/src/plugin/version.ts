/**
 * The version of `ctx.buddi` (docs/specs/plugin-host-api.md §7).
 *
 * `major.minor`. A minor adds a method, an optional argument or an optional
 * field on a return and never changes what an existing call does; a major
 * removes or changes something. A plugin says which version it was built
 * against as `buddi.hostApi` in its `package.json`, and one that asks for more
 * than this buddi has is refused when it is staged, before anything of it runs.
 */

/** What this build's `ctx.buddi.version` says. */
export const HOST_API_VERSION = '1.0';

interface HostApiVersion {
  major: number;
  minor: number;
}

function parseVersion(text: string): HostApiVersion | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(text.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2] ?? '0') };
}

/**
 * Why a plugin asking for `range` cannot run on a host at `have`, or undefined
 * when it can.
 *
 * The range is read the way npm reads the forms an author writes here:
 * `^1.2` and `1.2` mean "1.2 or a later 1.x", `~1.2` "a later 1.2", and
 * `>=1.2` "1.2 or anything later". What decides is whether this host has the
 * methods the plugin was built against — the major must be this one (or, for
 * `>=`, not newer) and the minor no newer than this one's.
 */
export function hostApiProblem(range: string, have: string = HOST_API_VERSION): string | undefined {
  const host = parseVersion(have);
  if (host === undefined) throw new Error(`host API version "${have}" is not major.minor`);
  const match = /^\s*(\^|~|>=)?\s*v?(\S+)\s*$/.exec(range);
  const wanted = match === null ? undefined : parseVersion(match[2] as string);
  if (match === null || wanted === undefined) {
    return (
      `it asks for host API ${JSON.stringify(range)}, which is not a version this buddi can read ` +
      `(write "^${host.major}.${host.minor}")`
    );
  }
  const operator = match[1] ?? '^';
  const newerMinor = wanted.major === host.major && wanted.minor > host.minor;
  const refused =
    operator === '>='
      ? wanted.major > host.major || newerMinor
      : wanted.major !== host.major || newerMinor;
  if (!refused) return undefined;
  return (
    `it was built for host API ${range.trim()}, and this buddi has ${have}. ` +
    (wanted.major < host.major && operator !== '>='
      ? 'It needs an older buddi, or a version of the plugin built for this one.'
      : 'Update buddi first, or install a version of the plugin built for this one.')
  );
}
