/**
 * Which tip, if any, Home shows today (docs/dashboard.md, Home).
 *
 * Per rule the engine keeps the day its condition first held (`firstHeld`),
 * the day it was last shown (`shownAt`), the day the owner put it off with ×
 * (`laterAt`) and whether they said "Not this again" (`dismissed`). The rules:
 *
 * - at most one card a day: once a tip is shown on a day, no other shows that
 *   day, and one put off or dismissed leaves the day empty;
 * - a tip shows when its condition has held for `holdsForDays` and
 *   `cooldownDays` have passed since it was last shown or put off; among
 *   several, the one that has held longest, then the one first in `TIPS`;
 * - never during first run, never while tips are off;
 * - never a tip about a plugin that is not installed, unless its action
 *   installs it;
 * - a tip whose condition stops holding disappears, and its hold starts over;
 * - dismissed is forever.
 *
 * Pure: state in, state out. `route.ts` reads and writes it under
 * `core.web_settings` → `tips.state`.
 */
import type { Facts } from './facts.js';
import type { TipAction, TipRule } from './rules.js';

export interface TipRuleState {
  firstHeld?: string;
  shownAt?: string;
  laterAt?: string;
  dismissed?: boolean;
  /** The day of "Not this again", when it was said since this was kept. */
  dismissedAt?: string;
}

export type TipsState = Record<string, TipRuleState>;

/** What Home draws. */
export interface TipView {
  id: string;
  text: string;
  action: TipAction;
}

