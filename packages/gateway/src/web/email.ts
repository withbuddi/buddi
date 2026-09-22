/**
 * Settings → Email, over HTTP: the mailboxes, and the standing decisions.
 *
 * Two route sets live here because they are one section of one page, and the
 * page reads them together. They share nothing but that — the accounts half
 * writes secrets to the vault and rows to `email.accounts`, the policies half
 * translates JSON into the email plugin's own policy functions — so they are
 * kept apart below, in that order, the way the page stacks them.
 *
 * ## Accounts (docs/email.md §2)
 *
 * "Secrets live in the vault, one name per account, entered on the settings
 * page, never in `.env`." This is that route, and it is shaped exactly like the
 * Telegram token one next door — the owner acting on their own installation,
 * behind the same session, Origin and CSRF gate, with the secret going to the
 * machine's vault and the *name* of it going to the database.
 *
 * Three things happen on the way in, in this order, and the order is the whole
 * design:
 *
 *  1. **The login is tested, once, before anything is kept.** An address, a
 *     host and a password that IMAP refuses is not an account — it is a typo,
 *     and the owner finds out now rather than at the next poll, from a log line
 *     they will never read. The test goes through the plugin's own client
 *     factory, so it is the same code path the source uses and a test injects a
 *     fake instead of dialling out.
 *  2. **The password goes to the vault**, under
 *     `EMAIL_<sanitised address>_<8 hex of its hash>` — derived from the
 *     address rather than chosen, so the name is the same on the page, in the
 *     row, in the keychain and in `buddi doctor`, and distinct for two
 *     addresses that sanitise alike. A name another row already owns is
 *     refused before the vault is touched: that name holds someone's password.
 *  3. **The row is written**, carrying that name and nothing else. Nothing in
 *     the email schema ever holds a credential.
 *
 * Removing an account undoes both halves: the row and the vault entry. A
 * password left behind in the keychain after the mailbox it opened was removed
 * is a secret nobody is responsible for any more.
 *
 * ## Policies (docs/email.md §5)
 *
 * Three routes and nothing clever: read the two lists, write or keep one rule,
 * take one back. The rules themselves live in the email plugin — this file
 * translates between the dashboard's JSON and that plugin's functions, and owes
 * the page one thing the tools do not: the *owner* is the one acting here, so
 * there is no approval card in the way. The gate on the tool exists because a
 * model proposed it; the owner tapping "Revoke" on their own settings page has
 * already said what they want.
 *
 * Every policy reply is shaped the same — `{ applied, proposed }` — so the page
 * reloads from whatever the last call returned instead of asking again.
 *
 * One rule the route enforces that the JSON cannot: **a policy says which
 * mailbox it is about.** Either an `accountId` that resolves to a row, or
 * `allAccounts: true` — the form's "for every mailbox" checkbox. An omitted
 * account used to mean "all of them", which is a decision nobody made.
 */
import { createVault, type Vault } from '@buddi/core';
import {
  ACCOUNT_COLUMNS,
  INBOX,
  createPolicy,
  keepPolicy,
  lastSyncByAccount,
  listAccounts,
  normalizeAddress,
  policiesView,
  refusalFor,
  revokePolicy,
  secretNameFor,
  toAccount,
  imapflowFactory,
  PolicyRefusal,
  POLICY_ACTIONS,
  POLICY_SCOPES,
  type AccountRecord,
  type ImapClientFactory,
  type PolicyAction,
  type PolicyParams,
  type PolicyScope,
  type PolicyView,
} from '@buddi/tool-email';
import type { Pool } from 'pg';

export interface EmailWebDeps {
  pool: Pool;
  env: NodeJS.ProcessEnv;
  /** Injected by tests; the machine's own vault otherwise. */
  vault?: Vault | undefined;
  /** How the login is tested. Injected by tests; the real IMAP client otherwise. */
  connect?: ImapClientFactory | undefined;
}

export class EmailWebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EmailWebError';
  }
}

