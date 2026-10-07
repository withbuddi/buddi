/**
 * Media a tool's result leads with on Telegram (host API 1.33).
 *
 * A plugin's view descriptor declares `messenger.mediaFirst` for a tool; its
 * output lists `attachments`. Nothing here knows a plugin: the descriptor
 * decides when the streamed text is held back, the output decides what is
 * sent, and every attachment is checked against the tool's own plugin — an
 * image is read from that plugin's asset area only (never a URL, never
 * another plugin's), a report link must be that plugin's own page, and an
 * audio file must be audio.
 */
import { getArtifact, leadsWithMedia, messengerAttachments, readPluginAsset, type MessengerAttachment, type ViewDescriptor } from '@buddi/core';
import type { Pool } from 'pg';
import type { TelegramApi } from './api.js';
import { reportRecording } from '../report-audio.js';

/** The tools whose views lead with media, by name. */
export function mediaFirstViews(views: readonly ViewDescriptor[]): Map<string, ViewDescriptor> {
  return new Map(views.filter((view) => view.messenger?.mediaFirst === true).map((view) => [view.tool, view]));
}

/** Whether this call holds the streamed text back for media. */
export function holdsTextForMedia(views: ReadonlyMap<string, ViewDescriptor>, tool: string, input: unknown): boolean {
  return leadsWithMedia(views.get(tool), input);
}

/** What one result asks to lead with, or null: only tools whose view declares it. */
export function leadingMediaOf(
  views: ReadonlyMap<string, ViewDescriptor>,
  pluginOf: (tool: string) => string | undefined,
  tool: string,
  output: unknown,
): { plugin: string; attachments: MessengerAttachment[] } | null {
  if (!views.has(tool)) return null;
  const plugin = pluginOf(tool);
  if (!plugin) return null;
  const attachments = messengerAttachments(plugin, output);
  return attachments.length > 0 ? { plugin, attachments } : null;
}

export interface LeadingMediaDeps {
  api: Pick<TelegramApi, 'sendPhoto'>;
  pool: Pool;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  read?: typeof readPluginAsset;
}

/**
 * Send the images now, in order, and resolve the audio to artifact ids the
 * surface sends before the text. A missing image or recording is skipped:
 * the text answer always follows.
 */
export async function deliverLeadingMedia(
  deps: LeadingMediaDeps,
  chatId: string,
  media: { plugin: string; attachments: readonly MessengerAttachment[] },
): Promise<{ photoSent: boolean; audio: string[] }> {
  const read = deps.read ?? readPluginAsset;
  let photoSent = false;
  const audio: string[] = [];
  for (const item of media.attachments) {
    try {
      if (item.kind === 'image') {
        const bytes = await read(media.plugin, item.asset, 768, deps.env);
        if (!bytes) continue;
        const id = await deps.api.sendPhoto(chatId, bytes, { filename: `${item.asset}.png`, contentType: 'image/png', ...(item.caption ? { caption: item.caption } : {}) });
        if (typeof id === 'number') photoSent = true;
      } else if ('artifact' in item) {
        const file = await getArtifact(deps.pool, item.artifact);
        if (file?.mime.startsWith('audio/')) audio.push(file.id);
      } else {
        const file = await reportRecording(deps.pool, item.report);
        if (file) audio.push(file.id);
      }
    } catch (err) {
      deps.log(`telegram: a leading ${item.kind} from ${media.plugin} was not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { photoSent, audio: [...new Set(audio)] };
}
