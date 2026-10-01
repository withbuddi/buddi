/**
 * One semver comparison for the whole repository.
 *
 * Three places ask "is that one newer": a plugin update (which refuses to go
 * backwards), the supervisor's version check, and the dashboard reading the
 * upgrade record off disk when the socket is gone. They have to agree, because
 * a version the three read differently is an upgrade offered by one of them and
 * refused by another.
 *
 * This module is deliberately a leaf: no imports, no path constants, no
 * environment. That is what lets `@buddi/install` take a value import from it
 * (through the `@buddi/core/semver` subpath) although it may load nothing else
 * from a `@buddi/*` package before `environment()` has run.
 */

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
 * Compare two version strings, or say they cannot be compared.
 *
 * `undefined` rather than a guess: a version this cannot read is a version it
 * cannot call newer, and every caller here treats "cannot say" as "do not
 * offer the upgrade".
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === undefined || right === undefined) return undefined;
  return compareSemver(left, right);
}

/** Is `candidate` a version, and a later one than `current`? */
export function isNewerRelease(candidate: string | undefined, current: string): boolean {
  if (candidate === undefined) return false;
  const order = compareVersions(candidate, current);
  return order !== undefined && order > 0;
}

/*
 * Ranges, for a plugin's `requires` (docs/plugins.md §2.9): the forms npm
 * authors write — `^1.2.0`, `~1.2`, `>=1.0.0 <2`, `1.x`, `*`, `1.2.3`, and
 * alternatives joined with `||`. A prerelease is compared by plain semver
 * order; npm's extra rule that only a comparator naming the same numbers may
 * match one is not applied, because plugin versions are releases.
 */

type Comparator = { op: '>=' | '>' | '<' | '<=' | '='; version: Semver };

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Partial3 {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: Array<string | number>;
}

function parsePartial(text: string): Partial3 | undefined {
  const match = PARTIAL.exec(text);
  if (!match) return undefined;
  const num = (part: string | undefined): number | undefined =>
    part === undefined || /^[xX*]$/.test(part) ? undefined : Number.parseInt(part, 10);
  const major = num(match[1]);
  const minor = major === undefined ? undefined : num(match[2]);
  const patch = minor === undefined ? undefined : num(match[3]);
  const prerelease = patch === undefined ? [] : (match[4] ?? '').split('.').filter((id) => id !== '').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { ...(major === undefined ? {} : { major }), ...(minor === undefined ? {} : { minor }), ...(patch === undefined ? {} : { patch }), prerelease };
}

const at = (major: number, minor = 0, patch = 0, prerelease: Array<string | number> = []): Semver => ({ major, minor, patch, prerelease });

/** One space-separated part of a range, as comparators; undefined when it cannot be read. */
function comparatorsOf(part: string): Comparator[] | undefined {
  const match = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(part);
  if (!match) return undefined;
  const op = match[1] ?? '';
  const p = parsePartial(match[2] as string);
  if (p === undefined) return undefined;
  if (p.major === undefined) return op === '' || op === '=' || op === '>=' ? [] : op === '<' ? [{ op: '<', version: at(0, 0, 0, [0]) }] : [];
  const M = p.major;
  const exact = p.minor !== undefined && p.patch !== undefined;
  const low = at(M, p.minor ?? 0, p.patch ?? 0, p.prerelease);
  switch (op) {
    case '':
    case '=':
      if (exact) return [{ op: '=', version: low }];
      return p.minor === undefined ? [{ op: '>=', version: at(M) }, { op: '<', version: at(M + 1) }] : [{ op: '>=', version: at(M, p.minor) }, { op: '<', version: at(M, p.minor + 1) }];
    case '^': {
      const upper = M > 0 || p.minor === undefined ? at(M + 1) : p.minor > 0 || p.patch === undefined ? at(0, p.minor + 1) : at(0, 0, p.patch + 1);
      return [{ op: '>=', version: low }, { op: '<', version: upper }];
    }
    case '~':
    case '~>':
      return [{ op: '>=', version: low }, { op: '<', version: p.minor === undefined ? at(M + 1) : at(M, p.minor + 1) }];
    case '>=':
      return [{ op: '>=', version: low }];
    case '<':
      return [{ op: '<', version: low }];
    case '>':
      return exact ? [{ op: '>', version: low }] : [{ op: '>=', version: p.minor === undefined ? at(M + 1) : at(M, p.minor + 1) }];
    case '<=':
      return exact ? [{ op: '<=', version: low }] : [{ op: '<', version: p.minor === undefined ? at(M + 1) : at(M, p.minor + 1) }];
    default:
      return undefined;
  }
}

