/**
 * The one comparison three places share. What matters here is that it refuses
 * what it cannot read: "not a version" has to stay distinguishable from
 * "older", because the callers turn the second into an upgrade offer.
 */
import { describe, expect, test } from 'vitest';
import { compareSemver, compareVersions, isNewerRelease, parseSemver } from './semver.js';

describe('versions', () => {
  test('are parsed into the four fields semver 2.0.0 names, or not at all', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] });
    // Build metadata is read and then ignored, as the specification says.
    expect(parseSemver('1.2.3+build.9')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    for (const bad of ['latest', '1.2', '1.0.0.0', '^1.0.0', '']) expect(parseSemver(bad)).toBeUndefined();
  });

  test('order numerically, and put a prerelease before the release it leads to', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBe(1);
    expect(compareVersions('2.0.0-rc.10', '2.0.0-rc.2')).toBe(1);
    expect(compareVersions('2.0.0-alpha.beta', '2.0.0-alpha.1')).toBe(1);
    expect(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.0+meta')!)).toBe(0);
  });

  test('cannot be compared when one of them is not a version, and say so', () => {
    expect(compareVersions('latest', '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0.0', 'unknown')).toBeUndefined();
    expect(isNewerRelease('latest', '1.0.0')).toBe(false);
    expect(isNewerRelease(undefined, '1.0.0')).toBe(false);
    expect(isNewerRelease('1.0.1', '1.0.0')).toBe(true);
  });
});
