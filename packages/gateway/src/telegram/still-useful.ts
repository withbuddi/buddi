/**
 * "Still useful?" on Telegram: Keep and Stop under the question an agent's
 * quiet watch raises after 48 silent runs (docs/missions.md).
 *
 * The buttons bind to the notification row, not the mission: a mission id can
 * be longer than Telegram's 64 bytes of callback data, a uuid never is, and
 * the row's key names the mission. A tap is owner-only and idempotent; the
 * message is edited to say what came of it.
 */
import type { StillUsefulOutcome } from '@buddi/core';
import { MAX_CALLBACK_DATA_BYTES, type InlineKeyboardMarkup } from './api.js';

/** `stl:` — Keep or Stop on "Still useful?". */
export const STILL_USEFUL_CALLBACK_PREFIX = 'stl';

export type StillUsefulChoice = 'keep' | 'stop';

/** `stl:<notification id>:k|s`, refused rather than truncated if it cannot fit. */
export function stillUsefulCallbackData(notificationId: string, choice: StillUsefulChoice): string {
  const data = `${STILL_USEFUL_CALLBACK_PREFIX}:${notificationId}:${choice === 'keep' ? 'k' : 's'}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`still-useful callback data is too long for Telegram: ${data.length} bytes`);
  }
  return data;
}

/** The notification id and choice in a `stl:` callback, or nothing. Strict on the uuid. */
export function parseStillUsefulCallback(
  data: string | undefined,
): { notificationId: string; choice: StillUsefulChoice } | undefined {
  const m = /^stl:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([ks])$/i.exec((data ?? '').trim());
  if (!m) return undefined;
  return { notificationId: (m[1] as string).toLowerCase(), choice: m[2]!.toLowerCase() === 'k' ? 'keep' : 'stop' };
}

/** Keep and Stop, side by side: two short words fit one row. */
export function stillUsefulKeyboard(notificationId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: 'Keep', callback_data: stillUsefulCallbackData(notificationId, 'keep') },
      { text: 'Stop', callback_data: stillUsefulCallbackData(notificationId, 'stop') },
    ]],
  };
}

/** The line the edited message ends with, and the toast the tap answers. */
export function stillUsefulOutcomeText(outcome: StillUsefulOutcome): string {
  switch (outcome) {
    case 'kept':
      return 'Kept. It carries on, and its count of quiet runs starts again.';
    case 'already-kept':
      return 'Already kept.';
    case 'stopped':
      return 'Stopped. Switch it back on in Missions if you change your mind.';
    case 'already-stopped':
      return 'Already stopped.';
    case 'gone':
      return 'That mission no longer exists.';
  }
}
