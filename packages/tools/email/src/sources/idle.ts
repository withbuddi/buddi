/**
 * Mail almost instantly: one IMAP IDLE connection per mailbox, on INBOX.
 *
 * The poll (`inbox-poll.ts`) reads what changed; this file only learns *that*
 * something changed, and asks for that account's poll right away. So nothing
 * here touches a cursor, a row or a flag, and everything the poll guarantees
 * (the quad, the transaction, the dedup key) holds for a poll IDLE started.
 *
 *  - **Its own connection.** Never the poll's reader and never the write
 *    port's, so a mailbox action (a MOVE, a STORE) cannot break IDLE, and an
 *    IDLE that dies costs the poll nothing. INBOX only, opened read-only.
 *  - **Sent, cheaply.** IDLE watches one mailbox, and mail the owner sends
 *    from another app lands in Sent, not INBOX. So while IDLE is live, every
 *    `IDLE_SENT_CHECK_MS` (1 min) the same connection asks `STATUS <Sent>
 *    (UIDNEXT)` — one line each way, the IDLE re-armed after it — and a
 *    UIDNEXT past the poll's Sent cursor starts the poll. No second
 *    connection; "the owner wrote back" is fresh within a minute.
 *  - **Coalesced.** A burst of EXISTS/EXPUNGE/FLAGS starts one timer
 *    (`IDLE_DEBOUNCE_MS`, 2s) and the poll runs when it fires. The source
 *    never runs two polls of one account at once; a change that lands during
 *    a poll asks for one more after it (`inbox-poll.ts`, `runLocked`).
 *  - **Re-issued.** imapflow breaks and re-issues IDLE every
 *    `IDLE_RESTART_MS` (10 min), inside the 29 minutes a server may allow.
 *  - **Reconnected with backoff.** A drop or a failed connect waits 5s, then
 *    10s, 20s … up to 5 minutes; a session that stayed up a minute resets it.
 *    After a reconnect the poll runs once, for whatever arrived meanwhile.
 *  - **Quiet when it cannot.** A server without IDLE is said once and left to
 *    the poll. A refused login records the same `login_failed_at` the poll
 *    does ("Password needed") and is not retried until the password changes
 *    (Set password, or a poll whose login works again).
 *  - **Stopped cleanly.** Plugin taken out, buddi stopping, account removed or
 *    turned off: the socket is closed and every timer cleared.
 *
 * While IDLE is live the poll slows to `IDLE_SLOW_POLL_SECONDS` for that
 * account (the safety net); while it is not, the poll keeps its normal period.
 */
import type { BuddiHost } from '@buddi/core/plugin';
import { listAccounts, type EnvLike } from '../config.js';
import { mailboxAuth } from '../credentials.js';
import { isAuthFailure, recordLoginFailure } from '../logins.js';
import type { AccountRecord, ImapIdleFactory, ImapIdleSession } from '../ports.js';

/** How long a burst of IDLE changes is gathered before the poll runs. */
export const IDLE_DEBOUNCE_MS = 2_000;
/** First reconnect delay; doubled per failure up to `IDLE_BACKOFF_MAX_MS`. */
export const IDLE_BACKOFF_FIRST_MS = 5_000;
export const IDLE_BACKOFF_MAX_MS = 5 * 60_000;
/** A session that lived this long counts as healthy: the backoff starts over. */
export const IDLE_STABLE_MS = 60_000;
/** How often a live IDLE connection asks for Sent's UIDNEXT. */
export const IDLE_SENT_CHECK_MS = 60_000;
/** The poll's period for an account whose IDLE is live: the safety net. */
export const IDLE_SLOW_POLL_SECONDS = 15 * 60;

export type IdleState =
  /** Opening the connection. */
  | 'connecting'
  /** Idling: the server tells us. */
  | 'live'
  /** Dropped or could not connect; waiting to try again. */
  | 'retrying'
  /** The server has no IDLE. The poll does it all. */
  | 'unsupported'
  /** The server refused the password. Waits for a new one. */
  | 'refused'
  /** No password could be read. Waits for the account to change. */
  | 'no-password'
  | 'stopped';

/* ------------------------------------------------------------------------ */
/* Account changes: the page tools say when a mailbox changed under us.      */
/* ------------------------------------------------------------------------ */

export interface AccountChange {
  /** The account that changed; absent when a mailbox was added or removed. */
  accountId?: string;
  /** Its password was replaced: reconnect with the new one. */
  password?: boolean;
}

const changeListeners = new Set<(change: AccountChange) => void>();

/** Said by the page tools after add, remove and Set password. */
export function accountChanged(change: AccountChange = {}): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch {
      // A watcher's trouble is its own; the tool that changed the row is done.
    }
  }
}

/* ------------------------------------------------------------------------ */
/* What the page reads.                                                      */
/* ------------------------------------------------------------------------ */

const managers = new Set<IdleWatchers>();

/** Whether this process has a live IDLE on this account's INBOX right now. */
export function idleLive(accountId: string): boolean {
  for (const manager of managers) if (manager.state(accountId) === 'live') return true;
  return false;
}

