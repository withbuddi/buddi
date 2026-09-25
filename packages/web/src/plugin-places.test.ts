/**
 * Every place this shell draws a plugin's data is written down.
 *
 * `docs/plugins.md` §2.5a is the one list of where a plugin can put something
 * in front of the owner, and it is what a plugin author reads before deciding
 * what to build. A place this package draws but that table does not mention is
 * a capability nobody can discover — and, worse, one nobody is maintaining a
 * promise about: the rail entry and the settings tab were both invented before
 * the table existed, which is exactly how the email plugin ended up compiled
 * in by name (docs/plugin-pages.md §1).
 *
 * So the list below is the shell's side of that promise. Each entry names the
 * file that draws the place and the row of the table that documents it, and
 * the test fails if either goes missing. Adding a new way for a plugin to
 * appear means adding a row here *and* there, which is the point.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(SRC, '..', '..', '..');
const DOC = path.join(REPO, 'docs', 'plugins.md');

/** The section that must hold every row: §2.5a, up to the next heading. */
function contributionTable(): string {
  const doc = readFileSync(DOC, 'utf8');
  const start = doc.indexOf('### 2.5a Where a plugin appears in the dashboard');
  expect(start, 'docs/plugins.md has no §2.5a').toBeGreaterThan(-1);
  const end = doc.indexOf('\n### ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/**
 * One way a plugin's data reaches the owner: what draws it here, and the words
 * §2.5a uses for it. The anchor is the table's `Place` cell, so a row that is
 * reworded on one side and not the other is caught rather than quietly drifting.
 */
const PLACES: Array<{ place: string; drawnBy: string; anchor: string; from: string }> = [
  {
    place: 'a rail entry of its own',
    drawnBy: 'src/shell/Rail.tsx',
    anchor: 'The rail',
    from: "`pages` with `place: 'rail'`",
  },
  {
    place: 'a settings tab of its own',
    drawnBy: 'src/views/Settings.tsx',
    anchor: 'Settings',
    from: "`pages` with `place: 'settings'`",
  },
  {
    place: 'the page itself, drawn from a descriptor',
    drawnBy: 'src/pages/PluginPage.tsx',
    anchor: 'The rail',
    from: '§2.5b',
  },
  {
    place: 'a block on Home',
    drawnBy: 'src/views/Home.tsx',
    anchor: 'Home, blocks',
    from: '`home`',
  },
  {
    place: 'a mission on offer',
    drawnBy: 'src/views/Home.tsx',
    anchor: 'Home, "On offer"',
    from: '`missions`',
  },
  {
    place: 'a finding that needs the owner',
    drawnBy: 'src/views/Home.tsx',
    anchor: 'Home, "Needs you"',
    from: '`urgent` finding',
  },
  {
    place: 'a view descriptor on the canvas',
    drawnBy: 'src/canvas/resolve.ts',
    anchor: 'Chat canvas',
    from: '`views`',
  },
  {
    place: 'the envelope and choices of a gated tool',
    drawnBy: 'src/views/parts/ApprovalCard.tsx',
    anchor: 'Approval card, everywhere',
    from: '`describe`',
  },
  {
    place: 'a row on the Watchers page',
    drawnBy: 'src/views/Watchers.tsx',
    anchor: 'Watchers',
    from: '`sentinels`',
  },
  {
    place: 'an agent or skill it proposes',
    drawnBy: 'src/views/Agents.tsx',
    anchor: 'Agents, "Proposed"',
    from: '`agents`, `skills`',
  },
  {
    place: 'what it is, on the Plugins page',
    drawnBy: 'src/views/Plugins.tsx',
    anchor: 'Plugins',
    from: 'the manifest itself',
  },
];

describe('where a plugin appears in the dashboard', () => {
  const table = contributionTable();

  it.each(PLACES)('$place is drawn by $drawnBy and written down in §2.5a', ({ drawnBy, anchor, from }) => {
    expect(existsSync(path.join(SRC, '..', drawnBy)), `${drawnBy} is gone; §2.5a promises what it draws`).toBe(true);
    const row = table
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(anchor));
    expect(row, `docs/plugins.md §2.5a names no place "${anchor}"`).toBeDefined();
    // And the row says where it comes from, so an author can go and read it.
    expect(row).toContain(from);
  });

  it('is a table of places, not a paragraph about them', () => {
    const rows = table.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('| ---'));
    // The header, plus one row per place. More is fine — fewer than what this
    // package draws is the failure.
    expect(rows.length).toBeGreaterThanOrEqual(new Set(PLACES.map((p) => p.anchor)).size + 1);
  });

  it('still says a plugin ships no page code', () => {
    expect(table).toContain('nothing in `packages/web` knows a');
    expect(table).toContain('**Code in the page.**');
  });
});
