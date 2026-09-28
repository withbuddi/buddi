import { describe, expect, it } from 'vitest';
import { facts } from '../__fixtures__/tip-facts.js';
import { daysBetween, dayIn, dismissTip, laterTip, listTips, pickTip, restoreTip, type TipsState } from './engine.js';
import type { Facts } from './facts.js';
import type { TipRule } from './rules.js';

const rule = (id: string, when: (f: Facts) => boolean, extra: Partial<TipRule> = {}): TipRule => ({
  id,
  when,
  holdsForDays: 0,
  text: `Tip ${id}.`,
  action: { label: id, route: '#/' },
  cooldownDays: 7,
  ...extra,
});

const always = () => true;

/** Run the engine day after day, carrying the state, as Home would. */
function days(rules: TipRule[], f: Facts, from: string, count: number, state: TipsState = {}): { tips: (string | null)[]; state: TipsState } {
  const tips: (string | null)[] = [];
  let current = state;
  for (let i = 0; i < count; i++) {
    const day = new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const out = pickTip(rules, f, current, day);
    tips.push(out.tip?.id ?? null);
    current = out.state;
  }
  return { tips, state: current };
}

describe('pickTip', () => {
  it('waits for the condition to hold holdsForDays', () => {
    const rules = [rule('a', always, { holdsForDays: 2 })];
    expect(days(rules, facts(), '2026-09-01', 3).tips).toEqual([null, null, 'a']);
  });

  it('shows the same tip all day, and at most one card a day', () => {
    const rules = [rule('a', always), rule('b', always)];
    let out = pickTip(rules, facts(), {}, '2026-09-01');
    expect(out.tip?.id).toBe('a');
    out = pickTip(rules, facts(), out.state, '2026-09-01');
    expect(out.tip?.id).toBe('a');
    // Dismissed today: the day stays empty; b comes tomorrow.
    const dismissed = dismissTip(out.state, 'a');
    expect(pickTip(rules, facts(), dismissed, '2026-09-01').tip).toBeNull();
    expect(pickTip(rules, facts(), dismissed, '2026-09-02').tip?.id).toBe('b');
  });

  it('orders by the day the condition first held, then by rule order', () => {
    const rules = [rule('late', (f) => f.groups > 0), rule('early', always), rule('also-early', always)];
    let state = pickTip(rules, facts(), {}, '2026-09-01').state; // early shown
    state = pickTip(rules, facts({ groups: 1 }), state, '2026-09-02').state; // also-early shown
    const third = pickTip(rules, facts({ groups: 1 }), state, '2026-09-03');
    expect(third.tip?.id).toBe('late');
    expect(third.state.early?.firstHeld).toBe('2026-09-01');
    expect(third.state.late?.firstHeld).toBe('2026-09-02');
  });

  it('keeps a shown tip away for its cooldown, and × does the same', () => {
    const rules = [rule('a', always, { cooldownDays: 3 })];
    expect(days(rules, facts(), '2026-09-01', 5).tips).toEqual(['a', null, null, 'a', null]);
    const shown = pickTip(rules, facts(), {}, '2026-09-01');
    const later = laterTip(shown.state, 'a', '2026-09-01');
    expect(pickTip(rules, facts(), later, '2026-09-01').tip).toBeNull();
    expect(pickTip(rules, facts(), later, '2026-09-03').tip).toBeNull();
    expect(pickTip(rules, facts(), later, '2026-09-04').tip?.id).toBe('a');
  });

  it('never shows a dismissed tip again', () => {
    const rules = [rule('a', always, { cooldownDays: 1 })];
    const state = dismissTip({}, 'a');
    expect(days(rules, facts(), '2026-09-01', 30, state).tips.every((t) => t === null)).toBe(true);
  });

  it('drops a tip whose condition stops holding, and starts its hold over', () => {
    const rules = [rule('a', (f) => f.groups === 0, { holdsForDays: 1 })];
    let out = pickTip(rules, facts(), {}, '2026-09-01');
    out = pickTip(rules, facts(), out.state, '2026-09-02');
    expect(out.tip?.id).toBe('a');
    out = pickTip(rules, facts({ groups: 1 }), out.state, '2026-09-02');
    expect(out.tip).toBeNull();
    expect(out.state.a?.firstHeld).toBeUndefined();
  });

  it('shows nothing during first run', () => {
    expect(pickTip([rule('a', always)], facts({ firstRun: true }), {}, '2026-09-01').tip).toBeNull();
  });

  it('never tips about a plugin that is not installed, unless the action installs it', () => {
    const f = facts({ plugins: new Set() });
    expect(pickTip([rule('a', always, { plugin: 'speech' })], f, {}, '2026-09-01').tip).toBeNull();
    expect(pickTip([rule('a', always, { plugin: 'speech', installs: true })], f, {}, '2026-09-01').tip?.id).toBe('a');
  });

  it('treats a rule that throws as not holding', () => {
    expect(pickTip([rule('a', () => { throw new Error('no'); })], facts(), {}, '2026-09-01').tip).toBeNull();
  });
});

describe('listTips', () => {
  it('says where each rule stands, and changes nothing', () => {
    const rules = [rule('a', always, { cooldownDays: 3 }), rule('b', (f) => f.groups > 0), rule('c', always, { holdsForDays: 2 })];
    const state: TipsState = { a: { firstHeld: '2026-08-20', laterAt: '2026-08-30' } };
    const frozen = structuredClone(state);
    const rows = listTips(rules, facts(), state, '2026-09-01');
    expect(rows.map((r) => [r.id, r.status])).toEqual([['a', 'shown'], ['b', 'quiet'], ['c', 'holding']]);
    expect(rows[0]!.shownAt).toBe('2026-08-30');
    expect(rows[2]!.holdsSince).toBe('2026-09-01');
    expect(state).toEqual(frozen);
    // Past its cooldown, a is today's.
    expect(listTips(rules, facts(), state, '2026-09-02')[0]).toMatchObject({ status: 'today', holdsSince: '2026-08-20' });
  });

  it('keeps the day of a dismissal, and restore forgets it', () => {
    const dismissed = dismissTip({ a: { firstHeld: '2026-09-01' } }, 'a', '2026-09-02');
    expect(listTips([rule('a', always)], facts(), dismissed, '2026-09-03')[0]).toMatchObject({ status: 'dismissed', dismissedAt: '2026-09-02' });
    const back = restoreTip(dismissed, 'a');
    expect(back).toEqual({ a: { firstHeld: '2026-09-01' } });
    expect(pickTip([rule('a', always)], facts(), back, '2026-09-03').tip?.id).toBe('a');
    expect(restoreTip(dismissTip({}, 'b'), 'b')).toEqual({});
  });
});

describe('days', () => {
  it('reads the day on the owner clock', () => {
    const at = new Date('2026-09-01T23:30:00Z');
    expect(dayIn(at, 'UTC')).toBe('2026-09-01');
    expect(dayIn(at, 'Europe/Paris')).toBe('2026-09-02');
    expect(daysBetween('2026-09-30', '2026-10-02')).toBe(2);
  });
});
