/**
 * The old `.env` way in: `TELEGRAM_OWNER_USER_ID` / `TELEGRAM_OWNER_CHAT_ID`.
 *
 * They used to pair the owner at every start, so a phone the owner unpaired
 * in Settings → Telegram came back on the next restart. Pairing by code or QR
 * writes the database and is the only way now; this adopts what the two lines
 * named, once, and then never reads them again:
 *
 *  - Already recorded (`ENV_OWNER_ADOPTED_KEY` in `core.web_settings`): `done`,
 *    without looking at the environment.
 *  - Neither line set: nothing is paired and nothing is recorded.
 *  - Set, and that Telegram user is not paired yet: paired with `paired_via`
 *    'env' one last time. Set and already paired: left as it is. Either way
 *    the adoption is recorded, so a later unpair is respected.
 */
import { getSurfaceIdentity, pairSurfaceIdentity, readWebSetting, writeWebSetting, type Queryable } from '@buddi/core';
import { SURFACE } from './surface.js';

/** The setting row that says the `.env` owner was adopted and is not read again. */
export const ENV_OWNER_ADOPTED_KEY = 'telegram.env_owner_adopted';

/** The two retired lines, for the doctor's warning. */
export const LEGACY_OWNER_VARS = ['TELEGRAM_OWNER_USER_ID', 'TELEGRAM_OWNER_CHAT_ID'] as const;

export type EnvOwnerAdoption =
  | { outcome: 'done' }
  | { outcome: 'none' }
  | { outcome: 'adopted' | 'exists'; userId: string };

function numeric(value: string | undefined, label: string): string | undefined {
  const raw = (value ?? '').trim();
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be a numeric id, got: ${raw}`);
  return raw;
}

export async function adoptEnvOwner(pool: Queryable, env: NodeJS.ProcessEnv): Promise<EnvOwnerAdoption> {
  if ((await readWebSetting(pool, ENV_OWNER_ADOPTED_KEY)) !== null) return { outcome: 'done' };
  const userId = numeric(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID');
  if (userId === undefined) return { outcome: 'none' };
  const chatId = numeric(env.TELEGRAM_OWNER_CHAT_ID, 'TELEGRAM_OWNER_CHAT_ID') ?? userId;

  const known = await getSurfaceIdentity(pool, SURFACE, userId);
  if (known === undefined) {
    await pairSurfaceIdentity(pool, { surface: SURFACE, externalUserId: userId, externalChatId: chatId, pairedVia: 'env' });
  }
  const outcome = known === undefined ? 'adopted' : 'exists';
  await writeWebSetting(pool, ENV_OWNER_ADOPTED_KEY, { outcome, userId, at: new Date().toISOString() });
  return { outcome, userId };
}
