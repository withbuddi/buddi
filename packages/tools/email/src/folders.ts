/**
 * Which folder is which, and which ones buddi reads.
 *
 * docs/email.md §3: folders are *discovered* per account — the inbox today,
 * Sent from this step, others on request. The discovery is a listing; the
 * decision about what each folder is is this file, and it is pure, because
 * "which one is Sent" is exactly the kind of question that must be answerable
 * in a test rather than against somebody's mailbox.
 *
 * Three ways to recognise the Sent folder, in order of how much they can be
 * trusted:
 *
 *  1. **SPECIAL-USE** (RFC 6154): the server says `\Sent`. This is the answer
 *     whenever it is offered, and it is the only one that does not depend on
 *     the owner's language.
 *  2. **Gmail's path**, `[Gmail]/Sent Mail` — Gmail does report `\Sent`, but
 *     under a namespace and with a localised display name, and the constant is
 *     cheap insurance.
 *  3. **The name**, last path segment, against the handful of spellings
 *     providers actually use. A guess, and marked as one: it is used only when
 *     the first two said nothing.
 *
 * When two folders could be Sent, the better-evidenced one wins, and among
 * equals the first the server listed does — never both, because two "Sent"
 * folders would mean the owner's own mail counted twice and a thread's state
 * flipping on whichever one was polled last.
 */
import type { MailboxInfo } from './ports.js';

export const FOLDER_KINDS = ['inbox', 'sent', 'other'] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

/** Gmail's Sent folder, which lives under a namespace of its own. */
export const GMAIL_SENT = '[Gmail]/Sent Mail';

/**
 * Names that mean "the mail I sent", in the languages a provider is likely to
 * have chosen for the owner. Matched on the last path segment, lowercased.
 */
const SENT_NAMES = new Set([
  'sent',
  'sent mail',
  'sent items',
  'sent messages',
  'outbox',
  'gesendet',
  'gesendete elemente',
  'envoyés',
  'envoyes',
  'éléments envoyés',
  'elements envoyes',
  'messages envoyés',
  'messages envoyes',
  'enviados',
  'inviata',
  'posta inviata',
  'verzonden',
]);

/** The last segment of an IMAP path, whatever separator the server uses. */
export function leafOf(name: string): string {
  const parts = name.split(/[/.\\]/).filter((part) => part !== '');
  return (parts[parts.length - 1] ?? name).trim().toLowerCase();
}

/** True when the server itself said this folder is Sent. */
function saysSent(info: MailboxInfo): boolean {
  const attributes = [info.specialUse ?? '', ...info.flags].map((f) => f.trim().toLowerCase());
  return attributes.includes('\\sent');
}

/**
 * How strongly this folder claims to be Sent: 2 for the server saying so, 1
 * for Gmail's path or a name we recognise, 0 for not at all.
 */
export function sentConfidence(info: MailboxInfo): number {
  if (saysSent(info)) return 2;
  if (info.name === GMAIL_SENT) return 1;
  return SENT_NAMES.has(leafOf(info.name)) ? 1 : 0;
}

export function isInbox(info: MailboxInfo): boolean {
  return info.name.trim().toUpperCase() === 'INBOX';
}

/** One folder as the source records it. */
export interface FolderPlan {
  name: string;
  kind: FolderKind;
  /** True for the two folders this build polls: the inbox and Sent. */
  synced: boolean;
}

/**
 * What to write down for an account, from what the server listed.
 *
 * Every folder is recorded — the owner asking later for one of them is a
 * question this table should be able to answer without a second round trip —
 * and exactly two of them are marked synced.
 */
export function planFolders(listing: readonly MailboxInfo[]): FolderPlan[] {
  let best: { name: string; score: number } | null = null;
  for (const info of listing) {
    if (isInbox(info)) continue;
    const score = sentConfidence(info);
    if (score === 0) continue;
    if (!best || score > best.score) best = { name: info.name, score };
  }
  return listing.map((info) => {
    const kind: FolderKind = isInbox(info) ? 'inbox' : info.name === best?.name ? 'sent' : 'other';
    return { name: info.name, kind, synced: kind !== 'other' };
  });
}

/** The name of the Sent folder in a listing, or null when there is none. */
export function sentFolderOf(listing: readonly MailboxInfo[]): string | null {
  return planFolders(listing).find((f) => f.kind === 'sent')?.name ?? null;
}
