/**
 * Adding and removing a mailbox — the owner's own hands, and nobody else's.
 *
 * These two were routes under `/api/email/accounts` (docs/email.md §2)
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
 * A page descriptor has no such logic (`docs/plugin-pages.md` §4), so the
 * hosts are *optional* here and `hostsFor` fills them in when they are left
 * empty — the convention the form used, in the one place that can still apply it.
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { TRIAGE_OFFER_TEXT } from '../agent.js';
import { INBOX, secretNameFor } from '../config.js';
import { ACCOUNT_KIND, mailboxAuth } from '../credentials.js';
import { ACCOUNT_COLUMNS, toAccount } from '../rows.js';
import type { EnvLike } from '../config.js';
import { clearLoginFailure } from '../logins.js';
import type { AccountRecord, ImapClientFactory } from '../ports.js';
import { TRIAGE_AGENT_ID } from '../sources/inbox-poll.js';
import { accountChanged } from '../sources/idle.js';

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
  /** Passwords by name, for tests and one-shot callers (the Mail page's Undo opens the mailbox). */
  env?: EnvLike;
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
  /** The sentence for a refusal, given the server's reason. The add flow's own by default. */
  refused?: (reason: string) => string,
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
    if (refused) throw new AccountRefusal(refused(reason));
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

      const { rows: existing } = await ctx.buddi!.db.query<{ id: string; added_via: string }>(
        `select id::text as id, added_via from email.accounts where address = $1`,
        [account.address],
      );
      /*
       * A row the old `.env` seed left, which the start could not adopt
       * because its password was not readable, is claimed rather than refused:
       * adding it here writes the same row (same id), so the mail, the
       * cursors and the triage it already has stay its own.
       */
      const claim = existing[0]?.added_via === 'env' ? existing[0].id : null;
      if (existing.length > 0 && claim === null) {
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
        const { rows } = claim !== null
          ? await ctx.buddi!.db.query(
            `update email.accounts
                set imap_host = $2, imap_port = $3, smtp_host = $4, smtp_port = $5,
                    auth_mode = 'app-password', secret_name = $6, aliases = $7::text[],
                    display_name = $8, enabled = true, added_via = 'page'
              where id = $1::uuid and added_via = 'env'
              returning ${ACCOUNT_COLUMNS}`,
            [
              claim,
              account.imapHost,
              account.imapPort,
              account.smtpHost,
              account.smtpPort,
              secretName,
              account.aliases,
              account.displayName,
            ],
          )
          : await ctx.buddi!.db.query(
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
        // Undone the way it was done: a claimed row goes back to what the seed
        // left, so its mail is not lost with a password that was not kept.
        await (claim !== null
          ? ctx.buddi!.db.query(
            `update email.accounts set secret_name = 'GMAIL_APP_PASSWORD', added_via = 'env' where id = $1`,
            [written.id],
          )
          : ctx.buddi!.db.query(`delete from email.accounts where id = $1`, [written.id])
        ).catch(() => {});
        throw new AccountRefusal('The password could not be kept safely. Unlock this machine and try again.');
      }
      /*
       * The poll hands every new message to the triage agent, and a mailbox
       * saved before that agent exists is mail with nobody to read it. Said
       * here, in the answer the page shows, and offered on the same page.
       */
      const triageMissing = !ctx.buddi!.owner.hasAgent(TRIAGE_AGENT_ID);
      // The IDLE watchers pick the new mailbox up now, not at the next poll.
      accountChanged();
      return {
        added: true,
        address: written.address,
        note: triageMissing
          ? `${written.address} is set up. buddi will read it from the next poll. ${TRIAGE_OFFER_TEXT} Create @mail on this page and new mail gets triaged.`
          : `${written.address} is set up. buddi will read it from the next poll.`,
        ...(triageMissing ? { triage: 'needs-agent' as const } : {}),
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
 * account's — a row the old `.env` seed left names a secret it never owned.
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
      // Its IDLE connection closes now.
      accountChanged();
      return {
        removed: true,
        address: account.address,
        secretRemoved,
        note: secretRemoved
          ? `${account.address} is gone, and its password with it.`
          : `${account.address} is gone. It had no password of its own to remove.`,
      };
    },
  };
}

const setPasswordInput = z.object({ id: z.string().uuid(), password: z.string().min(1) }).strict();

