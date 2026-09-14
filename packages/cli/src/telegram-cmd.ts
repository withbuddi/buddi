/**
 * `buddi telegram pair | devices | unpair <id>`.
 *
 * Pairing is the one step that cannot be done from the terminal alone: the
 * owner has to prove, from the device, that it is theirs. The CLI mints a
 * short-lived code and shows it two ways — a QR code to point a phone camera
 * at, and the same deep link as text, for a machine with no camera in front of
 * it (and for copy-paste into the desktop client).
 *
 * The code is a bearer credential for the length of its TTL, so it is printed
 * once, never written to disk, and never logged.
 */
import { createPool, localDateTimeString, timezoneFromEnv } from '@buddi/core';
import { createPairingCode, listDevices, unpairDevice } from '@buddi/gateway';
import qrcode from 'qrcode-terminal';
import type { TelegramAction } from './args.js';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

/** How long a pairing code is worth anything. Short: it is shown, then used. */
export const PAIRING_TTL_MINUTES = 10;

/* ------------------------------------------------------------------ *
 * Relative time
 * ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "3 min ago" — how long ago an instant was, as the owner would say it.
 *
 * Pure: the clock is an argument, never `Date.now()` reached for inside. One
 * unit, never two ("1 hour ago", not "1 hour 4 min ago"), because the question
 * this answers is *roughly when*, and the exact stamp is printed beside it.
 * `null` is "never" — a device that has never spoken — and an instant in the
 * future (a clock that disagrees) is "just now" rather than a negative age.
 */
export function relativeTime(at: Date | null | undefined, now: Date = new Date()): string {
  if (!at || Number.isNaN(at.getTime())) return 'never';
  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return plural(Math.floor(ms / MINUTE_MS), 'min', 'min');
  if (ms < DAY_MS) return plural(Math.floor(ms / HOUR_MS), 'hour', 'hours');
  if (ms < 365 * DAY_MS) return plural(Math.floor(ms / DAY_MS), 'day', 'days');
  return plural(Math.floor(ms / (365 * DAY_MS)), 'year', 'years');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many} ago`;
}

export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (rendered: string) => resolve(rendered));
  });
}

export async function runTelegram(
  action: TelegramAction,
  deviceId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — run `buddi init`');
    return 1;
  }
  const pool = createPool(databaseUrl);
  try {
    if (action === 'pair') {
      const { code, deepLink, expiresAt } = await createPairingCode(pool, {
        ttlMinutes: PAIRING_TTL_MINUTES,
        env,
      });
      console.log(await renderQr(deepLink));
      console.log(bold('  Scan it, or open this link on the device:'));
      console.log(`  ${deepLink}`);
      console.log(`  code ${bold(code)}`);
      console.log(
        dim(
          `  valid until ${expiresAt.toISOString()} (${PAIRING_TTL_MINUTES} minutes). ` +
            'Anyone holding it can pair — do not paste it anywhere public.',
        ),
      );
      console.log(dim('  `buddi serve` (or the installed service) must be running to receive it.'));
      return 0;
    }

    if (action === 'devices') {
      const devices = await listDevices(pool);
      if (devices.length === 0) {
        console.log('no paired devices — run `buddi telegram pair`');
        return 0;
      }
      // Every date here is the owner's wall clock (`BUDDI_TZ`): the stamp for
      // the record, the relative age for the glance.
      const timezone = timezoneFromEnv(env);
      const now = new Date();
      for (const d of devices) {
        const paired = d.pairedAt ? localDateTimeString(d.pairedAt, timezone) : 'unknown';
        const seen = d.lastSeenAt
          ? `${localDateTimeString(d.lastSeenAt, timezone)} (${relativeTime(d.lastSeenAt, now)})`
          : 'never';
        console.log(
          `${bold(d.id)}  ${d.surface}  ${d.label === null ? dim('(no label)') : d.label}  ` +
            `user ${d.externalUserId}${d.externalChatId ? ` chat ${d.externalChatId}` : ''}  ` +
            dim(`paired ${paired}, last seen ${seen}`),
        );
      }
      return 0;
    }

    const removed = await unpairDevice(pool, deviceId as string);
    console.log(
      removed
        ? `unpaired ${deviceId} — that device can no longer reach your agents`
        : `no device with id ${deviceId} (run \`buddi telegram devices\`)`,
    );
    return removed ? 0 : 1;
  } finally {
    await pool.end();
  }
}
