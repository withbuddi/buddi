import { readPluginAsset } from '@buddi/core';
import type { TelegramApi } from './api.js';

/** A story chosen by the agent may illustrate its answer using the local feed cache. */
export async function sendStoryPhoto(
  api: Pick<TelegramApi, 'sendPhoto'>, chatId: string, output: unknown,
  env: NodeJS.ProcessEnv,
  read: typeof readPluginAsset = readPluginAsset,
): Promise<boolean> {
  if (!output || typeof output !== 'object') return false;
  const story = output as { id?: unknown; title?: unknown; image?: unknown };
  if (typeof story.id !== 'string' || !/^s_[a-zA-Z0-9_-]+$/.test(story.id) || !story.image || typeof story.image !== 'object') return false;
  const image = story.image as { key?: unknown; caption?: unknown; credit?: unknown; outlet?: unknown };
  if (typeof image.key !== 'string' || !/^story-a_[a-zA-Z0-9_-]+$/.test(image.key)) return false;
  const bytes = await read('news', image.key, 768, env);
  if (!bytes) return false;
  const caption = [story.title, image.caption, [image.credit, image.outlet].filter(v => typeof v === 'string' && v).join(' · ')]
    .filter(v => typeof v === 'string' && v).join('\n').slice(0, 1000);
  const id = await api.sendPhoto(chatId, bytes, { filename: 'story.png', contentType: 'image/png', caption });
  return typeof id === 'number';
}
