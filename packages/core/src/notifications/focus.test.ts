/**
 * Focus modes, pure: the routing table per mode and kind, a manual focus
 * against a schedule, durations, and the schedules the page sends.
 */
import { describe, expect, it } from 'vitest';
import {
  activeFocus,
  focusEnd,
  parseFocusSchedules,
  scheduledFocus,
  schedulesFromQuietHours,
} from './focus.js';
import { route } from './notify.js';
import { DEFAULT_NOTIFICATION_SETTINGS } from './store.js';
import { NOTIFICATION_KINDS, type FocusMode, type FocusState, type NotificationKind } from './types.js';

const TZ = 'America/New_York';
// Monday 14 September 2026, 23:00 in New York.
const MON_2300 = new Date('2026-09-15T03:00:00.000Z');
const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, perKind: {}, schedules: [] };
const focusOf = (mode: Exclude<FocusMode, 'normal'>): FocusState => ({ mode, until: '2026-09-15T12:00:00.000Z', startedAt: null, by: 'dashboard' });

describe('the routing table', () => {
  const expected: Record<FocusMode, Record<NotificationKind, 'deliver' | 'held'>> = {
    normal: { approval: 'deliver', question: 'deliver', watcher: 'deliver', reminder: 'deliver', failure: 'deliver', recap: 'deliver', plugin: 'deliver', agent: 'deliver' },
    'urgent-only': { approval: 'deliver', question: 'deliver', watcher: 'deliver', reminder: 'held', failure: 'deliver', recap: 'held', plugin: 'held', agent: 'held' },
    'do-not-disturb': { approval: 'deliver', question: 'deliver', watcher: 'held', reminder: 'held', failure: 'held', recap: 'held', plugin: 'held', agent: 'held' },
  };
  for (const mode of ['normal', 'urgent-only', 'do-not-disturb'] as const) {
    it(`routes each now kind in ${mode}`, () => {
      const focus = mode === 'normal' ? null : focusOf(mode);
      for (const kind of NOTIFICATION_KINDS) {
        const r = route({ kind, urgency: 'now' }, { now: MON_2300, timezone: TZ, settings, onDashboard: false, focus });
        expect([kind, r.state]).toEqual([kind, expected[mode][kind]]);
        if (r.state === 'held') expect(r).toMatchObject({ heldFor: mode, dueAt: new Date('2026-09-15T12:00:00.000Z') });
      }
    });
  }

  it('leaves today and digest as they are in every mode, and the dashboard still shows', () => {
    const focus = focusOf('do-not-disturb');
    const ctx = { now: MON_2300, timezone: TZ, settings, onDashboard: false, focus };
    expect(route({ kind: 'recap', urgency: 'today' }, ctx)).toMatchObject({ state: 'held' });
    expect(route({ kind: 'recap', urgency: 'today' }, ctx)).not.toHaveProperty('heldFor');
    expect(route({ kind: 'recap', urgency: 'digest' }, ctx)).toEqual({ state: 'stored' });
    expect(route({ kind: 'watcher', urgency: 'now' }, { ...ctx, onDashboard: true })).toMatchObject({ state: 'shown' });
  });

  it('holds with no end for a focus until turned off', () => {
    const focus: FocusState = { mode: 'do-not-disturb', until: null, startedAt: null, by: 'telegram' };
    expect(route({ kind: 'reminder', urgency: 'now' }, { now: MON_2300, timezone: TZ, settings, onDashboard: false, focus }))
      .toEqual({ state: 'held', dueAt: null, heldFor: 'do-not-disturb' });
  });
});

