/**
 * The Blob as a Telegram sticker: the thinking loop shown while a run works.
 *
 * A bot can show only stickers from a set some user owns, so the bot creates
 * one set on the paired owner's behalf — `buddi_working_by_<bot username>`,
 * the `_by_` suffix being Telegram's rule — from the two `.tgs` loops shipped
 * in `assets/mascot/`. It is made lazily, the first time a run needs it, and
 * the stickers' `file_id`s are remembered (`telegram.stickers` in
 * `core.web_settings`), so the files are uploaded once per bot.
 *
 * The set is made the documented way: each `.tgs` goes up through
 * `uploadStickerFile` first, and `createNewStickerSet` names the returned
 * `file_id`s. (Attaching the `.tgs` inline to `createNewStickerSet` was refused
 * as "wrong file type" where the same file uploaded fine on its own.) A set that
 * already exists, from an earlier partial attempt, is read and reused as is.
 *
 * Every failure here is cosmetic. A transient one (the network) is retried the
 * next time; a refusal (Telegram answered no) is logged once and remembered
 * with the buddi version that met it, and that version keeps the text
 * placeholder. A different version (an upgrade, or another dev build) tries once more.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWebSetting, writeWebSetting, type Queryable } from '@buddi/core';
import { TelegramApiError, type TelegramApi, type TelegramStickerSet } from './api.js';
import { currentVersion } from '../web/version.js';

export const STICKERS_SETTING = 'telegram.stickers';

export type StickerState = 'working' | 'idle';

/** Each state's emoji in the set: how a listed sticker is told apart from the other. */
export const STICKER_EMOJI: Record<StickerState, string> = { working: '⏳', idle: '🙂' };

const STATES: readonly StickerState[] = ['working', 'idle'];

/** The set's name for a bot: Telegram requires the `_by_<bot username>` ending. */
export function stickerSetName(botUsername: string): string {
  return `buddi_working_by_${botUsername.replace(/^@/, '')}`;
}

/** The shipped loop for a state, read from the gateway package's own assets. */
export function readMascotTgs(state: StickerState): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../assets/mascot/core-${state}.tgs`, import.meta.url)));
}

interface Stored {
  set: string;
  fileIds?: Partial<Record<StickerState, string>>;
  /** Telegram's refusal, verbatim: the text placeholder is used from then on. */
  refused?: string;
  /** When the refusal came, and the buddi version that met it: only that version honours it. */
  refusedAt?: string;
  refusedVersion?: string;
}

export interface MascotStickerDeps {
  api: Pick<TelegramApi, 'getStickerSet' | 'uploadStickerFile' | 'createNewStickerSet' | 'addStickerToSet'>;
  pool: Queryable;
  botUsername: string;
  /** The Telegram user who owns the set: the paired owner of this chat. */
  ownerUserId: (chatId: string) => Promise<string | undefined>;
  readTgs?: (state: StickerState) => Buffer;
  /** The running buddi version (`currentVersion()` by default); a stored refusal holds only for it. */
  version?: () => Promise<string>;
  now?: () => Date;
  log?: (line: string) => void;
}

export class MascotStickers {
  readonly #deps: MascotStickerDeps;
  readonly #name: string;
  #known: Stored | null = null;
  #making: Promise<Stored | null> | null = null;

  constructor(deps: MascotStickerDeps) {
    this.#deps = deps;
    this.#name = stickerSetName(deps.botUsername);
  }

  get setName(): string {
    return this.#name;
  }

  /** The `file_id` to send for a state, making the set first if need be; undefined means use text. */
  async fileId(state: StickerState, chatId: string): Promise<string | undefined> {
    const known = this.#known ?? (await this.#read());
    if (known?.refused && known.refusedVersion === (await this.#version())) return undefined;
    const id = known?.refused ? undefined : known?.fileIds?.[state];
    if (id) return id;
    this.#making ??= this.#make(chatId).finally(() => { this.#making = null; });
    return (await this.#making)?.fileIds?.[state];
  }

  #running: Promise<string> | null = null;

  #version(): Promise<string> {
    this.#running ??= (this.#deps.version ?? (() => currentVersion()))().catch(() => '0.0.0');
    return this.#running;
  }

  async #read(): Promise<Stored | null> {
    const stored = await readWebSetting<Stored>(this.#deps.pool, STICKERS_SETTING).catch(() => null);
    // A set remembered for another bot is not this bot's to send from.
    this.#known = stored && stored.set === this.#name ? stored : null;
    return this.#known;
  }

  async #remember(stored: Stored): Promise<Stored> {
    this.#known = stored;
    await writeWebSetting(this.#deps.pool, STICKERS_SETTING, stored).catch((err) => {
      this.#log(`telegram: the sticker ids could not be saved: ${String(err)}`);
    });
    return stored;
  }

  async #make(chatId: string): Promise<Stored | null> {
    const { api } = this.#deps;
    const read = this.#deps.readTgs ?? readMascotTgs;
    try {
      const userId = await this.#deps.ownerUserId(chatId);
      if (!userId) return null;
      let set = await api.getStickerSet(this.#name).catch((err: unknown) => {
        if (err instanceof TelegramApiError && err.status === 400) return null; // no such set yet
        throw err;
      });
      const upload = async (state: StickerState): Promise<string> =>
        (await api.uploadStickerFile(userId, read(state), 'animated')).file_id;
      if (!set) {
        const stickers = [];
        for (const state of STATES) {
          stickers.push({ sticker: await upload(state), format: 'animated' as const, emoji_list: [STICKER_EMOJI[state]] });
        }
        await api.createNewStickerSet({ user_id: userId, name: this.#name, title: 'buddi', stickers });
        set = await api.getStickerSet(this.#name);
      } else {
        // A set made earlier, but missing a state (a newer release adds one): add it.
        const missing = STATES.filter((state) => !idOf(set!, state));
        for (const state of missing) {
          await api.addStickerToSet({
            user_id: userId,
            name: this.#name,
            sticker: { sticker: await upload(state), format: 'animated', emoji_list: [STICKER_EMOJI[state]] },
          });
        }
        if (missing.length > 0) set = await api.getStickerSet(this.#name);
      }
      const fileIds: Partial<Record<StickerState, string>> = {};
      for (const state of STATES) {
        const id = idOf(set, state);
        if (id) fileIds[state] = id;
      }
      const stored = await this.#remember({ set: this.#name, fileIds });
      this.#log(`telegram: sticker set ${this.#name} ready`);
      return stored;
    } catch (err) {
      if (err instanceof TelegramApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        this.#log(`telegram: the sticker set ${this.#name} was refused (${err.description}); the working placeholder stays text`);
        return this.#remember({
          set: this.#name,
          refused: err.description,
          refusedAt: (this.#deps.now?.() ?? new Date()).toISOString(),
          refusedVersion: await this.#version(),
        });
      }
      this.#log(`telegram: the sticker set could not be made yet: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  #log(line: string): void {
    this.#deps.log?.(line);
  }
}

function idOf(set: TelegramStickerSet, state: StickerState): string | undefined {
  const bare = (emoji: string | undefined): string => (emoji ?? '').replace(/\uFE0F/g, '');
  return set.stickers.find((sticker) => bare(sticker.emoji) === bare(STICKER_EMOJI[state]))?.file_id;
}
