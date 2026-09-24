/**
 * Adding and removing a mailbox — the owner's own hands, and nobody else's.
 *
 * These two were routes under `/api/email/accounts` (docs/specs/email.md §2)
 * and are now `ownerOnly` tools, which is what a page's write is: the registry
 * never lists them to a model, and `invoke` refuses them for anyone but the
 * owner's own path. Nothing else changed — the same three steps happen in the
 * same order, and the order is the whole design:
 *
 *  1. **The login is tested, once, before anything is kept.** An address, a
 *     host and a password that IMAP refuses is not an account — it is a typo,
 *     and the owner finds out now rather than at the next poll, from a log line
 *     they will never read.
 *  2. **The row is written**, carrying the secret's name and nothing else:
 *     a name derived from the address, so it is the same on the page, in the
 *     row and in Settings. A name another row already owns is refused before
 *     anything is written: that name holds someone's password.
 *  3. **The password becomes an owner secret** under that name, bound to this
 *     mailbox's login (`email.account`, the row's id) and kept in the vault by
 *     core (`ctx.buddi.secrets.put`). This plugin never opens the vault.
 *
 * Removing an account undoes both halves. A password left behind in the
 * keychain after the mailbox it opened was removed is a secret nobody is
 * responsible for any more.
 *
 * One thing the page can no longer do, and this file does instead: the old form
 * filled the IMAP and SMTP hosts in from the domain as the address was typed.
 * A page descriptor has no such logic (`docs/specs/plugin-pages.md` §4), so the
 * hosts are *optional* here and `hostsFor` fills them in when they are left
 * empty — the convention the form used, in the one place that can still apply it.
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { INBOX, secretNameFor } from '../config.js';
import { ACCOUNT_KIND } from '../credentials.js';
import { ACCOUNT_COLUMNS, toAccount } from '../rows.js';
import type { AccountRecord, ImapClientFactory } from '../ports.js';

/** One provider's endpoints. Implicit or STARTTLS on the ports named here. */
export interface MailHosts {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/**
 * What the common providers' hosts are, by the domain of the address.
 *
 * A default, never a constraint: every field is still on the form, and a
 * provider that is not here falls back to the `imap.`/`smtp.` convention its
 * own domain almost certainly follows. Getting this right for Gmail alone
 * removes the one step of this form that sends people to a search engine.
 */
export const KNOWN_HOSTS: Record<string, MailHosts> = {
  'gmail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'googlemail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'live.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'yahoo.com': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  'icloud.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'me.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'fastmail.com': { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465 },
};

/** The hosts to use for an address, known provider or not. Null before an @. */
export function hostsFor(address: string): MailHosts | null {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  if (domain === '' || !domain.includes('.')) return null;
  return (
    KNOWN_HOSTS[domain] ?? {
      imapHost: `imap.${domain}`,
      imapPort: 993,
      smtpHost: `smtp.${domain}`,
      smtpPort: 465,
    }
  );
}

/** A refusal the owner reads on the page, in their own words. */
export class AccountRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountRefusal';
  }
}

export interface AccountToolOptions {
  /** How the login is tested. Injected by tests; the real IMAP client otherwise. */
  connect: ImapClientFactory;
}

const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function address(value: string, what: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!ADDRESS.test(trimmed)) throw new AccountRefusal(`${what} does not look like an email address.`);
  return trimmed;
}

function host(value: string | undefined, fallback: string, what: string): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (trimmed === '') {
    if (fallback === '') throw new AccountRefusal(`${what} is missing.`);
    return fallback;
  }
  if (/\s/.test(trimmed)) throw new AccountRefusal(`${what} is missing.`);
  return trimmed;
}

function port(value: number | undefined, fallback: number, what: string): number {
  const n = value === undefined || Number.isNaN(value) ? fallback : value;
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new AccountRefusal(`${what} must be a port number between 1 and 65535.`);
  }
  return n;
}

const addInput = z
  .object({
    address: z.string().min(1),
    password: z.string().min(1),
    displayName: z.string().optional(),
    aliases: z.string().optional(),
    imapHost: z.string().optional(),
    imapPort: z.coerce.number().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.coerce.number().optional(),
  })
  .strict();

export type AddAccountInput = z.infer<typeof addInput>;

/** The form, checked into a shape the rest of this file can trust. */
export function readNewAccount(input: AddAccountInput): {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  password: string;
  displayName: string | null;
  aliases: string[];
} {
  const password = input.password.trim();
  if (password === '') throw new AccountRefusal('The password for this mailbox is missing.');
  const at = address(input.address, 'That address');
  const guess = hostsFor(at);
  const aliases = (input.aliases ?? '')
    .split(/[,;\s]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '')
    .map((alias, i) => address(alias, `Alias ${i + 1}`));
  const displayName =
    input.displayName && input.displayName.trim() !== '' ? input.displayName.trim().slice(0, 120) : null;
  return {
    address: at,
    imapHost: host(input.imapHost, guess?.imapHost ?? '', 'The IMAP host'),
    imapPort: port(input.imapPort, guess?.imapPort ?? 993, 'The IMAP port'),
    smtpHost: host(input.smtpHost, guess?.smtpHost ?? '', 'The SMTP host'),
    smtpPort: port(input.smtpPort, guess?.smtpPort ?? 465, 'The SMTP port'),
    password,
    displayName,
    aliases: [...new Set(aliases)],
  };
}

/**
 * Does this mailbox actually open?
 *
 * One connection, one SELECT, closed again. A failure is the owner's to fix and
 * is answered in their words, not the server's — with the host's own reason
 * appended, because "could not connect" on its own is the kind of answer that
 * sends someone to a log file.
 */
