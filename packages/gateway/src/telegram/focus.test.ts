/**
 * `/focus`: the words it takes and what it says back.
 */
import { describe, expect, it } from 'vitest';
import { OWNER_COMMANDS } from './main.js';
import { FOCUS_USAGE_TEXT, focusSetText, focusStatusText, parseFocusArg } from './focus.js';
import { HELP } from './surface.js';

const TZ = 'America/New_York';

describe('/focus', () => {
  it('reads a mode and a duration', () => {
    expect(parseFocusArg('')).toEqual({ kind: 'status' });
    expect(parseFocusArg('  ')).toEqual({ kind: 'status' });
    expect(parseFocusArg('off')).toEqual({ kind: 'set', mode: 'normal', duration: 'indefinite' });
    expect(parseFocusArg('dnd 1h')).toEqual({ kind: 'set', mode: 'do-not-disturb', duration: '1h' });
    expect(parseFocusArg('DND for 3 hours')).toEqual({ kind: 'set', mode: 'do-not-disturb', duration: '3h' });
    expect(parseFocusArg('urgent until tomorrow')).toEqual({ kind: 'set', mode: 'urgent-only', duration: 'tomorrow' });
    expect(parseFocusArg('urgent-only tomorrow')).toEqual({ kind: 'set', mode: 'urgent-only', duration: 'tomorrow' });
    expect(parseFocusArg('dnd')).toEqual({ kind: 'set', mode: 'do-not-disturb', duration: 'indefinite' });
    expect(parseFocusArg('dnd until off')).toEqual({ kind: 'set', mode: 'do-not-disturb', duration: 'indefinite' });
    expect(parseFocusArg('dnd an hour')).toEqual({ kind: 'set', mode: 'do-not-disturb', duration: '1h' });
  });

  it('refuses words it does not take', () => {
    expect(parseFocusArg('loud')).toBeNull();
    expect(parseFocusArg('dnd soon')).toBeNull();
    expect(parseFocusArg('dnd 48h')).toBeNull();
  });

  it('says what is on, and the words it takes', () => {
    expect(focusStatusText(null, TZ)).toBe(`No focus is on: everything reaches you as usual.\n\n${FOCUS_USAGE_TEXT}`);
    expect(focusStatusText({ mode: 'do-not-disturb', until: '2026-09-15T11:00:00.000Z', startedAt: null, by: 'schedule' }, TZ))
      .toMatch(/^Do not disturb until Tue 15 Sep, 07:00, from a schedule\. Approvals and questions still come through\./);
    expect(focusSetText({ mode: 'urgent-only', until: null, startedAt: '2026-09-15T03:00:00.000Z', by: 'telegram' }, TZ))
      .toBe('Urgent only until you turn it off. Approvals, questions, watchers and failures still come through. /focus off to end it.');
    expect(focusSetText(null, TZ)).toBe('Focus is off.');
  });

  it('is in the menu and in /help', () => {
    expect(OWNER_COMMANDS.some((c) => c.command === 'focus')).toBe(true);
    expect(HELP).toContain('/focus');
  });
});