/** `YYYY-MM-DD` on the owner's clock. */
export function dayIn(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function applies(rule: TipRule, facts: Facts): boolean {
  if (rule.plugin && !facts.plugins.has(rule.plugin) && !rule.installs) return false;
  try {
    return rule.when(facts);
  } catch {
    return false;
  }
}

/** The card a rule draws, its sentence and action filled in from the facts. */
export function viewOf(rule: TipRule, facts: Facts): TipView {
  const text = typeof rule.text === 'function' ? rule.text(facts) : rule.text;
  const action = typeof rule.action === 'function' ? rule.action(facts) : rule.action;
  return { id: rule.id, text, action: { ...action } };
}

/**
 * Today's tip, and the state to keep. The state changes when a hold starts or
 * stops, and when a tip is picked for today.
 */
export function pickTip(
  rules: readonly TipRule[],
  facts: Facts,
  previous: TipsState,
  today: string,
): { tip: TipView | null; state: TipsState } {
  const state: TipsState = {};
  for (const [id, entry] of Object.entries(previous)) state[id] = { ...entry };

  // Holds first, for every rule, so a hold keeps counting while another tip shows.
  const holding = new Set<string>();
  for (const rule of rules) {
    const entry = (state[rule.id] ??= {});
    if (applies(rule, facts)) {
      holding.add(rule.id);
      if (!entry.firstHeld) entry.firstHeld = today;
    } else {
      delete entry.firstHeld;
    }
    if (Object.keys(entry).length === 0) delete state[rule.id];
  }

  if (facts.firstRun) return { tip: null, state };

  // One card a day: today's, if there was one.
  const todays = rules.find((rule) => state[rule.id]?.shownAt === today);
  if (todays) {
    const entry = state[todays.id]!;
    const live = holding.has(todays.id) && !entry.dismissed && entry.laterAt !== today;
    return { tip: live ? viewOf(todays, facts) : null, state };
  }

  const ready = rules
    .map((rule, index) => ({ rule, index, entry: state[rule.id] }))
    .filter(({ rule, entry }) => {
      if (!entry || !holding.has(rule.id) || entry.dismissed || !entry.firstHeld) return false;
      if (daysBetween(entry.firstHeld, today) < rule.holdsForDays) return false;
      const last = [entry.shownAt, entry.laterAt].filter((d): d is string => !!d).sort().pop();
      return !last || daysBetween(last, today) >= rule.cooldownDays;
    })
    .sort((a, b) => a.entry!.firstHeld!.localeCompare(b.entry!.firstHeld!) || a.index - b.index);

  const chosen = ready[0];
  if (!chosen) return { tip: null, state };
  state[chosen.rule.id] = { ...chosen.entry, shownAt: today };
  return { tip: viewOf(chosen.rule, facts), state };
}

/**
 * The stack the lightbulb on Home opens: today's tip in front, then every
 * other tip that is ready, in the engine's order (held longest, then first in
 * `TIPS`), at most `max` (all of them by default).
 *
 * Only the front one is remembered as shown (`pickTip`'s state); the cards
 * behind it are a peek, and each is shown or put off when the owner swipes to
 * it and acts (`later`/`dismiss` per tip). One put off or dismissed today
 * leaves the stack, and the rest move up.
 */
export function pickQueue(
  rules: readonly TipRule[],
  facts: Facts,
  previous: TipsState,
  today: string,
  max = Number.POSITIVE_INFINITY,
): { tips: TipView[]; state: TipsState } {
  const { tip, state } = pickTip(rules, facts, previous, today);
  if (facts.firstRun || max <= 0) return { tips: [], state };
  const tips: TipView[] = tip ? [tip] : [];
  const ready = rules
    .map((rule, index) => ({ rule, index, entry: state[rule.id] }))
    .filter(({ rule, entry }) => {
      if (rule.id === tip?.id || !entry?.firstHeld || entry.dismissed || !applies(rule, facts)) return false;
      if (entry.laterAt === today || entry.shownAt === today) return false;
      if (daysBetween(entry.firstHeld, today) < rule.holdsForDays) return false;
      const last = [entry.shownAt, entry.laterAt].filter((d): d is string => !!d).sort().pop();
      return !last || daysBetween(last, today) >= rule.cooldownDays;
    })
    .sort((a, b) => a.entry!.firstHeld!.localeCompare(b.entry!.firstHeld!) || a.index - b.index);
  for (const { rule } of ready) {
    if (tips.length >= max) break;
    tips.push(viewOf(rule, facts));
  }
  return { tips, state };
}

/** "Not this again": never again, until the Tips list brings it back. */
export function dismissTip(previous: TipsState, id: string, today?: string): TipsState {
  return { ...previous, [id]: { ...previous[id], dismissed: true, ...(today ? { dismissedAt: today } : {}) } };
}

/** "Bring back": the dismissal is forgotten; holds and cooldowns stay. */
export function restoreTip(previous: TipsState, id: string): TipsState {
  const { dismissed: _d, dismissedAt: _at, ...rest } = previous[id] ?? {};
  const next = { ...previous };
  if (Object.keys(rest).length) next[id] = rest;
  else delete next[id];
  return next;
}

export type TipStatus = 'today' | 'holding' | 'quiet' | 'dismissed' | 'shown';

/** One row of the Tips list. */
export interface TipListRow extends TipView {
  status: TipStatus;
  dismissedAt?: string;
  holdsSince?: string;
  shownAt?: string;
}

/**
 * Every rule and where it stands, reading the state without changing it:
 *
 * - `today`: the engine would show it now and it has not been shown today;
 * - `shown`: shown (or put off) today or within its cooldown;
 * - `dismissed`: "Not this again";
 * - `holding`: its condition holds, waiting its day;
 * - `quiet`: its condition does not hold.
 */
export function listTips(rules: readonly TipRule[], facts: Facts, previous: TipsState, today: string): TipListRow[] {
  const { tip, state } = pickTip(rules, facts, previous, today);
  return rules.map((rule) => {
    const before = previous[rule.id] ?? {};
    const after = state[rule.id] ?? {};
    const row: TipListRow = viewOf(rule, facts) as TipListRow;
    const last = [before.shownAt, before.laterAt].filter((d): d is string => !!d).sort().pop();
    if (before.shownAt) row.shownAt = before.shownAt;
    if (before.dismissed) {
      row.status = 'dismissed';
      if (before.dismissedAt) row.dismissedAt = before.dismissedAt;
    } else if (tip?.id === rule.id && before.shownAt !== today) {
      row.status = 'today';
    } else if (last && (last === today || daysBetween(last, today) < rule.cooldownDays)) {
      row.status = 'shown';
      row.shownAt = before.shownAt ?? last;
    } else if (!applies(rule, facts)) {
      row.status = 'quiet';
    } else {
      row.status = 'holding';
    }
    if (after.firstHeld && (row.status === 'holding' || row.status === 'today')) row.holdsSince = after.firstHeld;
    return row;
  });
}

/** ×: not today, and not before its cooldown has passed. */
export function laterTip(previous: TipsState, id: string, today: string): TipsState {
  return { ...previous, [id]: { ...previous[id], laterAt: today } };
}
