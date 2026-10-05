/**
 * The plugin's background hand: work that needs to write, or to log in to a
 * mailbox, on behalf of a page that may only read.
 *
 * A page query is handed a pool that refuses anything but a `select`, and a
 * mailbox password is an owner secret whose every use core records — so a
 * query can neither store nor log in (`pages/queries.ts`). The inbox poll can
 * do both: it runs on core's schedule with a full context. The first poll of
 * each plugin start hands that context here (`attach`), and two things use it:
 *
 *  - **the text clean-up** of messages synced before pre.44, started once, in
 *    the background, never awaited by anybody (`text-cleanup.ts`);
 *  - **the HTML of an older message**, when the reading pane opens one
 *    (docs/email.md, "Reading mail"). Messages synced before pre.44 have no
 *    `body_html`; the pane asks for it here, and this fetches that message's
 *    HTML part once — peeked, so nothing is marked read — runs it through the
 *    same sanitiser and cap as the sync (`html.ts`), stores it, and returns
 *    it. The pane waits at most `LAZY_HTML_WAIT_MS`; on a timeout or any
 *    failure it draws the text as before, and the message is not tried again
 *    for `LAZY_HTML_RETRY_MS`, so opening it again does not wait again. A
 *    fetch that finishes after the wait still stores what it got, and the
 *    next open reads that. Remote pictures in the HTML are kept as addresses
 *    and never fetched, as at the sync.
 *
 * Until the first poll there is no context, and the pane draws the text.
 */
import type { EnvLike } from './config.js';
import { mailboxAuth } from './credentials.js';
import { MAX_HTML_INPUT_BYTES, sanitizeEmailHtml } from './html.js';
import type { ImapClientFactory } from './ports.js';
import { cleanOlderText, textCleanupLogLine, type TextCleanupOptions, type TextCleanupOutcome } from './text-cleanup.js';
import { accountOf } from './tools/shared.js';
import type { SourceContext } from './types.js';

/** How long the reading pane waits for an older message's HTML. */
export const LAZY_HTML_WAIT_MS = 6_000;
/** How long a message whose HTML could not be had is left alone. */
export const LAZY_HTML_RETRY_MS = 60 * 60 * 1000;
/** Failures remembered at once; the oldest is forgotten first. */
const FAILURES_KEPT = 1_000;

export interface MailWorkerOptions {
  connect: ImapClientFactory;
  env?: EnvLike;
  waitMs?: number;
  retryMs?: number;
  cleanup?: TextCleanupOptions;
  /** The clock failures are remembered by. Tests only. */
  now?: () => number;
}

/** What the reading pane needs of the worker. */
export interface HtmlFetcher {
  htmlFor(messageId: string): Promise<string | null>;
}

export class MailWorker implements HtmlFetcher {
  readonly #opts: MailWorkerOptions;
  #ctx: SourceContext | null = null;
  #cleanup: Promise<TextCleanupOutcome | null> | null = null;
  readonly #failed = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<string | null>>();

  constructor(opts: MailWorkerOptions) {
    this.#opts = opts;
  }

  /** The poll's context, handed over on every poll; the first one also starts the clean-up. */
  attach(ctx: SourceContext): void {
    this.#ctx = ctx;
    if (this.#cleanup !== null) return;
    const log = ctx.buddi?.log ?? ((line: string) => console.error(line));
    this.#cleanup = cleanOlderText(ctx.buddi!.db, this.#opts.cleanup).then(
      (outcome) => {
        if (outcome.ran && outcome.done) log(textCleanupLogLine(outcome.total));
        return outcome;
      },
      (error: unknown) => {
        // Where it got to is saved; the next start carries on from there.
        log(`mail: cleaning the text of older messages stopped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      },
    );
  }

  /** The clean-up this start began, for a caller that wants to wait on it (tests). */
  cleanupSettled(): Promise<TextCleanupOutcome | null> {
    return this.#cleanup ?? Promise.resolve(null);
  }

  /**
   * An older message's HTML, sanitised and stored, or null: when there is
   * none, when it cannot be had within the wait, or when it failed within
   * the last hour. Never throws.
   */
  async htmlFor(messageId: string): Promise<string | null> {
    const now = this.#opts.now ?? Date.now;
    const failedAt = this.#failed.get(messageId);
    if (failedAt !== undefined && now() - failedAt < (this.#opts.retryMs ?? LAZY_HTML_RETRY_MS)) return null;
    const ctx = this.#ctx;
    if (ctx === null) return null;

    let running = this.#inflight.get(messageId);
    if (running === undefined) {
      running = this.#fetch(ctx, messageId).finally(() => this.#inflight.delete(messageId));
      this.#inflight.set(messageId, running);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ html: null; failed: true }>((resolve) => {
      timer = setTimeout(() => resolve({ html: null, failed: true }), this.#opts.waitMs ?? LAZY_HTML_WAIT_MS);
    });
    try {
      const outcome = await Promise.race([
        running.then(
          (html) => ({ html, failed: html === null }),
          () => ({ html: null, failed: true }),
        ),
        timeout,
      ]);
      if (outcome.failed) this.#remember(messageId, now());
      return outcome.html;
    } finally {
      clearTimeout(timer);
    }
  }

  #remember(messageId: string, at: number): void {
    this.#failed.delete(messageId);
    this.#failed.set(messageId, at);
    if (this.#failed.size > FAILURES_KEPT) {
      const oldest = this.#failed.keys().next().value;
      if (oldest !== undefined) this.#failed.delete(oldest);
    }
  }

  async #fetch(ctx: SourceContext, messageId: string): Promise<string | null> {
    const db = ctx.buddi!.db;
    const { rows } = await db.query(
      `select m.account_id, m.uidvalidity, m.uid, f.name as folder
         from email.messages m
         join email.accounts a on a.id = m.account_id
         join email.folders f on f.id = m.folder_id
        where m.id = $1::uuid and m.body_html is null and m.body_purged_at is null
          and m.uid is not null and m.uid > 0 and a.enabled`,
      [messageId],
    );
    const row = rows[0] as { account_id: string; uidvalidity: unknown; uid: unknown; folder: string } | undefined;
    if (!row) return null;
    const account = await accountOf(db, String(row.account_id));
    const auth = await mailboxAuth(ctx, account, this.#opts.env);
    if (!auth.ok) throw new Error(auth.problem.message);
    const client = await this.#opts.connect(account, auth.value);
    try {
      if (typeof client.fetchHtml !== 'function') return null;
      // A uid means nothing across a UIDVALIDITY change: the mailbox was
      // recreated, and this uid may be somebody else's message now.
      const status = await client.open(row.folder);
      if (status.uidValidity !== Number(row.uidvalidity)) return null;
      const raw = await client.fetchHtml(row.folder, Number(row.uid), MAX_HTML_INPUT_BYTES);
      const html = sanitizeEmailHtml(raw);
      if (html === null) return null;
      await db.query(
        `update email.messages set body_html = $2
          where id = $1::uuid and body_html is null and body_purged_at is null`,
        [messageId, html],
      );
      return html;
    } finally {
      await client.close().catch(() => {});
    }
  }
}
