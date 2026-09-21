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
