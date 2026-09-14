import { describe, expect, it } from 'vitest';
import { columnWidths, renderMarkdown, tableCells } from './render.js';
import { DEFAULT_WIDTH, styleFor, stripAnsi, type TerminalStyle } from './terminal.js';

const plain: TerminalStyle = { color: false, width: 80, tty: false };
const colour: TerminalStyle = { color: true, width: 80, tty: true };

describe('styleFor', () => {
  it('has colour on a TTY', () => {
    expect(styleFor({}, { isTTY: true, columns: 120 })).toEqual({
      color: true,
      width: 120,
      tty: true,
    });
  });

  it('has no colour when NO_COLOR is set, even to nothing', () => {
    expect(styleFor({ NO_COLOR: '' }, { isTTY: true, columns: 100 }).color).toBe(false);
    expect(styleFor({ NO_COLOR: '1' }, { isTTY: true }).color).toBe(false);
  });

  it('has no colour and no TTY when the output is a pipe', () => {
    const style = styleFor({}, {});
    expect(style).toEqual({ color: false, width: DEFAULT_WIDTH, tty: false });
  });

  it('falls back to 80 columns when the device reports something absurd', () => {
    expect(styleFor({}, { isTTY: true, columns: 3 }).width).toBe(DEFAULT_WIDTH);
  });
});

describe('renderMarkdown', () => {
  it('returns prose with no markers byte for byte', () => {
    expect(renderMarkdown('You have $1,240 across two accounts.', plain)).toBe(
      'You have $1,240 across two accounts.',
    );
  });

  it('honours bold rather than deleting it', () => {
    expect(renderMarkdown('**Careful** now', colour)).toBe('\u001b[1mCareful\u001b[22m now');
    expect(renderMarkdown('**Careful** now', plain)).toBe('Careful now');
  });

  it('leaves arithmetic and identifiers alone', () => {
    expect(renderMarkdown('2 * 3 and snake_case stay', plain)).toBe('2 * 3 and snake_case stay');
  });

  it('renders a heading as text with no # markers', () => {
    expect(renderMarkdown('## Status', plain)).toBe('Status');
    expect(stripAnsi(renderMarkdown('## Status', colour))).toBe('Status');
    expect(renderMarkdown('## Status', colour)).not.toBe('Status');
  });

  it('normalizes every bullet marker to one character', () => {
    expect(renderMarkdown('- one\n* two\n+ three', plain)).toBe('• one\n• two\n• three');
  });

  it('keeps an indented bullet indented', () => {
    expect(renderMarkdown('  - nested', plain)).toBe('  • nested');
  });

  it('renders a link as label and url', () => {
    expect(renderMarkdown('see [the docs](https://x.dev)', plain)).toBe(
      'see the docs (https://x.dev)',
    );
  });

  it('aligns a table to columns and drops the separator row', () => {
    const table = [
      '| Account | Balance |',
      '| --- | --- |',
      '| Checking | $1,200 |',
      '| Savings | $40 |',
    ].join('\n');
    const lines = renderMarkdown(table, plain).split('\n');
    expect(lines).toHaveLength(4); // header, rule, two rows
    expect(lines[0]).toBe('Account   Balance');
    expect(lines[1]).toBe('────────  ───────');
    expect(lines[2]).toBe('Checking  $1,200');
    expect(lines[3]).toBe('Savings   $40');
  });

  it('keeps a table inside the terminal width', () => {
    const wide = ['| a | b |', '| --- | --- |', `| ${'x'.repeat(60)} | ${'y'.repeat(60)} |`].join(
      '\n',
    );
    const narrow: TerminalStyle = { color: false, width: 40, tty: false };
    for (const line of renderMarkdown(wide, narrow).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it('keeps a code fence verbatim, markers and all', () => {
    const text = ['Run this:', '```sh', 'buddi doctor  # **not** bold', '  indented * line', '```'].join(
      '\n',
    );
    const lines = renderMarkdown(text, plain).split('\n');
    expect(lines[1]).toBe('```sh');
    expect(lines[2]).toBe('buddi doctor  # **not** bold');
    expect(lines[3]).toBe('  indented * line');
    expect(lines[4]).toBe('```');
  });

  it('emits no escape codes at all when colour is off', () => {
    const text = '# H\n- **b** and `code`\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(renderMarkdown(text, plain)).not.toContain('\u001b');
  });

  it('is idempotent on text it has already made plain', () => {
    const once = renderMarkdown('- **a**', plain);
    expect(renderMarkdown(once, plain)).toBe(once);
  });
});

describe('table helpers', () => {
  it('reads cells only from a pipe row', () => {
    expect(tableCells('| a | b |')).toEqual(['a', 'b']);
    expect(tableCells('a | b')).toBeUndefined();
  });

  it('shrinks the widest column first', () => {
    expect(columnWidths([['aa', 'b'.repeat(30)]], 20)).toEqual([2, 16]);
  });

  it('gives up rather than crushing a table that cannot fit', () => {
    expect(columnWidths([['aaaa', 'bbbb', 'cccc']], 6)).toEqual([4, 4, 4]);
  });
});
