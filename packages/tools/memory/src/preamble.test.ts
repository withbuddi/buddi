/** Pure rendering/truncation rules for the memory preamble. */
import { describe, expect, it } from 'vitest';
import {
  PREAMBLE_FOOTER,
  PREAMBLE_HEADING,
  PREAMBLE_MAX_CHARS,
  renderPreamble,
} from './preamble.js';

const note = (content: string, day: string, kind = 'fact') => ({
  content,
  kind,
  createdAt: `${day}T09:00:00.000Z`,
});

describe('renderPreamble', () => {
  it('renders nothing when there is nothing remembered', () => {
    expect(renderPreamble([], [])).toBe('');
  });

  it('lists preferences as key: value and notes with their date and kind', () => {
    const block = renderPreamble(
      [{ key: 'pay_cycle', value: 'biweekly, Thursdays' }],
      [note('The rent at Pelican is paid by a relative.', '2026-09-13')],
    );
    expect(block).toBe(
      [
        PREAMBLE_HEADING,
        'Stated preferences:',
        '- pay_cycle: biweekly, Thursdays',
        'Recent notes (newest first):',
        '- 2026-09-13 [fact] The rent at Pelican is paid by a relative.',
        PREAMBLE_FOOTER,
      ].join('\n'),
    );
  });

  it('says memory is not permission, in the block itself', () => {
    const block = renderPreamble([], [note('x', '2026-09-13')]);
    expect(block).toContain('never authorises an action');
  });

  it('omits the preferences section entirely when there are none', () => {
    const block = renderPreamble([], [note('x', '2026-09-13')]);
    expect(block).not.toContain('Stated preferences');
    expect(block).toContain('Recent notes');
  });

  it('drops the oldest notes until the block fits the budget', () => {
    const notes = Array.from({ length: 10 }, (_, i) =>
      note(`${'n'.repeat(200)} #${i}`, '2026-09-13'),
    );
    const block = renderPreamble([{ key: 'k', value: 'v' }], notes);
    expect(block.length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS);
    // Newest survive, oldest go.
    expect(block).toContain('#0');
    expect(block).not.toContain('#9');
    // Preferences are the owner's own words; they are never the ones dropped.
    expect(block).toContain('- k: v');
  });

  it('keeps preferences even when they alone exceed the budget', () => {
    const block = renderPreamble(
      [{ key: 'k', value: 'v'.repeat(2000) }],
      [note('dropped', '2026-09-13')],
    );
    expect(block).toContain('vvv');
    expect(block).not.toContain('dropped');
  });
});
