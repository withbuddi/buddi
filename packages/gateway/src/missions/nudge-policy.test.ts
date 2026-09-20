import { describe, expect, it } from 'vitest';
import {
  arcWindow,
  endsTheArc,
  nudgePolicy,
  parseEngagement,
  parseQuiet,
  quietConfirmation,
  refusalText,
  ARC_WINDOW_DAYS,
  BACKFILLED_SURFACE,
  WEB_WIZARD_SURFACE,
  DEFAULT_QUIET_DAYS,
  MAX_NUDGES,
  MAX_UNANSWERED,
  MIN_GAP_HOURS,
  type NudgeState,
} from './nudge-policy.js';

/** The fake clock every case in this file is judged against. */
const NOW = new Date('2026-09-14T09:30:00Z');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function state(overrides: Partial<NudgeState> = {}): NudgeState {
  return {
    nudgesSent: 0,
    lastNudgeAt: null,
    quietUntil: null,
    unanswered: 0,
    ...overrides,
  };
}

describe('nudgePolicy', () => {
  it('allows the first message of a fresh arc', () => {
    expect(nudgePolicy(state(), NOW)).toEqual({ allow: true, reason: 'ok' });
  });

  it('allows a message once the gap has passed', () => {
    const decision = nudgePolicy(
      state({ nudgesSent: 3, lastNudgeAt: new Date(NOW.getTime() - 21 * HOUR), unanswered: 2 }),
      NOW,
    );
    expect(decision).toEqual({ allow: true, reason: 'ok' });
  });

  /* ---------------- the four refusals ---------------- */

  it('refuses while quiet_until is in the future', () => {
    const decision = nudgePolicy(state({ quietUntil: new Date(NOW.getTime() + 1) }), NOW);
    expect(decision).toEqual({ allow: false, reason: 'quiet' });
  });

  it('allows again the instant quiet_until has passed', () => {
    const decision = nudgePolicy(state({ quietUntil: new Date(NOW.getTime()) }), NOW);
    expect(decision.allow).toBe(true);
  });

  it(`refuses after ${MAX_UNANSWERED} messages in a row went unanswered`, () => {
    expect(nudgePolicy(state({ unanswered: MAX_UNANSWERED }), NOW)).toEqual({
      allow: false,
      reason: 'unanswered',
    });
    expect(nudgePolicy(state({ unanswered: MAX_UNANSWERED - 1 }), NOW).allow).toBe(true);
  });

  it(`refuses once ${MAX_NUDGES} messages have been sent`, () => {
    expect(nudgePolicy(state({ nudgesSent: MAX_NUDGES }), NOW)).toEqual({
      allow: false,
      reason: 'exhausted',
    });
    expect(nudgePolicy(state({ nudgesSent: MAX_NUDGES - 1 }), NOW).allow).toBe(true);
  });

  it(`refuses within ${MIN_GAP_HOURS} hours of the last one`, () => {
    const justInside = new Date(NOW.getTime() - (MIN_GAP_HOURS * HOUR - 1));
    expect(nudgePolicy(state({ lastNudgeAt: justInside }), NOW)).toEqual({
      allow: false,
      reason: 'too-soon',
    });
    const justOutside = new Date(NOW.getTime() - MIN_GAP_HOURS * HOUR);
    expect(nudgePolicy(state({ lastNudgeAt: justOutside }), NOW).allow).toBe(true);
  });

  /* ---------------- precedence ---------------- */

  it('names quiet first when several refusals are true at once', () => {
    const decision = nudgePolicy(
      state({
        quietUntil: new Date(NOW.getTime() + DAY),
        unanswered: 9,
        nudgesSent: 99,
        lastNudgeAt: NOW,
      }),
      NOW,
    );
    expect(decision).toEqual({ allow: false, reason: 'quiet' });
  });

  it('names silence before a spent budget, so the owner is told why it stopped', () => {
    const decision = nudgePolicy(state({ unanswered: 5, nudgesSent: MAX_NUDGES }), NOW);
    expect(decision).toEqual({ allow: false, reason: 'unanswered' });
  });

  it('every refusal has a sentence, and only two end the arc', () => {
    for (const reason of ['quiet', 'unanswered', 'exhausted', 'too-soon'] as const) {
      expect(refusalText(reason).length).toBeGreaterThan(0);
    }
    expect(endsTheArc('unanswered')).toBe(true);
    expect(endsTheArc('exhausted')).toBe(true);
    expect(endsTheArc('quiet')).toBe(false);
    expect(endsTheArc('too-soon')).toBe(false);
  });
});

