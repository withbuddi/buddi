/**
 * Mail to yourself: the owner's notifications as mail from their own account
 * to that same address (docs/email.md, "Mail to yourself";
 * docs/notifications.md).
 *
 * The one send in this plugin with no approval card, and the reason it may
 * have none is one rule, enforced here and nowhere else: **the recipient is
 * always and only the account's own address.** `selfEnvelope` builds the
 * envelope from the account row alone — nothing in the message (title, text,
 * link) reaches `from`, `to`, `cc` or `bcc` — and `assertOwnAddressOnly`
 * checks the built envelope again right before it goes on the wire. Anything
 * that must reach another address is `email.send`, with its card.
 *
 * At most one mail a minute: a busy hour must not fill the owner's inbox.
 * More are refused with a sentence, which core keeps on the notification.
 */
import type { BuddiHost, PluginChannel, PluginChannelMessage } from '@buddi/core/plugin';
import { listAccounts, type EnvLike } from './config.js';
import { mailboxAuth } from './credentials.js';
import { mailboxKey } from './mail.js';
import type { AccountRecord, SmtpClientFactory, SmtpEnvelope } from './ports.js';

/** The channel's kind in Settings → Notifications. */
export const SELF_CHANNEL_KIND = 'email.self';

/** One mail per this many milliseconds, at most. */
export const SELF_MAIL_EVERY_MS = 60_000;

/** The sentence under an offer, which mail cannot carry as a button. */
export const OFFERS_LINE = 'Reply on the dashboard to act.';

export interface SelfChannelOptions {
  /** How an SMTP client is made: the same factory `email.send` uses. */
  send: SmtpClientFactory;
  /** Passwords by name, instead of the owner's secrets (tests, one-shot callers). */
  env?: EnvLike;
}

/** The account notifications leave from and go to: the first enabled one. */
async function selfAccount(buddi: BuddiHost): Promise<AccountRecord | null> {
  const accounts = await listAccounts(buddi.db);
  return accounts[0] ?? null;
}

/** The body: the text, the link when it is one the owner can open anywhere, the offers as lines. */
export function selfBody(message: PluginChannelMessage): string {
  const parts: string[] = [];
  const text = message.text?.trim();
  parts.push(text ? text : message.title);
  if (message.link?.url) parts.push(message.link.url);
  if (message.offers && message.offers.length > 0) {
    parts.push([...message.offers.map((o) => `- ${o.label}`), OFFERS_LINE].join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/** A subject is one line. */
function subjectOf(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return `buddi: ${line.length > 180 ? `${line.slice(0, 179)}…` : line}`;
}

/**
 * The envelope, from the account row and nothing else: from and to are the
 * account's own address; no cc, no bcc, no threading.
 */
export function selfEnvelope(account: AccountRecord, message: PluginChannelMessage): SmtpEnvelope {
  return {
    from: account.address,
    to: [account.address],
    cc: [],
    bcc: [],
    subject: subjectOf(message.title),
    text: selfBody(message),
    inReplyTo: null,
    references: [],
  };
}

/** The own-address rule, checked on the envelope that is about to be sent. Throws when broken. */
export function assertOwnAddressOnly(account: AccountRecord, envelope: SmtpEnvelope): void {
  const own = mailboxKey(account.address);
  const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc];
  if (
    recipients.length !== 1 ||
    envelope.to.length !== 1 ||
    mailboxKey(envelope.to[0] as string) !== own ||
    mailboxKey(envelope.from) !== own
  ) {
    throw new Error('mail to yourself goes to the account\'s own address and nowhere else');
  }
}

/** The channel. Registered from the manifest's `register` hook. */
export function createSelfChannel(opts: SelfChannelOptions): PluginChannel {
  let lastSentAt: number | null = null;
  return {
    kind: SELF_CHANNEL_KIND,
    can: { offers: false, attachments: false, markdown: false },
    async describe(buddi) {
      const account = await selfAccount(buddi);
      return account ? { label: 'Mail to yourself', where: account.address } : null;
    },
    async deliver(message, buddi) {
      const account = await selfAccount(buddi);
      if (!account) return { refused: 'There is no mail account to send from.' };
      const now = buddi.clock.now().getTime();
      if (lastSentAt !== null && now - lastSentAt < SELF_MAIL_EVERY_MS) {
        return { refused: 'One mail to yourself a minute at most; this one was not sent.' };
      }
      const auth = await mailboxAuth({ buddi }, account, opts.env);
      if (!auth.ok) return { refused: `Mail to ${account.address} was not sent: ${auth.problem.message}` };
      const envelope = selfEnvelope(account, message);
      assertOwnAddressOnly(account, envelope);
      let client: Awaited<ReturnType<SmtpClientFactory>> | undefined;
      try {
        client = await opts.send(account, auth.value);
        const result = await client.send(envelope);
        lastSentAt = now;
        return { id: result.messageId || account.address };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { refused: `Mail to ${account.address} was not sent: ${why}` };
      } finally {
        await client?.close().catch(() => {});
      }
    },
  };
}
