/**
 * The one comparison three places share. What matters here is that it refuses
 * what it cannot read: "not a version" has to stay distinguishable from
 * "older", because the callers turn the second into an upgrade offer.
 */
import { describe, expect, test } from 'vitest';
import { compareSemver, compareVersions, isNewerRelease, isSemverRange, parseSemver, rangeWords, satisfiesRange } from './semver.js';

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

describe('ranges', () => {
  const cases: Array<[string, string, boolean]> = [
    ['1.2.3', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['1.1.9', '^1.2.0', false],
    ['0.1.5', '^0.1.2', true],
    ['0.2.0', '^0.1.2', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2', false],
    ['1.4.0', '>=1.0.0 <2', true],
    ['2.0.0', '>=1.0.0 <2', false],
    ['1.9.0', '1.x', true],
    ['3.0.0', '*', true],
    ['0.1.2', '', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['1.2.3', '>= 1.2', true],
  ];
  test.each(cases)('%s in %s is %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
  test('say nothing about what they cannot read', () => {
    expect(satisfiesRange('1.0.0', 'latest')).toBeUndefined();
    expect(satisfiesRange('one', '^1.0.0')).toBeUndefined();
    expect(isSemverRange('^0.1')).toBe(true);
    expect(isSemverRange('next')).toBe(false);
  });
});

describe('ranges in words', () => {
  test.each([
    ['^0.2.0', '0.2 or newer'],
    ['~1.4.2', '1.4.2 or newer'],
    ['>=1.0.0 <2', '1.0 or newer, before 2.0'],
    ['>=0.1.0', '0.1 or newer'],
    ['*', 'any version'],
    ['', 'any version'],
    ['1.2.3', '1.2.3'],
    ['<2.0.0', 'before 2.0'],
    ['^1.0.0 || ^2.0.0', '1.0 or newer or 2.0 or newer'],
    ['not a range', 'not a range'],
  ])('%s reads as "%s"', (range, words) => {
    expect(rangeWords(range)).toBe(words);
  });

  test("says a caret's ceiling only when the installed version is past it", () => {
    expect(rangeWords('^0.2.0', { installed: '0.1.0' })).toBe('0.2 or newer');
    expect(rangeWords('^0.2.0', { installed: '0.3.1' })).toBe('0.2 or newer, before 0.3');
  });
});
