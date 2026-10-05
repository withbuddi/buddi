/**
 * The text of messages synced before pre.44, cleaned once in the background.
 *
 * Until pre.44 an HTML-only message was turned into text by a few regular
 * expressions that decoded five entities (`text.ts` says what replaced them),
 * so older rows still carry `&#8202;`, `&zwnj;`, `&#38;` and the invisible
 * padding newsletters put in their preview line — in `body_text`, which is
 * what agents and search read, and in `snippet`, which is the list's preview.
 * There is no HTML left to read them again from, so the stored text itself is
 * decoded and tidied (`cleanText`), and the snippet is cut again from it.
 *
 * Only text that came from HTML is touched. A genuine plain-text message
 * that says `&copy;` or is indented means it, and has no HTML to recover the
 * original from, so a row is rewritten only when it carries a mark of HTML:
 *
 *  - its message has an HTML part kept (`body_html` holds HTML), or
 *  - its text carries the invisible preview-line padding, as characters
 *    (`PADDING_PATTERN`) or as the entities the old regexes left behind
 *    (`PADDING_ENTITY_PATTERN`: `&zwnj;`, `&#8202;`…), which only an HTML
 *    mailer writes.
 *
 * A row whose `body_html` is `''` — checked, the message has no HTML part —
 * is never touched, padding or not; nor is a row with no HTML kept and no
 * padding (text-only mail synced before pre.44 looks exactly like that). The
 * cost: an older HTML-only message with entities but no padding keeps them.
 *
 * Bounded and out of the owner's way: it starts once per plugin start (the
 * first poll, `worker.ts`), walks the table in id order a batch at a time,
 * yields between batches, and records where it got to in `email.settings`, so
 * a restart carries on from there and a finished pass never runs again.
 *
 * Decoding is not idempotent (`&amp;copy;` → `&copy;` → `©`), so a row is
 * decoded once and never again: each batch's rewrites and the cursor past
 * them commit in one transaction, so a crash leaves both or neither, and the
 * cursor means no row is read twice — neither one it rewrote nor one it could
 * not improve (`AT&T;`). The batch's rows are locked while it runs, and the
 * update only lands on a row that is not purged and still holds the text
 * that was read, so retention purging a body meanwhile is never undone.
 */
import type { DbArea } from '@buddi/core/plugin';
import { snippetOf } from './mail.js';
import { cleanText, ENTITY_PATTERN, PADDING_ENTITY_PATTERN, PADDING_PATTERN } from './text.js';

type Db = Pick<DbArea, 'query' | 'transaction'>;
type Query = Pick<DbArea, 'query'>;

/** Where the pass got to. Lives in `email.settings`. */
export const TEXT_CLEANUP_KEY = 'text_cleanup';
/** Rows read per statement. */
export const TEXT_CLEANUP_BATCH = 200;

interface Progress {
  after: string | null;
  cleaned: number;
  done: boolean;
}

export interface TextCleanupOutcome {
  /** Rows rewritten by this call. */
  cleaned: number;
  /** Whether the pass is finished (by this call or an earlier one). */
  done: boolean;
  /** False when an earlier start had already finished it, and nothing was read. */
  ran: boolean;
  /** Rows rewritten over the whole pass, across restarts. */
  total: number;
}

export interface TextCleanupOptions {
  batchSize?: number;
  /** What runs between batches. Defaults to giving the event loop a turn. */
  pause?: () => Promise<void>;
  /** At most this many batches in this call (tests); the rest waits for the next start. */
  maxBatches?: number;
  now?: () => Date;
}

async function loadProgress(db: Query): Promise<Progress> {
  const { rows } = await db.query<{ value: unknown }>(`select value from email.settings where key = $1`, [TEXT_CLEANUP_KEY]);
  const raw = rows[0]?.value as Partial<Progress> | undefined;
  return {
    after: typeof raw?.after === 'string' ? raw.after : null,
    cleaned: typeof raw?.cleaned === 'number' ? raw.cleaned : 0,
    done: raw?.done === true,
  };
}