describe('arcWindow', () => {
  it('is shut when there is no onboarding record at all', () => {
    const window = arcWindow(null, NOW);
    expect(window.open).toBe(false);
    expect(window.reason).toContain('never ran');
  });

  it('is shut for a row migration 013 backfilled, whatever its completion date', () => {
    const window = arcWindow(
      { state: 'done', completedAt: NOW, surface: BACKFILLED_SURFACE },
      NOW,
    );
    expect(window.open).toBe(false);
    expect(window.reason).toContain('predates onboarding');
  });

  it('is shut for an owner who set up in the dashboard, finished or still going', () => {
    for (const state of ['in-progress', 'done']) {
      const window = arcWindow({ state, completedAt: NOW, surface: WEB_WIZARD_SURFACE }, NOW);
      expect(window.open, state).toBe(false);
      expect(window.reason).toContain('dashboard');
    }
  });

  it('is shut when the owner skipped the interview', () => {
    expect(arcWindow({ state: 'skipped', completedAt: null, surface: 'cli' }, NOW).open).toBe(
      false,
    );
  });

  it('is open while the interview has not finished', () => {
    expect(
      arcWindow({ state: 'in-progress', completedAt: null, surface: 'telegram' }, NOW).open,
    ).toBe(true);
    expect(arcWindow({ state: 'pending', completedAt: null, surface: null }, NOW).open).toBe(true);
  });

  it(`is open for ${ARC_WINDOW_DAYS} days after completion, and shut after`, () => {
    const inside = new Date(NOW.getTime() - (ARC_WINDOW_DAYS - 1) * DAY);
    const edge = new Date(NOW.getTime() - ARC_WINDOW_DAYS * DAY);
    const past = new Date(NOW.getTime() - (ARC_WINDOW_DAYS + 1) * DAY);
    expect(arcWindow({ state: 'done', completedAt: inside, surface: 'cli' }, NOW).open).toBe(true);
    expect(arcWindow({ state: 'done', completedAt: edge, surface: 'cli' }, NOW).open).toBe(true);
    const closed = arcWindow({ state: 'done', completedAt: past, surface: 'cli' }, NOW);
    expect(closed.open).toBe(false);
    expect(closed.reason).toContain(`${ARC_WINDOW_DAYS}-day window`);
  });

  it('is shut for a done row with no completion date', () => {
    expect(arcWindow({ state: 'done', completedAt: null, surface: 'cli' }, NOW).open).toBe(false);
  });
});

describe('parseQuiet', () => {
  it(`takes a bare /quiet as ${DEFAULT_QUIET_DAYS} days`, () => {
    const request = parseQuiet('', NOW);
    expect(request).toMatchObject({ kind: 'until', label: `${DEFAULT_QUIET_DAYS} days` });
    if (request.kind !== 'until') throw new Error('unreachable');
    expect(request.until.getTime()).toBe(NOW.getTime() + DEFAULT_QUIET_DAYS * DAY);
  });

  it('takes 1d as one day', () => {
    const request = parseQuiet('1d', NOW);
    if (request.kind !== 'until') throw new Error('expected a duration');
    expect(request.until.getTime()).toBe(NOW.getTime() + DAY);
    expect(request.label).toBe('1 day');
  });

  it('takes 1w as one week', () => {
    const request = parseQuiet('1w', NOW);
    if (request.kind !== 'until') throw new Error('expected a duration');
    expect(request.until.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(request.label).toBe('1 week');
  });

  it('takes off as clearing it', () => {
    expect(parseQuiet('off', NOW)).toEqual({ kind: 'off' });
    expect(parseQuiet('  OFF  ', NOW)).toEqual({ kind: 'off' });
  });

  it('says so rather than guessing at something it cannot read', () => {
    expect(parseQuiet('forever', NOW)).toEqual({ kind: 'unparsable', text: 'forever' });
    expect(quietConfirmation(parseQuiet('forever', NOW))).toContain('/quiet 1d');
  });

  it('confirms in one line, and the line names the end', () => {
    const confirmation = quietConfirmation(parseQuiet('1w', NOW), 'Mon 21 Sep 09:30');
    expect(confirmation.split('\n')).toHaveLength(1);
    expect(confirmation).toContain('1 week');
    expect(confirmation).toContain('Mon 21 Sep 09:30');
    expect(quietConfirmation({ kind: 'off' })).toContain('Quiet off');
  });
});

describe('parseEngagement', () => {
  it('reads only the two values it knows', () => {
    expect(parseEngagement('arc')).toBe('arc');
    expect(parseEngagement(' QUIET ')).toBe('quiet');
    expect(parseEngagement('sometimes')).toBeUndefined();
    expect(parseEngagement(undefined)).toBeUndefined();
  });
});