/* ------------------------------------------------------------------------ */

export interface IdleWatchersOptions {
  idle: ImapIdleFactory;
  host: BuddiHost;
  /** Ask for this account's poll now. The source serialises it. */
  poll: (accountId: string) => Promise<void>;
  /** Passwords by name instead of the owner's secrets (tests). */
  env?: EnvLike;
  debounceMs?: number;
  backoffFirstMs?: number;
  backoffMaxMs?: number;
  stableMs?: number;
  sentCheckMs?: number;
}

/** Every enabled account's watcher, kept in step with `email.accounts`. */
export class IdleWatchers {
  readonly #opts: IdleWatchersOptions;
  readonly #watchers = new Map<string, AccountWatcher>();
  /**
   * The last "no IDLE" line said per account. A watcher with no password is
   * replaced on every reconcile (the password may be readable now), so the
   * line is said once per change of state rather than once per poll.
   */
  readonly #said = new Map<string, string>();
  readonly #unlisten: () => void;
  #stopped = false;
  #reconciling: Promise<void> = Promise.resolve();

  constructor(opts: IdleWatchersOptions) {
    this.#opts = opts;
    managers.add(this);
    const listener = (change: AccountChange): void => {
      const done = change.password && change.accountId ? this.restart(change.accountId) : this.reconcile();
      done.catch((err) => this.#opts.host.log(`email.idle: ${err instanceof Error ? err.message : String(err)}`));
    };
    changeListeners.add(listener);
    this.#unlisten = () => changeListeners.delete(listener);
  }

  state(accountId: string): IdleState | null {
    return this.#watchers.get(accountId)?.state ?? null;
  }

  /** Start, stop or restart watchers so they match the enabled accounts. Serialised. */
  reconcile(): Promise<void> {
    const next = this.#reconciling.then(() => this.#reconcile()).catch((err) => {
      this.#opts.host.log(`email.idle: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.#reconciling = next;
    return next;
  }

  async #reconcile(): Promise<void> {
    if (this.#stopped) return;
    const accounts = await listAccounts(this.#opts.host.db);
    if (this.#stopped) return;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const [id, watcher] of [...this.#watchers]) {
      const account = byId.get(id);
      const moved = account !== undefined &&
        (account.imapHost !== watcher.account.imapHost || account.imapPort !== watcher.account.imapPort ||
          account.address !== watcher.account.address || account.secretName !== watcher.account.secretName);
      // A refusal is over once a login works again (the poll or Set password
      // cleared `login_failed_at`).
      const unrefused = account !== undefined && watcher.state === 'refused' && !account.loginFailedAt;
      // A password that could not be read may be readable now.
      const unread = watcher.state === 'no-password';
      if (account === undefined || moved || unrefused || unread) {
        this.#watchers.delete(id);
        await watcher.stop();
      } else {
        watcher.account = account;
      }
    }
    for (const account of accounts) {
      if (this.#stopped || this.#watchers.has(account.id)) continue;
      // A row whose password the provider refused waits for a new one.
      if (account.loginFailedAt) continue;
      const watcher = new AccountWatcher(account, this.#opts, this.#said);
      this.#watchers.set(account.id, watcher);
      watcher.start();
    }
  }

  /** The password changed: drop the connection and open one with the new one. */
  async restart(accountId: string): Promise<void> {
    const watcher = this.#watchers.get(accountId);
    if (watcher) {
      this.#watchers.delete(accountId);
      await watcher.stop();
    }
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unlisten();
    managers.delete(this);
    await this.#reconciling;
    const all = [...this.#watchers.values()];
    this.#watchers.clear();
    await Promise.all(all.map((w) => w.stop()));
  }
}

/** One account's IDLE connection, its reconnects and its debounce. */
class AccountWatcher {
  state: IdleState = 'connecting';
  #session: ImapIdleSession | null = null;
  #connecting: Promise<void> | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;
  #sentTimer: NodeJS.Timeout | null = null;
  /** The Sent UIDNEXT a poll was last asked for, so one sent message asks once. */
  #sentAsked: number | null = null;
  #attempt = 0;
  #stopped = false;

  constructor(
    public account: AccountRecord,
    private readonly opts: IdleWatchersOptions,
    private readonly said: Map<string, string> = new Map(),
  ) {}

  start(): void {
    this.#launch(false);
  }

  /** Connect, never leaving a rejection unhandled: an unexpected error (a database read, the vault) retries with backoff. */
  #launch(reconnect: boolean): void {
    this.#connecting = this.#connect(reconnect)
      .catch((err) => {
        if (!this.#stopped) this.#retry(err);
      })
      .finally(() => {
        this.#connecting = null;
      });
  }

  #log(line: string): void {
    this.opts.host.log(`email.idle: ${this.account.address}: ${line}`);
  }

  /** Say a line only when it differs from the last one said for this account. */
  #logOnChange(line: string): void {
    if (this.said.get(this.account.id) === line) return;
    this.said.set(this.account.id, line);
    this.#log(line);
  }

  async #connect(reconnect: boolean): Promise<void> {
    if (this.#stopped) return;
    this.state = 'connecting';
    const auth = await mailboxAuth({ buddi: this.opts.host }, this.account, this.opts.env);
    if (this.#stopped) return;
    if (!auth.ok) {
      this.state = 'no-password';
      this.#logOnChange(`no IDLE: ${auth.problem.message}; checking on the poll`);
      return;
    }
    // Past the password: a later "no IDLE" is news again.
    this.said.delete(this.account.id);
    let session: ImapIdleSession | 'unsupported';
    try {
      session = await this.opts.idle(this.account, auth.value, () => this.#changed());
    } catch (err) {
      if (this.#stopped) return;
      if (isAuthFailure(err)) {
        this.state = 'refused';
        await recordLoginFailure(this.opts.host.db, this.account.id, err, this.opts.host.clock.now()).catch(() => {});
        this.#log('refused its stored password; IDLE waits for a new one (Settings → Email → Set password)');
        return;
      }
      this.#retry(err);
      return;
    }
    if (session === 'unsupported') {
      this.state = 'unsupported';
      this.#log('the server has no IDLE; checking on the poll');
      return;
    }
    if (this.#stopped) {
      await session.close().catch(() => {});
      return;
    }
    this.#session = session;
    this.state = 'live';
    const since = Date.now();
    this.#log(reconnect ? 'IDLE is back' : 'IDLE on INBOX');
    // Mail that arrived while the connection was down is the poll's to find.
    if (reconnect) this.#changed();
    if (session.sentUidNext) this.#watchSent(session);
    void session.ended.then(({ error }) => {
      if (this.#session !== session) return;
      this.#session = null;
      this.#clearSent();
      if (this.#stopped) return;
      if (Date.now() - since >= (this.opts.stableMs ?? IDLE_STABLE_MS)) this.#attempt = 0;
      this.#retry(error ?? new Error('the server closed the connection'));
    });
  }

  /** This account's synced Sent folder and the poll's cursor in it, or null. */
  async #sentFolder(): Promise<{ name: string; lastUid: number } | null> {
    const { rows } = await this.opts.host.db.query(
      `select name, last_uid from email.folders where account_id = $1 and kind = 'sent' and synced limit 1`,
      [this.account.id],
    );
    const row = rows[0] as { name?: string; last_uid?: unknown } | undefined;
    return row?.name ? { name: row.name, lastUid: Number(row.last_uid ?? 0) } : null;
  }

  /** While live: ask Sent's UIDNEXT now and then; past the poll's cursor, poll. */
  #watchSent(session: ImapIdleSession): void {
    this.#clearSent();
    let quiet = false;
    this.#sentTimer = setInterval(() => {
      if (this.#stopped || this.#session !== session) return;
      void (async () => {
        // Looked up each time: a Sent folder discovered after IDLE connected counts at once.
        const sent = await this.#sentFolder();
        if (sent === null) return;
        const uidNext = await session.sentUidNext!(sent.name);
        if (uidNext === null) return;
        quiet = false;
        if (uidNext - 1 > sent.lastUid && this.#sentAsked !== uidNext) {
          this.#sentAsked = uidNext;
          this.#changed();
        }
      })().catch((err) => {
        // A dropped connection ends the session (and is retried there); say
        // anything else once per streak rather than once a minute.
        if (!quiet) this.#log(`could not check Sent: ${err instanceof Error ? err.message : String(err)}`);
        quiet = true;
      });
    }, this.opts.sentCheckMs ?? IDLE_SENT_CHECK_MS);
    this.#sentTimer.unref?.();
  }

  #clearSent(): void {
    if (this.#sentTimer) clearInterval(this.#sentTimer);
    this.#sentTimer = null;
  }

  #retry(err: unknown): void {
    if (this.#stopped) return;
    this.state = 'retrying';
    const first = this.opts.backoffFirstMs ?? IDLE_BACKOFF_FIRST_MS;
    const max = this.opts.backoffMaxMs ?? IDLE_BACKOFF_MAX_MS;
    const delay = Math.min(max, first * 2 ** Math.min(this.#attempt, 20));
    this.#attempt += 1;
    this.#log(`IDLE dropped (${err instanceof Error ? err.message : String(err)}); trying again in ${Math.round(delay / 1000)}s`);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#launch(true);
    }, delay);
    this.#retryTimer.unref?.();
  }

  /** Something changed on INBOX: one poll, at most `debounceMs` from the first change. */
  #changed(): void {
    if (this.#stopped || this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#stopped) return;
      this.opts.poll(this.account.id).catch((err) => {
        this.#log(`poll after IDLE failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.opts.debounceMs ?? IDLE_DEBOUNCE_MS);
    this.#debounceTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.state = 'stopped';
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#clearSent();
    this.#retryTimer = null;
    this.#debounceTimer = null;
    await this.#connecting?.catch(() => {});
    const session = this.#session;
    this.#session = null;
    await session?.close().catch(() => {});
  }
}
