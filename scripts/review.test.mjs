import { describe, expect, test } from 'vitest';
import { buildFableBrief, buildPrompt, lastPreTag, mergeFindings, parseArgs, STANDARD_FOCUS, unreleasedSummary } from './review.mjs';

const CHANGELOG = `# Changelog

## Unreleased

### Fixed

- The lock screen hides an empty calendar.

## 0.1.0-pre.36 — 2026-10-03

### Added

- Something older.
`;

describe('pnpm review', () => {
  test('the last tag is the highest pre number, not the last listed', () => {
    expect(lastPreTag(['v0.1.0-pre.9', 'v0.1.0-pre.36', 'v0.1.0-pre.4', 'other', ''])).toEqual({
      tag: 'v0.1.0-pre.36', n: 36, next: 'pre.37', nextVersion: '0.1.0-pre.37',
    });
    expect(() => lastPreTag(['v1.0.0'])).toThrow(/no v0.1.0-pre.N tag/);
  });

  test('the prompt carries the diff range, the Unreleased lines and the focus list', () => {
    const prompt = buildPrompt({ tag: 'v0.1.0-pre.36', next: 'pre.37', summary: unreleasedSummary(CHANGELOG), focus: ['The edition card menu.', ' '] });
    expect(prompt).toContain('before release pre.37');
    expect(prompt).toContain('git diff v0.1.0-pre.36..HEAD');
    expect(prompt).toContain('- The lock screen hides an empty calendar.');
    expect(prompt).not.toContain('Something older');
    expect(prompt).toContain(`${STANDARD_FOCUS.length + 1}. The edition card menu.`);
    expect(prompt).not.toMatch(new RegExp(`${STANDARD_FOCUS.length + 2}\\. `));
    expect(prompt).toContain('Do not edit anything.');
  });

  test('an empty Unreleased still makes a prompt', () => {
    expect(unreleasedSummary('# Changelog\n\n## Unreleased\n\n## 0.1.0 — x\n\n- a\n')).toMatch(/Unreleased is empty/);
  });

  test('the Fable brief wraps the same prompt and names the merge', () => {
    const brief = buildFableBrief({ prompt: 'PROMPT', fableFile: '/s/fable-review-pre.37.md', repo: '/r' });
    expect(brief).toContain('PROMPT');
    expect(brief).toContain('pnpm review --merge /s/fable-review-pre.37.md');
  });

  test('merge puts both reviews under their names', () => {
    const merged = mergeFindings({ next: 'pre.37', codex: 'C1\n', fable: '' });
    expect(merged).toMatch(/# Review before pre\.37[\s\S]*## Codex\n\nC1\n[\s\S]*## Fable\n\n\(no output\)/);
  });

  test('arguments', () => {
    expect(parseArgs(['--', '--focus', 'a', '--focus', 'b', '--print'])).toEqual({ focus: ['a', 'b'], print: true, out: undefined, merge: undefined });
    expect(() => parseArgs(['--merge'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--fast'])).toThrow(/Unknown argument/);
  });
});
