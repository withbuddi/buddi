/**
 * The reminder budget, read from the environment.
 *
 * The point of these tests is that a tuning knob never takes the machine down:
 * whatever the owner typed — a word, a negative number, a million — the process
 * still gets a usable set of limits, and hears about it once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { reminderLimitsFromEnv, resetReminderLimitWarnings } from './env.js';
import { DEFAULT_REMINDER_LIMITS } from './types.js';

const silent = { log: () => {} };

beforeEach(() => {
  resetReminderLimitWarnings();
});

describe('reminderLimitsFromEnv', () => {
  it('is the shipped defaults with nothing set — and the lead is five minutes', () => {
    expect(reminderLimitsFromEnv({}, silent)).toEqual(DEFAULT_REMINDER_LIMITS);
    expect(reminderLimitsFromEnv({}, silent).minLeadMinutes).toBe(5);
  });

  it('takes each variable when it is in range', () => {
    const limits = reminderLimitsFromEnv(
      {
        BUDDI_REMINDER_MIN_LEAD_MINUTES: '15',
        BUDDI_REMINDER_MAX_HORIZON_DAYS: '30',
        BUDDI_REMINDER_MAX_PENDING_PER_AGENT: '3',
        BUDDI_REMINDER_MAX_PENDING_TOTAL: '7',
      },
      silent,
    );
    expect(limits).toEqual({
      minLeadMinutes: 15,
      maxHorizonDays: 30,
      maxPendingPerAgent: 3,
      maxPendingTotal: 7,
      maxTextChars: DEFAULT_REMINDER_LIMITS.maxTextChars,
    });
  });

  it('clamps anything outside the range, at both ends', () => {
    const low = reminderLimitsFromEnv(
      {
        BUDDI_REMINDER_MIN_LEAD_MINUTES: '0',
        BUDDI_REMINDER_MAX_HORIZON_DAYS: '-5',
        BUDDI_REMINDER_MAX_PENDING_PER_AGENT: '0',
        BUDDI_REMINDER_MAX_PENDING_TOTAL: '0',
      },
      silent,
    );
    expect(low).toMatchObject({
      minLeadMinutes: 1,
      maxHorizonDays: 1,
      maxPendingPerAgent: 1,
      maxPendingTotal: 1,
    });

    const high = reminderLimitsFromEnv(
      {
        BUDDI_REMINDER_MIN_LEAD_MINUTES: '99999',
        BUDDI_REMINDER_MAX_HORIZON_DAYS: '99999',
        BUDDI_REMINDER_MAX_PENDING_PER_AGENT: '99999',
        BUDDI_REMINDER_MAX_PENDING_TOTAL: '99999',
      },
      silent,
    );
    expect(high).toMatchObject({
      minLeadMinutes: 1440,
      maxHorizonDays: 3650,
      maxPendingPerAgent: 100,
      maxPendingTotal: 500,
    });
  });

  it('falls back to the default for garbage rather than refusing to start', () => {
    const lines: string[] = [];
    const limits = reminderLimitsFromEnv(
      {
        BUDDI_REMINDER_MIN_LEAD_MINUTES: 'soon',
        BUDDI_REMINDER_MAX_HORIZON_DAYS: '3.5',
        BUDDI_REMINDER_MAX_PENDING_PER_AGENT: '',
        BUDDI_REMINDER_MAX_PENDING_TOTAL: 'NaN',
      },
      { log: (line) => lines.push(line) },
    );
    expect(limits).toEqual(DEFAULT_REMINDER_LIMITS);
    // The empty one is "unset", not "wrong", so it says nothing about it.
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('BUDDI_REMINDER_MIN_LEAD_MINUTES');
  });

  it('complains once per variable, however often it is read', () => {
    const lines: string[] = [];
    const env = { BUDDI_REMINDER_MIN_LEAD_MINUTES: 'soon' };
    reminderLimitsFromEnv(env, { log: (line) => lines.push(line) });
    reminderLimitsFromEnv(env, { log: (line) => lines.push(line) });
    reminderLimitsFromEnv(env, { log: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
  });
});
