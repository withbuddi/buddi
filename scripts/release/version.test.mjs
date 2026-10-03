import { describe, expect, test } from 'vitest';
import { cutRelease, sectionOf } from './changelog.mjs';
import { missingSince, parseVersion, ReleaseError, stampSince } from './version.mjs';

describe('parseVersion', () => {
  test('pre.N, the full version and the tag name the same release', () => {
    const want = { version: '0.1.0-pre.36', n: 36, tag: 'v0.1.0-pre.36', previousTag: 'v0.1.0-pre.35' };
    expect(parseVersion('pre.36')).toEqual(want);
    expect(parseVersion('0.1.0-pre.36')).toEqual(want);
    expect(parseVersion('v0.1.0-pre.36')).toEqual(want);
  });

  test('pre.N takes the base it is given; a full version keeps its own', () => {
    expect(parseVersion('pre.2', '0.2.0').tag).toBe('v0.2.0-pre.2');
    expect(parseVersion('0.3.1-pre.4', '0.2.0').previousTag).toBe('v0.3.1-pre.3');
  });

  test('pre.1 has no previous tag', () => {
    expect(parseVersion('pre.1').previousTag).toBeUndefined();
  });

  test('anything else is refused with a sentence', () => {
    for (const bad of ['', '36', 'pre', 'pre.', 'pre.0', 'pre.07', '0.1.0', '0.1.0-rc.1', 'pre.3 x']) {
      expect(() => parseVersion(bad), bad).toThrow(ReleaseError);
    }
  });
});

describe('API_SINCE stamping', () => {
  const source = [
    "export const API_ROUTES = [];",
    '',
    '/** The release each route first shipped in. */',
    'export const API_SINCE: Readonly<Record<string, string>> = {',
    "  'GET /api/old': '0.1.0-pre.30',",
    '};',
    '',
  ].join('\n');

  test('lists the routes without an entry, once each, in table order', () => {
    const routes = [
      { method: 'GET', path: '/api/old' },
      { method: 'POST', path: '/api/new' },
      { method: 'GET', path: '/api/new/:id' },
      { method: 'POST', path: '/api/new' },
    ];
    expect(missingSince(routes, { 'GET /api/old': '0.1.0-pre.30' })).toEqual(['POST /api/new', 'GET /api/new/:id']);
    expect(missingSince(routes.slice(0, 1), { 'GET /api/old': 'x' })).toEqual([]);
  });

  test('inserts the entries at the top of the map', () => {
    const out = stampSince(source, ['POST /api/new', 'GET /api/new/:id'], '0.1.0-pre.36');
    expect(out).toContain([
      'export const API_SINCE: Readonly<Record<string, string>> = {',
      "  'POST /api/new': '0.1.0-pre.36',",
      "  'GET /api/new/:id': '0.1.0-pre.36',",
      "  'GET /api/old': '0.1.0-pre.30',",
      '};',
    ].join('\n'));
    expect(out.startsWith("export const API_ROUTES = [];\n")).toBe(true);
  });

  test('nothing missing changes nothing; an empty map gets two-space entries', () => {
    expect(stampSince(source, [], '0.1.0-pre.36')).toBe(source);
    const empty = 'export const API_SINCE: Readonly<Record<string, string>> = {\n};\n';
    expect(stampSince(empty, ['GET /api/x'], 'v')).toBe("export const API_SINCE: Readonly<Record<string, string>> = {\n  'GET /api/x': 'v',\n};\n");
  });

  test('a file without the map is refused', () => {
    expect(() => stampSince('const x = {};\n', ['GET /api/x'], 'v')).toThrow(ReleaseError);
  });
});

describe('the CHANGELOG cut a release makes', () => {
  const file = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '### Fixed',
    '',
    '- A thing.',
    '',
    '## 0.1.0-pre.35 — 2026-10-03',
    '',
    '### Added',
    '',
    '- Older.',
    '',
  ].join('\n');

  test('moves Unreleased under the dated heading and leaves it empty', () => {
    const { version } = parseVersion('pre.36');
    const cut = cutRelease(file, version, '2026-10-04');
    expect(cut).toContain('## Unreleased\n\n## 0.1.0-pre.36 — 2026-10-04\n\n### Fixed\n\n- A thing.\n\n## 0.1.0-pre.35');
    expect(sectionOf(cut, version)).toBe('### Fixed\n\n- A thing.');
    expect(() => cutRelease(cut, '0.1.0-pre.37', '2026-10-05')).toThrow(/no entries/);
  });
});