/** One account as the page shows it. Never the secret — only its name. */
export interface EmailAccountView {
  id: string;
  address: string;
  displayName: string | null;
  aliases: string[];
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The vault entry that holds this account's password. A name, not a value. */
  secretName: string;
  enabled: boolean;
  /** 'env' is the GMAIL_USER seed; 'page' is one added here. */
  addedVia: 'env' | 'page';
  /** When mail last landed for this account, or null if none ever has. */
  lastSyncAt: string | null;
}

function view(account: AccountRecord, lastSyncAt: string | null): EmailAccountView {
  return {
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    aliases: account.aliases,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    secretName: account.secretName,
    enabled: account.enabled,
    addedVia: account.addedVia,
    lastSyncAt,
  };
}

export interface EmailAccountsView {
  accounts: EmailAccountView[];
}

/** Every account, disabled ones included: a row you cannot see cannot be fixed. */
export async function listEmailAccounts(deps: EmailWebDeps): Promise<EmailAccountsView> {
  const accounts = await listAccounts(deps.pool, { enabledOnly: false });
  const synced = await lastSyncByAccount(deps.pool);
  return { accounts: accounts.map((account) => view(account, synced.get(account.id) ?? null)) };
}

/** What the page sends. Everything but `password` also comes back out again. */
export interface NewEmailAccount {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  password: string;
  displayName?: string | null;
  aliases?: string[];
}

const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function address(value: unknown, what: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ADDRESS.test(trimmed)) throw new EmailWebError(400, `${what} does not look like an email address.`);
  return trimmed;
}

function host(value: unknown, what: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (trimmed === '' || /\s/.test(trimmed)) throw new EmailWebError(400, `${what} is missing.`);
  return trimmed;
}

function port(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new EmailWebError(400, `${what} must be a port number between 1 and 65535.`);
  }
  return n;
}

/** The body, checked into a shape the rest of this file can trust. */
export function readNewAccount(body: Record<string, unknown>): NewEmailAccount {
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (password === '') throw new EmailWebError(400, 'The password for this mailbox is missing.');
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.map((alias, i) => address(alias, `Alias ${i + 1}`))
    : [];
  const displayName = typeof body.displayName === 'string' && body.displayName.trim() !== ''
    ? body.displayName.trim().slice(0, 120)
    : null;
  return {
    address: address(body.address, 'That address'),
    imapHost: host(body.imapHost, 'The IMAP host'),
    imapPort: port(body.imapPort, 'The IMAP port'),
    smtpHost: host(body.smtpHost, 'The SMTP host'),
    smtpPort: port(body.smtpPort, 'The SMTP port'),
    password,
    displayName,
    aliases: [...new Set(aliases)],
  };
}

/**
 * Does this mailbox actually open?
 *
 * One connection, one SELECT, closed again. A failure is the owner's to fix and
 * is answered in their words, not the server's: "the server refused these
 * credentials" rather than an IMAP response line nobody outside a mail client
 * has ever read. The underlying message is appended when there is one, because
 * "could not connect" without the host's own reason is the kind of answer that
 * sends someone to a log file.
 */
