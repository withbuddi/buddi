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
import { readWebSetting, writeWebSetting, type Queryable } from '@buddi/core';
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

async function writeNoticeState(pool: Queryable, state: PassphraseNoticeState): Promise<void> {
  await writeWebSetting(pool, PASSPHRASE_NOTICE_KEY, state);
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

/** What Home's card shows: the words, until they are acknowledged. */
export async function passphraseNotice(deps: PassphraseNoticeDeps): Promise<{ show: false } | { show: true; passphrase: string }> {
  const state = await readNoticeState(deps.pool);
  if (state.acknowledgedAt !== undefined) return { show: false };
  if (!(await hasEncryptedBackup(deps))) return { show: false };
  const phrase = await words(deps);
  return phrase === undefined ? { show: false } : { show: true, passphrase: phrase };
}

/** "I saved it": the card goes, for good. */
export async function acknowledgePassphrase(deps: Pick<PassphraseNoticeDeps, 'pool' | 'now'>): Promise<PassphraseNoticeState> {
  const state = await readNoticeState(deps.pool);
  const next = { ...state, acknowledgedAt: state.acknowledgedAt ?? (deps.now ?? (() => new Date()))().toISOString() };
  await writeNoticeState(deps.pool, next);
  return next;
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
    await writeNoticeState(deps.pool, { ...state, telegramAt: at, telegram: 'not-paired' });
    return 'not-paired';
  }
  const phrase = await words(deps);
  if (phrase === undefined) return 'waiting';
  try {
    await deps.sendTelegram(passphraseTelegramText(phrase));
    await writeNoticeState(deps.pool, { ...state, telegramAt: at, telegram: 'sent' });
    return 'sent';
  } catch (error) {
    const notPaired = (error as { code?: unknown } | null)?.code === 'owner-not-paired' || (error as { code?: unknown } | null)?.code === 'telegram-not-configured';
    await writeNoticeState(deps.pool, { ...state, telegramAt: at, telegram: notPaired ? 'not-paired' : 'failed' });
    if (!notPaired) deps.log?.(`backup passphrase: the Telegram message did not go: ${error instanceof Error ? error.message : String(error)}`);
    return notPaired ? 'not-paired' : 'failed';
  }
}
