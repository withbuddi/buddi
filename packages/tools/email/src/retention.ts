/**
 * Mail retention — what this plugin keeps, and for how long.
 *
 * The rule, in one line: **headers, snippet and triage decisions are kept
 * forever; bodies are not.** A body is the bulky, attacker-controlled half of
 * a message and the half nobody re-reads a year later; the record that the
 * message arrived, who sent it, what it was about and what triage decided is
 * what the owner and their agents actually reason over. So after the retention
 * window a body is nulled out in place — the row stays, `body_purged_at` says
 * when the text went, and `email.read` says so plainly instead of pretending
 * the mail was empty.
 *
 * Retention is the owner's setting, not a constant: `email.retention_days` in
 * `email.settings`, default 90, changed from a chat through
 * `email.set_settings`. Nothing here deletes a row, and nothing here touches a
 * message inside the window — the purge is bounded by one cutoff and one batch
 * size, and it is the only thing in the plugin that writes over ingested text.
 */
import type { Pool } from 'pg';

/** The settings key. Lives in `email.settings`, value is a json number. */
export const RETENTION_DAYS_KEY = 'retention_days';

/** How long a body is kept when the owner has not said otherwise. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Floor and ceiling for the setting. A day is the shortest honest window. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/** Rows purged per statement. A backlog drains over several batches. */
export const PURGE_BATCH = 500;

/** Safety stop: a single pass never runs more than this many batches. */
const MAX_BATCHES_PER_PASS = 1_000;

export interface EmailSettings {
  retentionDays: number;
}

function clampDays(value: number): number {
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.trunc(value)));
}

/** The owner's settings, with the defaults filled in. Never throws on a bad row. */
export async function loadSettings(db: Pool): Promise<EmailSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from email.settings where key = $1`,
    [RETENTION_DAYS_KEY],
  );
  const raw = rows[0]?.value;
  const days = typeof raw === 'number' ? raw : Number(raw);
  return {
    retentionDays: Number.isFinite(days) && days > 0 ? clampDays(days) : DEFAULT_RETENTION_DAYS,
  };
}

/** Write the retention window. Returns the settings as they now stand. */
export async function setRetentionDays(
  db: Pool,
  days: number,
  now: Date,
): Promise<EmailSettings> {
  const value = clampDays(days);
  await db.query(
    `insert into email.settings (key, value, updated_at) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [RETENTION_DAYS_KEY, JSON.stringify(value), now],
  );
  return { retentionDays: value };
}

export interface PurgeOptions {
  /** Overrides the stored setting. Used by tests and by a one-shot CLI. */
  retentionDays?: number;
  batchSize?: number;
}

export interface PurgeOutcome {
  purged: number;
  retentionDays: number;
  cutoff: Date;
  batches: number;
}

/** The line the daily pass logs. One sentence, countable, greppable. */
export function purgeLogLine(outcome: PurgeOutcome): string {
  return `email.retention: purged ${outcome.purged} bodies older than ${outcome.retentionDays} days`;
}

/**
 * Null out the bodies of every message older than the retention window.
 *
 * Age is `coalesce(date, fetched_at)`: the date the message carries, and when
 * it carries none, the day it landed here. The `body_purged_at is null` guard
 * makes the pass idempotent — a purged row is never rewritten, so running this
 * twice in a minute purges nothing the second time — and the batch keeps one
 * pass over a decade of mail from being one enormous statement.
 *
 * Attachments are listings only (filename, mime, size — the bytes were never
 * ingested), so there is no attachment *content* to purge; the listing is
 * header-shaped and is kept like the headers.
 */
export async function purgeBodies(
  db: Pool,
  now: Date,
  opts: PurgeOptions = {},
): Promise<PurgeOutcome> {
  const settings = await loadSettings(db);
  const retentionDays = clampDays(opts.retentionDays ?? settings.retentionDays);
  const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? PURGE_BATCH));
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  let purged = 0;
  let batches = 0;
  for (; batches < MAX_BATCHES_PER_PASS; ) {
    const { rowCount } = await db.query(
      `update email.messages
          set body_text = null,
              body_purged_at = $1
        where id in (
          select id from email.messages
           where body_purged_at is null
             and coalesce(date, fetched_at) < $2
           order by coalesce(date, fetched_at) asc
           limit $3
        )`,
      [now, cutoff, batchSize],
    );
    batches += 1;
    const n = rowCount ?? 0;
    purged += n;
    if (n < batchSize) break;
  }

  return { purged, retentionDays, cutoff, batches };
}

/** The note `email.read` returns in place of a body that is no longer stored. */
export function purgedBodyNote(retentionDays: number, purgedAt: string | null): string {
  const when = purgedAt ? ` (removed ${purgedAt.slice(0, 10)})` : '';
  return (
    `The body of this message was purged under the mail retention policy${when}: ` +
    `bodies are kept for ${retentionDays} days, headers, the snippet and the triage decision forever. ` +
    'The full text is no longer stored here — say so rather than guessing what it said.'
  );
}
