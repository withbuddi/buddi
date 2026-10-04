/**
 * The backup passphrase, shown to the owner once, when it starts to matter.
 *
 * It is not part of first run: nothing is locked with it until the first
 * backup. Once an encrypted backup exists (scheduled or taken by hand), Home
 * shows the six words in a card that stays until the owner presses "I saved
 * it", and the same words go once to Telegram when a phone is paired, with
 * the advice to delete the message once they are saved. After that the words
 * are behind Settings → Backup's Reveal (and the PIN, when there is one).
 *
 * What was said and acknowledged is one dashboard setting; the words
 * themselves are never written anywhere but the vault and that one message.
 */
import { readWebSetting, type Queryable } from '@buddi/core';
import type { RouteReply } from './backups.js';

export const PASSPHRASE_NOTICE_KEY = 'backup.passphraseNotice';

export interface PassphraseNoticeState {
  /** When the owner pressed "I saved it" on Home. */
  acknowledgedAt?: string;
  /** When the Telegram message went (or was skipped: `telegram` says which). */
  telegramAt?: string;
  telegram?: 'sent' | 'not-paired' | 'failed';
}

export interface PassphraseNoticeDeps {
  pool: Queryable;
  /** `listBackups` (backups.ts): the supervisor's list, or the checkout's folder. */
  listBackups: () => Promise<RouteReply>;
  /** `passphraseRoute` GET: the words in the vault. */
  passphrase: () => Promise<RouteReply>;
  /** Telegram's owner chat; throws when nothing is paired. Absent: no Telegram at all. */
  sendTelegram?: (text: string) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The message Telegram gets, once. */
export function passphraseTelegramText(phrase: string): string {
  return [
    'buddi took its first backup. These six words open your backups, and only you have them:',
    '',
    phrase,
    '',
    'Write them down somewhere safe, then delete this message.',
  ].join('\n');
}

export async function readNoticeState(pool: Queryable): Promise<PassphraseNoticeState> {
  const value = await readWebSetting<PassphraseNoticeState>(pool, PASSPHRASE_NOTICE_KEY);
  return value !== null && typeof value === 'object' ? value : {};
}

/**
 * Merge `patch` into the stored state in one statement, so "I saved it" and
 * the Telegram delivery (which waits on a send in between) never write back
 * a stale copy of each other's fields. `keep: true` lets a field already
 * stored win (the first acknowledgement stays the one recorded).
 */
async function mergeNoticeState(pool: Queryable, patch: PassphraseNoticeState, options: { keep?: boolean } = {}): Promise<PassphraseNoticeState> {
  const stored = `(case when jsonb_typeof(core.web_settings.value) = 'object' then core.web_settings.value else '{}'::jsonb end)`;
  const merged = options.keep ? `excluded.value || ${stored}` : `${stored} || excluded.value`;
  const { rows } = await pool.query(
    `insert into core.web_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = ${merged}, updated_at = now()
     returning value`,
    [PASSPHRASE_NOTICE_KEY, JSON.stringify(patch)],
  );
  const value = rows[0]?.value as PassphraseNoticeState | undefined;
  return value !== null && typeof value === 'object' ? value : patch;
}

/** Is there a backup locked with the passphrase yet? */
async function hasEncryptedBackup(deps: PassphraseNoticeDeps): Promise<boolean> {
  const listed = await deps.listBackups().catch(() => null);
  if (listed?.status !== 200) return false;
  const archives = (listed.body as { archives?: Array<{ name?: unknown; encrypted?: unknown }> }).archives ?? [];
  return archives.some((archive) => archive.encrypted === true || (typeof archive.name === 'string' && archive.name.endsWith('.age')));
}

async function words(deps: PassphraseNoticeDeps): Promise<string | undefined> {
  const reply = await deps.passphrase().catch(() => null);
  const phrase = reply?.status === 200 ? (reply.body as { passphrase?: unknown }).passphrase : undefined;
  return typeof phrase === 'string' && phrase.trim() !== '' ? phrase : undefined;
}

export type PassphraseNotice = { show: false } | { show: true; passphrase: string } | { show: true; needsPin: true };

/**
 * What Home's card shows: the words, until they are acknowledged. With
 * `words: false` (a PIN is set) the card is due but the words are not sent:
 * it asks for the PIN and reveals them through POST …/passphrase/reveal.
 */
export async function passphraseNotice(deps: PassphraseNoticeDeps, options: { words?: boolean } = {}): Promise<PassphraseNotice> {
  const state = await readNoticeState(deps.pool);
  if (state.acknowledgedAt !== undefined) return { show: false };
  if (!(await hasEncryptedBackup(deps))) return { show: false };
  const phrase = await words(deps);
  if (phrase === undefined) return { show: false };
  return options.words === false ? { show: true, needsPin: true } : { show: true, passphrase: phrase };
}

/** "I saved it": the card goes, for good. */
export async function acknowledgePassphrase(deps: Pick<PassphraseNoticeDeps, 'pool' | 'now'>): Promise<PassphraseNoticeState> {
  return await mergeNoticeState(deps.pool, { acknowledgedAt: (deps.now ?? (() => new Date()))().toISOString() }, { keep: true });
}

/**
 * The Telegram message, once: after the first encrypted backup, to the paired
 * phone. Nothing paired then means nothing is sent later either (the words
 * are on Home and in Settings → Backup). A send that failed is tried again on
 * the next pass. Returns what it did.
 */
export async function telegramPassphraseOnce(deps: PassphraseNoticeDeps): Promise<'sent' | 'not-paired' | 'failed' | 'waiting' | 'done'> {
  const state = await readNoticeState(deps.pool);
  if (state.telegramAt !== undefined && state.telegram !== 'failed') return 'done';
  if (!(await hasEncryptedBackup(deps))) return 'waiting';
  const at = (deps.now ?? (() => new Date()))().toISOString();
  if (!deps.sendTelegram) {
    await mergeNoticeState(deps.pool, { telegramAt: at, telegram: 'not-paired' });
    return 'not-paired';
  }
  const phrase = await words(deps);
  if (phrase === undefined) return 'waiting';
  try {
    await deps.sendTelegram(passphraseTelegramText(phrase));
    await mergeNoticeState(deps.pool, { telegramAt: at, telegram: 'sent' });
    return 'sent';
  } catch (error) {
    const notPaired = (error as { code?: unknown } | null)?.code === 'owner-not-paired' || (error as { code?: unknown } | null)?.code === 'telegram-not-configured';
    await mergeNoticeState(deps.pool, { telegramAt: at, telegram: notPaired ? 'not-paired' : 'failed' });
    if (!notPaired) deps.log?.(`backup passphrase: the Telegram message did not go: ${error instanceof Error ? error.message : String(error)}`);
    return notPaired ? 'not-paired' : 'failed';
  }
}