export async function testLogin(
  connect: ImapClientFactory,
  account: ReturnType<typeof readNewAccount>,
): Promise<void> {
  const candidate: AccountRecord = {
    id: '',
    address: account.address,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    authMode: 'app-password',
    secretName: secretNameFor(account.address),
    aliases: account.aliases,
    displayName: account.displayName,
    enabled: true,
    addedVia: 'page',
    foldersDiscoveredAt: null,
    createdAt: null,
  };
  let client: Awaited<ReturnType<ImapClientFactory>> | null = null;
  try {
    client = await connect(candidate, { mode: 'app-password', user: account.address, pass: account.password });
    await client.open(INBOX);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AccountRefusal(
      `${account.imapHost} would not let us in as ${account.address}. Check the address and the app password — many providers need an app password rather than the one you type into their website. (${reason})`,
    );
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Add a mailbox: test it, keep the password, write the row.
 *
 * `ownerOnly`, and the first tool that ever was: it is handed a secret, and no
 * model is ever shown a tool that takes one.
 */
export function createAddAccountTool(opts: AccountToolOptions): ToolDefinition<AddAccountInput, unknown> {
  return {
    name: 'email.add_account',
    description:
      "Add one of the owner's mailboxes: its address, its app password, and the hosts its mail lives on. The password is kept as one of the owner's secrets, in this machine's vault and never in the database.",
    tier: 'auto',
    ownerOnly: true,
    input: addInput,
    async execute(input, ctx) {
      const account = readNewAccount(input);

      const { rows: existing } = await ctx.buddi!.db.query(`select 1 from email.accounts where address = $1`, [
        account.address,
      ]);
      if (existing.length > 0) {
        throw new AccountRefusal(
          `${account.address} is already here. Remove it first if you want to change its password.`,
        );
      }

      await testLogin(opts.connect, account);

      const secrets = ctx.buddi!.secrets;
      if (!secrets) throw new AccountRefusal('This installation has nowhere safe to keep the password.');
      const secretName = secretNameFor(account.address);

      /*
       * Nobody else's secret, checked before anything is written. The name
       * carries a hash of the address, so two mailboxes cannot collide by
       * accident — but "cannot by accident" is not "cannot", and what is at
       * stake is another account's password.
       */
      const { rows: owner } = await ctx.buddi!.db.query<{ address: string }>(
        `select address from email.accounts where secret_name = $1`,
        [secretName],
      );
      if (owner.length > 0) {
        throw new AccountRefusal(
          `The keychain entry ${secretName} already belongs to ${owner[0]!.address}. Remove that account first — nothing was changed.`,
        );
      }

      let written: AccountRecord;
      try {
        const { rows } = await ctx.buddi!.db.query(
          `insert into email.accounts
             (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name,
              aliases, display_name, enabled, added_via)
           values ($1, $2, $3, $4, $5, 'app-password', $6, $7::text[], $8, true, 'page')
           returning ${ACCOUNT_COLUMNS}`,
          [
            account.address,
            account.imapHost,
            account.imapPort,
            account.smtpHost,
            account.smtpPort,
            secretName,
            account.aliases,
            account.displayName,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('the account row was not written');
        written = toAccount(row);
      } catch (error) {
        throw new AccountRefusal(
          `${account.address} opened, but the account could not be written down: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      /*
       * The password, as an owner secret bound to this mailbox's login
       * (email.account, its id), pre-approved because the owner typed it here.
       * The row first, because the binding names its id; a password that
       * cannot be kept takes the row back out.
       */
      try {
        await secrets.put(secretName, account.password, [
          { kind: ACCOUNT_KIND, target: written.id, rule: 'pre-approved' },
        ]);
      } catch {
        await ctx.buddi!.db.query(`delete from email.accounts where id = $1`, [written.id]).catch(() => {});
        throw new AccountRefusal('The password could not be kept safely. Unlock this machine and try again.');
      }
      return {
        added: true,
        address: written.address,
        note: `${written.address} is set up. buddi will read it from the next poll.`,
      };
    },
  };
}

const removeInput = z.object({ id: z.string().uuid() }).strict();

/**
 * Remove a mailbox and the password it used.
 *
 * The row goes first: the mail, the drafts and the cursor go with it by
 * cascade. Then the owner secret, which is only removed when it is *this*
 * account's — the env-seeded account shares its secret with the variable that
 * named it, and deleting that from under `.env` would be a surprise.
 */
export function createRemoveAccountTool(
  opts: AccountToolOptions,
): ToolDefinition<z.infer<typeof removeInput>, unknown> {
  return {
    name: 'email.remove_account',
    description:
      "Remove one of the owner's mailboxes, its mail and its drafts, and the password it used from the owner's secrets. The mailbox itself is untouched.",
    tier: 'auto',
    ownerOnly: true,
    input: removeInput,
    async execute(input, ctx) {
      const { rows } = await ctx.buddi!.db.query(
        `delete from email.accounts where id = $1::uuid returning ${ACCOUNT_COLUMNS}`,
        [input.id],
      );
      const row = rows[0];
      if (!row) throw new AccountRefusal('That mailbox is no longer here.');
      const account = toAccount(row);

      let secretRemoved = false;
      if (account.addedVia === 'page' && account.secretName === secretNameFor(account.address)) {
        secretRemoved = (await ctx.buddi!.secrets?.delete(account.secretName).catch(() => false)) ?? false;
      }
      return {
        removed: true,
        address: account.address,
        secretRemoved,
        note: secretRemoved
          ? `${account.address} is gone, and its password with it.`
          : `${account.address} is gone. Its password came from the environment and was left alone.`,
      };
    },
  };
}
