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
import { createPool } from '@buddi/core';
import { createPairingCode, listDevices, unpairDevice } from '@buddi/gateway';
import qrcode from 'qrcode-terminal';
import type { TelegramAction } from './args.js';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

/** How long a pairing code is worth anything. Short: it is shown, then used. */
export const PAIRING_TTL_MINUTES = 10;

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
      for (const d of devices) {
        const seen = d.lastSeenAt ? `last seen ${d.lastSeenAt.toISOString()}` : 'never seen';
        const paired = d.pairedAt ? d.pairedAt.toISOString() : 'unknown';
        console.log(
          `${bold(d.id)}  ${d.surface}  ${d.label ?? dim('(no label)')}  ` +
            `user ${d.externalUserId}${d.externalChatId ? ` chat ${d.externalChatId}` : ''}  ` +
            dim(`paired ${paired}, ${seen}`),
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