async function saveProgress(db: Query, progress: Progress, now: Date): Promise<void> {
  await db.query(
    `insert into email.settings (key, value, updated_at) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [TEXT_CLEANUP_KEY, JSON.stringify(progress), now],
  );
}

const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** Clean what is left to clean, from where the last start stopped. */
export async function cleanOlderText(db: Db, opts: TextCleanupOptions = {}): Promise<TextCleanupOutcome> {
  const batch = Math.max(1, opts.batchSize ?? TEXT_CLEANUP_BATCH);
  const pause = opts.pause ?? breathe;
  const now = opts.now ?? (() => new Date());
  const progress = await loadProgress(db);
  if (progress.done) return { cleaned: 0, done: true, ran: false, total: progress.cleaned };

  let cleaned = 0;
  let batches = 0;
  for (;;) {
    if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return { cleaned, done: false, ran: true, total: progress.cleaned };
    batches += 1;
    const next = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; body_text: string | null; snippet: string | null }>(
        `select id::text as id, body_text, snippet
           from email.messages
          where ($1::uuid is null or id > $1::uuid)
            and body_purged_at is null
            and coalesce(body_html, 'unknown') <> ''
            and (body_html is not null or body_text ~ $3 or snippet ~ $3 or body_text ~* $5 or snippet ~* $5)
            and (body_text ~* $2 or body_text ~ $3 or snippet ~* $2 or snippet ~ $3)
          order by id
          limit $4
          for update`,
        [progress.after, ENTITY_PATTERN, PADDING_PATTERN, batch, PADDING_ENTITY_PATTERN],
      );
      const ids: string[] = [];
      const bodies: Array<string | null> = [];
      const snippets: Array<string | null> = [];
      const readBodies: Array<string | null> = [];
      const readSnippets: Array<string | null> = [];
      for (const row of rows) {
        const body = row.body_text === null ? null : cleanText(row.body_text);
        // The snippet is cut again from the cleaned body: the old one was cut
        // from padded text, and cleaning it alone would leave it nearly empty.
        const snippet = body !== null ? snippetOf(body) : row.snippet === null ? null : snippetOf(cleanText(row.snippet));
        if (body === row.body_text && snippet === row.snippet) continue;
        ids.push(row.id);
        bodies.push(body);
        snippets.push(snippet);
        readBodies.push(row.body_text);
        readSnippets.push(row.snippet);
      }
      let written = 0;
      if (ids.length > 0) {
        const { rowCount } = await tx.query(
          `update email.messages m
              set body_text = v.body, snippet = coalesce(v.snippet, m.snippet)
             from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) as v(id, body, snippet, read_body, read_snippet)
            where m.id = v.id
              and m.body_purged_at is null
              and m.body_text is not distinct from v.read_body
              and m.snippet is not distinct from v.read_snippet`,
          [ids, bodies, snippets, readBodies, readSnippets],
        );
        written = rowCount ?? 0;
      }
      const last = rows[rows.length - 1];
      const after = last ? last.id : progress.after;
      const saved: Progress = { after, cleaned: progress.cleaned + written, done: rows.length < batch };
      // The cursor moves past this batch in the same transaction as its
      // rewrites: a crash keeps both or neither, so nothing is decoded twice.
      await saveProgress(tx, saved, now());
      return { saved, written };
    });
    progress.after = next.saved.after;
    progress.cleaned = next.saved.cleaned;
    progress.done = next.saved.done;
    cleaned += next.written;
    if (progress.done) return { cleaned, done: true, ran: true, total: progress.cleaned };
    await pause();
  }
}

/** The one line the pass leaves in the log when it finishes. */
export function textCleanupLogLine(cleaned: number): string {
  return `mail: cleaned the text of ${cleaned} older message${cleaned === 1 ? '' : 's'}`;
}
