import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ChangelogError, cutRelease, sectionOf, today } from './changelog.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'changelog.mjs');

const FOOTER = 'Releases up to 0.1.0-pre.17 are described on their GitHub release pages: https://github.com/withbuddi/buddi/releases';

const file = [
  '# Changelog',
  '',
  'Intro.',
  '',
  '## Unreleased',
  '',
  '### Added',
  '',
  '- A new thing.',
  '  Wrapped onto a second line.',
  '',
  '### Fixed',
  '',
  '- A broken thing.',
  '',
  '## 0.1.0 — 2026-09-01',
  '',
  '### Changed',
  '',
  '- An old change.',
  '',
  FOOTER,
  '',
].join('\n');

describe('section', () => {
  test('Unreleased, up to the next version', () => {
    expect(sectionOf(file, 'unreleased')).toBe('### Added\n\n- A new thing.\n  Wrapped onto a second line.\n\n### Fixed\n\n- A broken thing.');
  });

  test('a version, without the line about older releases', () => {
    expect(sectionOf(file, '0.1.0')).toBe('### Changed\n\n- An old change.');
  });

  test('a missing version is a sentence', () => {
    expect(() => sectionOf(file, '0.2.0')).toThrow(new ChangelogError('CHANGELOG.md has no section for 0.2.0.'));
  });

  test('a section with no entries is refused', () => {
    const empty = `# Changelog\n\n## Unreleased\n\n${FOOTER}\n`;
    expect(() => sectionOf(empty, 'unreleased')).toThrow('The Unreleased section of CHANGELOG.md has no entries.');
  });
});

describe('cut', () => {
  test('renames Unreleased and opens a fresh one above it', () => {
    const cut = cutRelease(file, '0.2.0', '2026-09-25');
    expect(cut).toContain('## Unreleased\n\n## 0.2.0 — 2026-09-25\n\n### Added');
    expect(sectionOf(cut, '0.2.0')).toBe(sectionOf(file, 'unreleased'));
    expect(() => sectionOf(cut, 'unreleased')).toThrow(/no entries/);
    expect(cut.endsWith(`${FOOTER}\n`)).toBe(true);
  });

  test('refuses an empty Unreleased, a version already there, and a word', () => {
    const empty = `# Changelog\n\n## Unreleased\n\n${FOOTER}\n`;
    expect(() => cutRelease(empty, '0.2.0', '2026-09-25')).toThrow(/no entries/);
    expect(() => cutRelease(file, '0.1.0', '2026-09-25')).toThrow('CHANGELOG.md already has a section for 0.1.0.');
    expect(() => cutRelease(file, 'next', '2026-09-25')).toThrow(/not a version/);
  });

  test('today is a UTC date', () => {
    expect(today(new Date('2026-09-25T23:30:00-04:00'))).toBe('2026-09-26');
  });
});

describe('the command', () => {
  async function scratch(text) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-changelog-'));
    const at = path.join(dir, 'CHANGELOG.md');
    await writeFile(at, text);
    return at;
  }
  const run = (at, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, BUDDI_CHANGELOG: at } });

  test('section prints the body, and exits 1 with a sentence when it cannot', async () => {
    const at = await scratch(file);
    const ok = run(at, 'section', 'unreleased');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`${sectionOf(file, 'unreleased')}\n`);
    const missing = run(at, 'section', '9.9.9');
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe('CHANGELOG.md has no section for 9.9.9.');
  });

  test('cut rewrites the file, and refuses a second cut', async () => {
    const at = await scratch(file);
    expect(run(at, 'cut', '0.2.0').status).toBe(0);
    expect(await readFile(at, 'utf8')).toContain(`## 0.2.0 — ${today()}`);
    const again = run(at, 'cut', '0.3.0');
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/no entries/);
  });
});
