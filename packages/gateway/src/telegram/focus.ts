/**
 * `/focus` on Telegram (docs/telegram.md, docs/notifications.md "Focus").
 *
 *   /focus                        what is on, and the words it takes
 *   /focus dnd 1h                 Do not disturb for an hour (3h, until tomorrow, until off)
 *   /focus urgent until tomorrow  Urgent only until 08:00 tomorrow
 *   /focus off                    turn it off
 *
 * The parser and the sentences are pure; the surface switches the focus in
 * core with what the parser answers.
 */
import { FOCUS_LABELS, type FocusDuration, type FocusMode, type FocusState } from '@buddi/core';
import { localWhen } from './commands.js';

export type FocusCommand =
  | { kind: 'status' }
  | { kind: 'set'; mode: FocusMode; duration: FocusDuration };

export const FOCUS_USAGE_TEXT = [
  '/focus dnd 1h — Do not disturb for an hour (or 3h, until tomorrow, until off)',
  '/focus urgent until tomorrow — only approvals, questions, watchers and failures',
  '/focus off — turn it off',
].join('\n');

const MODES: Record<string, Exclude<FocusMode, 'normal'>> = {
  dnd: 'do-not-disturb',
  'do-not-disturb': 'do-not-disturb',
  urgent: 'urgent-only',
  'urgent-only': 'urgent-only',
};

/** What `/focus <arg>` asks for; null when the words are not ones it takes. */
export function parseFocusArg(arg: string): FocusCommand | null {
  const words = arg.trim().toLowerCase().replace(/\s+/g, ' ');
  if (words === '') return { kind: 'status' };
  if (words === 'off' || words === 'normal') return { kind: 'set', mode: 'normal', duration: 'indefinite' };
  const [first, ...rest] = words.split(' ');
  const mode = MODES[first as string];
  if (!mode) return null;
  const duration = parseDuration(rest.join(' '));
  return duration === null ? null : { kind: 'set', mode, duration };
}

function parseDuration(words: string): FocusDuration | null {
  const w = words.replace(/^for /, '').trim();
  if (w === '' || w === 'until off' || w === 'until i turn it off' || w === 'indefinite') return 'indefinite';
  if (w === 'tomorrow' || w === 'until tomorrow' || w === 'until tomorrow morning') return 'tomorrow';
  const hours = /^(\d{1,2}) ?(?:h|hr|hrs|hour|hours)$/.exec(w) ?? (w === 'an hour' || w === 'one hour' ? ['', '1'] : null);
  if (hours) {
    const n = Number(hours[1]);
    return n >= 1 && n <= 24 ? `${n}h` : null;
  }
  return null;
}

const LETS_THROUGH: Record<Exclude<FocusMode, 'normal'>, string> = {
  'do-not-disturb': 'Approvals and questions still come through.',
  'urgent-only': 'Approvals, questions, watchers and failures still come through.',
};

function stateLine(focus: FocusState, timezone: string): string {
  const until = focus.until ? ` until ${localWhen(new Date(focus.until), timezone)}` : ' until you turn it off';
  const from = focus.by === 'schedule' ? ', from a schedule' : '';
  return `${FOCUS_LABELS[focus.mode]}${until}${from}. ${LETS_THROUGH[focus.mode]}`;
}

/** `/focus` alone: what is on, and the words it takes. */
export function focusStatusText(focus: FocusState | null, timezone: string): string {
  const head = focus ? stateLine(focus, timezone) : 'No focus is on: everything reaches you as usual.';
  return `${head}\n\n${FOCUS_USAGE_TEXT}`;
}

/** The answer once the focus is switched. */
export function focusSetText(focus: FocusState | null, timezone: string): string {
  if (!focus) return 'Focus is off.';
  return `${stateLine(focus, timezone)} /focus off to end it.`;
}