export async function testLogin(deps: EmailWebDeps, account: NewEmailAccount): Promise<void> {
  const connect = deps.connect ?? imapflowFactory;
  const candidate: AccountRecord = {
    id: '',
    address: account.address,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    authMode: 'app-password',
    secretName: secretNameFor(account.address),
    aliases: account.aliases ?? [],
    displayName: account.displayName ?? null,
    enabled: true,
    addedVia: 'page',
    createdAt: null,
  };
  let client: Awaited<ReturnType<ImapClientFactory>> | null = null;
  try {
    client = await connect(candidate, { mode: 'app-password', user: account.address, pass: account.password });
    await client.open(INBOX);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EmailWebError(
      400,
      `${account.imapHost} would not let us in as ${account.address}. Check the address and the app password — many providers need an app password rather than the one you type into their website. (${reason})`,
    );
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Test, keep the password, write the row.
 *
 * The vault entry is written before the row and removed again if the insert
 * fails, so the two never disagree: a secret with no account is a password
 * nobody owns, and an account with no secret is a mailbox that cannot open.
 */
export async function addEmailAccount(
  deps: EmailWebDeps,
  body: Record<string, unknown>,
): Promise<EmailAccountView> {
  const account = readNewAccount(body);

  const { rows: existing } = await deps.pool.query(
    `select 1 from email.accounts where address = $1`,
    [account.address],
  );
  if (existing.length > 0) {
    throw new EmailWebError(409, `${account.address} is already here. Remove it first if you want to change its password.`);
  }

  await testLogin(deps, account);

  const vault = deps.vault ?? createVault({ env: deps.env });
  if (!vault) throw new EmailWebError(409, 'This installation has nowhere safe to keep the password.');
  const secretName = secretNameFor(account.address);

  /*
   * Nobody else's secret, checked before the vault is touched at all.
   *
   * The name is derived from the address and carries a hash of it, so two
   * mailboxes cannot collide by accident any more — but "cannot by accident" is
   * not "cannot", and what is at stake is another account's password: a
   * `vault.set` under a name a different row owns overwrites it, and the
   * cleanup below would then delete it. So the row is looked for first, and the
   * refusal happens while nothing has been written.
   */
  const { rows: owner } = await deps.pool.query<{ address: string }>(
    `select address from email.accounts where secret_name = $1`,
    [secretName],
  );
  if (owner.length > 0) {
    throw new EmailWebError(
      409,
      `The keychain entry ${secretName} already belongs to ${owner[0]!.address}. Remove that account first — nothing was changed.`,
    );
  }

  try {
    await vault.set(secretName, account.password);
  } catch {
    throw new EmailWebError(409, 'The password could not be kept safely. Unlock this machine and try again.');
  }
  // Into this process's environment too, so the next poll finds it without a
  // restart. Startup reads the same name back out of the vault.
  deps.env[secretName] = account.password;

  try {
    const { rows } = await deps.pool.query(
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
        account.aliases ?? [],
        account.displayName,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('the account row was not written');
    return view(toAccount(row), null);
  } catch (error) {
    await vault.delete(secretName).catch(() => {});
    delete deps.env[secretName];
    throw new EmailWebError(
      500,
      `${account.address} opened, but the account could not be written down: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface RemovedEmailAccount {
  removed: boolean;
  address: string | null;
  /** True when the vault entry went with it. */
  secretRemoved: boolean;
}

/**
 * Remove an account and the password it used.
 *
 * The row goes first: the mail, the drafts and the cursor go with it by
 * cascade, and the draft rows keep their history with a null account. Then the
 * vault entry, which is only removed when it is *this* account's — the
 * env-seeded account shares `GMAIL_APP_PASSWORD` with the variable that named
 * it, and deleting that from under `.env` would be a surprise.
 */
export async function removeEmailAccount(
  deps: EmailWebDeps,
  id: string,
): Promise<RemovedEmailAccount> {
  const { rows } = await deps.pool.query(
    `delete from email.accounts where id = $1 returning ${ACCOUNT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  if (!row) return { removed: false, address: null, secretRemoved: false };
  const account = toAccount(row);

  let secretRemoved = false;
  if (account.addedVia === 'page' && account.secretName === secretNameFor(account.address)) {
    const vault = deps.vault ?? createVault({ env: deps.env });
    secretRemoved = (await vault?.delete(account.secretName).catch(() => false)) ?? false;
    delete deps.env[account.secretName];
  }
  return { removed: true, address: account.address, secretRemoved };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
export interface EmailPoliciesView {
  applied: PolicyView[];
  proposed: PolicyView[];
}

export interface RouteReply {
  status: number;
  body: unknown;
}

export async function readEmailPolicies(pool: Pool): Promise<RouteReply> {
  try {
    return { status: 200, body: await policiesView(pool) };
  } catch (err) {
    // The email plugin may not be installed, or its migrations may not have
    // run. That is not an error the owner can act on from this page, so it
    // reads as "no policies" rather than as a broken section.
    return {
      status: 200,
      body: { applied: [], proposed: [], unavailable: message(err) } satisfies Record<string, unknown>,
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isScope(value: unknown): value is PolicyScope {
  return typeof value === 'string' && (POLICY_SCOPES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is PolicyAction {
  return typeof value === 'string' && (POLICY_ACTIONS as readonly string[]).includes(value);
}

/**
 * POST: keep a proposal, or write a new rule.
 *
 * "Keep" is the same route because it is the same act from the page's side —
 * the owner deciding this rule is on — and one route means one reload.
 */
export async function writeEmailPolicy(
  pool: Pool,
  body: unknown,
  now: Date,
): Promise<RouteReply> {
  const input = (body ?? {}) as Record<string, unknown>;

  if (typeof input.keep === 'string' && input.keep.trim() !== '') {
    const kept = await keepPolicy(pool, input.keep.trim());
    if (!kept) return { status: 404, body: { error: 'That policy is no longer there.' } };
    return { status: 200, body: await policiesView(pool) };
  }

  if (!isScope(input.scope)) {
    return { status: 400, body: { error: `\`scope\` must be one of ${POLICY_SCOPES.join(', ')}` } };
  }
  if (!isAction(input.action)) {
    return { status: 400, body: { error: `\`action\` must be one of ${POLICY_ACTIONS.join(', ')}` } };
  }
  const matcher = typeof input.matcher === 'string' ? input.matcher : '';

  const params: PolicyParams = {};
  if (typeof input.agentId === 'string' && input.agentId.trim()) params.agentId = input.agentId.trim();
  if (typeof input.instruction === 'string' && input.instruction.trim()) params.instruction = input.instruction.trim();
  if (typeof input.note === 'string' && input.note.trim()) params.note = input.note.trim();
  if (typeof input.label === 'string' && input.label.trim()) params.label = input.label.trim();
  if (input.action === 'ignore') {
    params.category = 'promo';
    params.urgency = 'low';
  }
  // A thread or a list is named by a header its sender writes, so an `ignore`
  // on one silences only the address recorded with it (`gate.ts`).
  if (typeof input.sender === 'string' && input.sender.trim() &&
      (input.scope === 'thread' || input.scope === 'list-id')) {
    params.sender = normalizeAddress(input.sender);
  }

  const refusal = refusalFor({ scope: input.scope, matcher, action: input.action, params });
  if (refusal) return { status: 400, body: { error: refusal } };

  /*
   * Which mailbox, said out loud or not at all.
   *
   * A policy with no account applies to *every* account on this installation
   * (`gate.ts`), and the same sender is worth different things in different
   * inboxes — so "the owner left the field empty" must never be the way an
   * installation-wide rule gets written. The route takes either an `accountId`
   * that resolves to a row here, or `allAccounts: true`, which is a checkbox on
   * the form ("for every mailbox") and therefore a choice somebody made.
   */
  const allAccounts = input.allAccounts === true;
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';
  if (allAccounts && accountId !== '') {
    return {
      status: 400,
      body: { error: 'Choose one mailbox, or "for every mailbox" — not both.' },
    };
  }
  if (!allAccounts) {
    if (accountId === '') {
      return {
        status: 400,
        body: {
          error:
            'Say which mailbox this rule is for, or tick "for every mailbox". The same sender can matter in one inbox and not in another.',
        },
      };
    }
    const { rows } = await pool.query(`select 1 from email.accounts where id = $1::uuid`, [
      accountId,
    ]).catch(() => ({ rows: [] as unknown[] }));
    if (rows.length === 0) {
      return { status: 400, body: { error: 'That mailbox is not one of yours.' } };
    }
  }


  try {
    await createPolicy(
      pool,
      {
        accountId: allAccounts ? null : accountId,
        scope: input.scope,
        matcher,
        action: input.action,
        params,
        origin: 'owner',
      },
      now,
    );
  } catch (err) {
    if (err instanceof PolicyRefusal) return { status: 400, body: { error: err.message } };
    throw err;
  }
  return { status: 200, body: await policiesView(pool) };
}

/** DELETE: take one back. Revoking something already revoked is still 200. */
export async function deleteEmailPolicy(
  pool: Pool,
  id: string,
  now: Date,
): Promise<RouteReply> {
  const revoked = await revokePolicy(pool, id, now);
  if (!revoked) return { status: 404, body: { error: 'That policy is no longer there.' } };
  return { status: 200, body: await policiesView(pool) };
}