/** The server's reason, with the password it was given taken out should it ever echo it. */
function reasonWithout(reason: string, password: string): string {
  const said = reason.split(password).join('‹password›').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return said === '' ? 'no reason given' : said;
}

/**
 * Give a mailbox a new password, keeping everything else it has.
 *
 * What a restore on a new machine, or an app password the owner changed at
 * their provider, needs: the row, its mail and its cursors stay; only the
 * secret behind it changes. The same order as adding one, for the same
 * reason — **the login is tested first**, against the host settings the
 * mailbox already has, and nothing is written when it fails: the old
 * password, readable or not, stays exactly where it was.
 *
 * On success the password is the owner secret named by `secretNameFor`, bound
 * to this mailbox's login, as `email.add_account` keeps it. A mailbox the
 * old `.env` seed left (named `GMAIL_APP_PASSWORD`, never this plugin's to
 * change) is moved onto its own secret in the same step. Then the secret is
 * used once, as the poll would use it: that proves it reads back, and the
 * record of that use is what the page's "Password needed" was drawn from,
 * so the state clears now rather than at the next poll.
 *
 * `ownerOnly`: it is handed a secret. It never logs or returns it.
 */
export function createSetPasswordTool(
  opts: AccountToolOptions,
): ToolDefinition<z.infer<typeof setPasswordInput>, unknown> {
  return {
    name: 'email.set_password',
    description:
      "Give one of the owner's mailboxes a new app password. The login is tested against the mailbox's own hosts first; the old password is kept when it fails.",
    tier: 'auto',
    ownerOnly: true,
    input: setPasswordInput,
    async execute(input, ctx) {
      const password = input.password.trim();
      if (password === '') throw new AccountRefusal('The password for this mailbox is missing.');
      const { rows } = await ctx.buddi!.db.query(
        `select ${ACCOUNT_COLUMNS} from email.accounts where id = $1::uuid`,
        [input.id],
      );
      const row = rows[0];
      if (!row) throw new AccountRefusal('That mailbox is no longer here.');
      const account = toAccount(row);
      if (account.authMode !== 'app-password') {
        throw new AccountRefusal(`${account.address} signs in another way; it has no app password to set.`);
      }

      await testLogin(
        opts.connect,
        {
          address: account.address,
          imapHost: account.imapHost,
          imapPort: account.imapPort,
          smtpHost: account.smtpHost,
          smtpPort: account.smtpPort,
          password,
          displayName: account.displayName,
          aliases: account.aliases,
        },
        (reason) =>
          `${account.imapHost} refused that password for ${account.address} (${reasonWithout(reason, password)}), so the old one is kept.`,
      );

      const secrets = ctx.buddi!.secrets;
      if (!secrets) throw new AccountRefusal('This installation has nowhere safe to keep the password.');
      const secretName = secretNameFor(account.address);
      const { rows: owner } = await ctx.buddi!.db.query<{ address: string }>(
        `select address from email.accounts where secret_name = $1 and id <> $2::uuid`,
        [secretName, account.id],
      );
      if (owner.length > 0) {
        throw new AccountRefusal(
          `The keychain entry ${secretName} already belongs to ${owner[0]!.address}, so nothing was changed.`,
        );
      }
      try {
        await secrets.put(secretName, password, [{ kind: ACCOUNT_KIND, target: account.id, rule: 'pre-approved' }]);
      } catch {
        throw new AccountRefusal('The password could not be kept safely, so the old one is kept. Unlock this machine and try again.');
      }
      let current = account;
      if (account.secretName !== secretName || account.addedVia !== 'page') {
        const { rows: moved } = await ctx.buddi!.db.query(
          `update email.accounts set secret_name = $2, added_via = 'page' where id = $1::uuid returning ${ACCOUNT_COLUMNS}`,
          [account.id, secretName],
        );
        if (moved[0]) current = toAccount(moved[0]);
      }
      // The server took this password a moment ago: whatever refusal the
      // poll recorded is over.
      await clearLoginFailure(ctx.buddi!.db, current.id);
      // IDLE reconnects with the new password (and stops waiting on a refusal).
      accountChanged({ accountId: current.id, password: true });
      // One use, as the poll makes it: the value is taken and dropped here.
      const check = await mailboxAuth(ctx, current);
      return {
        saved: true,
        address: current.address,
        note: check.ok
          ? `${current.address} opens with the new password. buddi reads it from the next poll.`
          : `${current.address} opens with the new password, but buddi could not read it back yet: ${check.problem.message}`,
      };
    },
  };
}