function parseRange(range: string): Comparator[][] | undefined {
  const alternatives = range.trim() === '' ? ['*'] : range.split('||');
  const out: Comparator[][] = [];
  for (const alternative of alternatives) {
    // `>= 1.2` is one part: the operator sticks to what follows it.
    const parts = alternative.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter((s) => s !== '');
    if (parts.length === 0) return undefined;
    const set: Comparator[] = [];
    for (const part of parts) {
      const comparators = comparatorsOf(part);
      if (comparators === undefined) return undefined;
      set.push(...comparators);
    }
    out.push(set);
  }
  return out;
}

/** Whether a range is one this module can read. */
export function isSemverRange(range: string): boolean {
  return typeof range === 'string' && range.length <= 200 && parseRange(range) !== undefined;
}

/**
 * Does `version` fall in `range`? Undefined when either cannot be read, which
 * every caller treats as "no": a requirement nobody can check is not met.
 */
export function satisfiesRange(version: string, range: string): boolean | undefined {
  const v = parseSemver(version);
  const sets = parseRange(range);
  if (v === undefined || sets === undefined) return undefined;
  return sets.some((set) =>
    set.every(({ op, version: bound }) => {
      const order = compareSemver(v, bound);
      return op === '=' ? order === 0 : op === '>=' ? order >= 0 : op === '>' ? order > 0 : op === '<' ? order < 0 : order <= 0;
    }),
  );
}

/** A bound the way people say it: 0.2.0 is "0.2", 1.2.3 stays "1.2.3". */
function versionWords(v: Semver): string {
  const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
  return v.patch === 0 && pre === '' ? `${v.major}.${v.minor}` : `${v.major}.${v.minor}.${v.patch}${pre}`;
}

/**
 * A range in words, for the owner: `^0.2.0` is "0.2 or newer", `>=1 <2` is
 * "1.0 or newer, before 2.0", `*` is "any version", `1.2.3` is "1.2.3".
 * The ceiling a `^` or `~` keeps is said only when `installed` is at or past
 * it ("0.2 or newer, before 0.3"), the one time it explains a refusal. A
 * range this module cannot read is given back as written.
 */
export function rangeWords(range: string, opts: { installed?: string | undefined } = {}): string {
  const sets = parseRange(range);
  if (sets === undefined) return range;
  const alternatives = range.trim() === '' ? ['*'] : range.split('||');
  const said = sets.map((set, i) => {
    if (set.length === 0) return 'any version';
    const exact = set.find((c) => c.op === '=');
    if (exact && set.length === 1) return versionWords(exact.version);
    const low = set.find((c) => c.op === '>=' || c.op === '>');
    const high = set.find((c) => c.op === '<' || c.op === '<=');
    const installed = opts.installed === undefined ? undefined : parseSemver(opts.installed);
    const past = high !== undefined && installed !== undefined && compareSemver(installed, high.version) >= 0;
    const loose = /^\s*[\^~]/.test(alternatives[i] ?? '') && !past;
    const parts: string[] = [];
    if (low) parts.push(low.op === '>=' ? `${versionWords(low.version)} or newer` : `newer than ${versionWords(low.version)}`);
    if (high && !(loose && low)) {
      // `<0.0.0-0` is how "below anything" reads: no version fits.
      if (high.op === '<' && high.version.major === 0 && high.version.minor === 0 && high.version.patch === 0) return 'no version';
      parts.push(high.op === '<' ? `before ${versionWords(high.version)}` : `${versionWords(high.version)} or older`);
    }
    return parts.length > 0 ? parts.join(', ') : range.trim();
  });
  return said.join(' or ');
}
