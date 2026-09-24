/**
 * The bot's profile photo follows the default agent's uploaded picture.
 *
 * One bot speaks for every agent (`/use` switches who answers in a chat), and
 * Telegram gives a bot one profile photo, not one per chat. So the photo is
 * the face of the agent a chat lands on first: the default agent. Another
 * agent's picture shows on the dashboard only.
 *
 * What was last pushed is remembered (`telegram.profile_photo` in
 * `core.web_settings`), which makes this cheap to call on every start and
 * every change, and means a photo buddi never set — one the owner gave the bot
 * in BotFather — is never taken down: removal happens only over a photo this
 * code put there.
 */
import { readWebSetting, writeWebSetting, type AgentCatalog, type Queryable } from '@buddi/core';
import { avatarJpeg } from '../agents/avatar-image.js';
import { readAvatar } from '../agents/avatars.js';
import type { TelegramApi } from './api.js';

export const PROFILE_PHOTO_SETTING = 'telegram.profile_photo';

interface Pushed {
  /** The sha256 of the picture last set, or null when buddi removed its own. */
  sha256: string | null;
}

export type ProfilePhotoOutcome = 'set' | 'removed' | 'unchanged';

export async function syncProfilePhoto(deps: {
  api: Pick<TelegramApi, 'setMyProfilePhoto' | 'removeMyProfilePhoto'>;
  pool: Queryable;
  catalog: Pick<AgentCatalog, 'defaultAgent'>;
}): Promise<ProfilePhotoOutcome> {
  const agentId = deps.catalog.defaultAgent().id;
  const picture = await readAvatar(deps.pool, agentId);
  const pushed = await readWebSetting<Pushed>(deps.pool, PROFILE_PHOTO_SETTING);
  const last = pushed?.sha256 ?? null;
  if (picture) {
    if (picture.sha256 === last) return 'unchanged';
    await deps.api.setMyProfilePhoto(avatarJpeg(picture.png));
    await writeWebSetting(deps.pool, PROFILE_PHOTO_SETTING, { sha256: picture.sha256 } satisfies Pushed);
    return 'set';
  }
  if (last === null) return 'unchanged';
  await deps.api.removeMyProfilePhoto();
  await writeWebSetting(deps.pool, PROFILE_PHOTO_SETTING, { sha256: null } satisfies Pushed);
  return 'removed';
}