describe('which focus is on', () => {
  const night = schedulesFromQuietHours('22:00', '07:00');

  it('turns a schedule on past midnight, and off at its end', () => {
    expect(scheduledFocus(night, MON_2300, TZ)).toEqual({
      mode: 'do-not-disturb', until: '2026-09-15T11:00:00.000Z', startedAt: null, by: 'schedule',
    });
    // Tuesday 06:59, then 07:00.
    expect(scheduledFocus(night, new Date('2026-09-15T10:59:00.000Z'), TZ)?.mode).toBe('do-not-disturb');
    expect(scheduledFocus(night, new Date('2026-09-15T11:00:00.000Z'), TZ)).toBeNull();
  });

  it('keeps to its days, the night belonging to the day it starts', () => {
    const weekends = [{ mode: 'urgent-only' as const, days: ['sat' as const], from: '22:00', to: '07:00' }];
    expect(scheduledFocus(weekends, MON_2300, TZ)).toBeNull();
    // Sunday 20 September, 03:00: Saturday's night.
    expect(scheduledFocus(weekends, new Date('2026-09-20T07:00:00.000Z'), TZ)?.mode).toBe('urgent-only');
  });

  it('picks the strongest schedule when two are on', () => {
    const both = [
      { mode: 'urgent-only' as const, days: ['mon' as const], from: '20:00', to: '23:30' },
      ...night,
    ];
    expect(scheduledFocus(both, MON_2300, TZ)?.mode).toBe('do-not-disturb');
  });

  it('lets a manual focus win over a schedule while it lasts', () => {
    const manual = { mode: 'urgent-only' as const, until: '2026-09-15T04:00:00.000Z', startedAt: '2026-09-15T03:00:00.000Z', by: 'dashboard' as const };
    expect(activeFocus({ schedules: night, focus: manual }, MON_2300, TZ)).toMatchObject({ mode: 'urgent-only', by: 'dashboard' });
    // An hour on, it has run out: the schedule is back.
    expect(activeFocus({ schedules: night, focus: manual }, new Date('2026-09-15T04:00:00.000Z'), TZ)).toMatchObject({ mode: 'do-not-disturb', by: 'schedule' });
    // Turned off over a schedule: off until the schedule ends.
    const off = { ...manual, mode: 'normal' as const, until: '2026-09-15T11:00:00.000Z' };
    expect(activeFocus({ schedules: night, focus: off }, MON_2300, TZ)).toBeNull();
    expect(activeFocus({ schedules: [], focus: null }, MON_2300, TZ)).toBeNull();
  });
});

describe('durations', () => {
  it('reads an hour, three, tomorrow morning and until off', () => {
    expect(focusEnd('1h', MON_2300, TZ)).toEqual(new Date('2026-09-15T04:00:00.000Z'));
    expect(focusEnd('3h', MON_2300, TZ)).toEqual(new Date('2026-09-15T06:00:00.000Z'));
    // The next 08:00 in New York.
    expect(focusEnd('tomorrow', MON_2300, TZ)).toEqual(new Date('2026-09-15T12:00:00.000Z'));
    expect(focusEnd('indefinite', MON_2300, TZ)).toBeNull();
    expect(focusEnd('soon', MON_2300, TZ)).toBeUndefined();
    expect(focusEnd('48h', MON_2300, TZ)).toBeUndefined();
  });
});

describe('schedules the page sends', () => {
  it('moves quiet hours into the first schedule, Do not disturb every day', () => {
    expect(schedulesFromQuietHours('22:00', '07:00')).toEqual([
      { mode: 'do-not-disturb', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:00', to: '07:00' },
    ]);
    expect(schedulesFromQuietHours(null, '07:00')).toEqual([]);
  });

  it('checks each row and says what is wrong', () => {
    expect(parseFocusSchedules([{ mode: 'urgent-only', days: ['fri', 'mon'], from: '09:00', to: '12:00' }]))
      .toEqual({ ok: true, schedules: [{ mode: 'urgent-only', days: ['mon', 'fri'], from: '09:00', to: '12:00' }] });
    expect(parseFocusSchedules([{ mode: 'normal', days: ['mon'], from: '09:00', to: '12:00' }])).toMatchObject({ ok: false });
    expect(parseFocusSchedules([{ mode: 'do-not-disturb', days: [], from: '09:00', to: '12:00' }]))
      .toEqual({ ok: false, message: 'Schedule 1 needs at least one day.' });
    expect(parseFocusSchedules([{ mode: 'do-not-disturb', days: ['mon'], from: '09:00', to: '09:00' }])).toMatchObject({ ok: false });
    expect(parseFocusSchedules([{ mode: 'do-not-disturb', days: ['mon'], from: '9', to: '10:00' }])).toMatchObject({ ok: false });
  });
});
