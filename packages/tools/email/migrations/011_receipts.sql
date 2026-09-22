-- What a message was read to be: a receipt, and an ask (applied with
-- search_path = email, public).
--
-- docs/specs/email.md §7, step 6: `email.receipt-or-bill` and
-- `email.suspicious-sender`. Both run hourly over the whole mailbox, and both
-- have to read a *body* to decide anything — so both follow `009_dates.sql`
-- exactly: a stamp on the message saying it has been read, and a table saying
-- what the reading was.
--
-- Two columns and two tables rather than one of each, because the two
-- questions are asked of different mail and answered on different horizons: a
-- receipt is worth a finding for a fortnight, an ask for a week, and a message
-- may be read for one before the other watcher was ever switched on.
--
-- Why a stamp *and* a table, when the finding lives in core:
--
--  * **The read is the expensive half.** Classifying fourteen days of bodies
--    every hour is work; classifying each body once is not.
--  * **A finding that is not re-reported is resolved.** Core resolves every
--    open key a tick did not name, so a reading kept only in memory would be
--    raised once and quietly withdrawn an hour later. The row is what makes
--    the same fact the same fact on every tick.
--  * **A body that goes away does not take the reading with it.** Retention
--    nulls `body_text` after 90 days; what was read out of it stays.
--
-- Nothing here is a decision. A row is a candidate with a confidence between 0
-- and 1; whether it is worth saying anything about is the sentinel's business,
-- against the owner's `watcher_receipt_confidence`.

/* ------------------------------------------------------------------ *
 * Receipts, invoices, order confirmations
 * ------------------------------------------------------------------ */

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages (id) on delete cascade,
  -- 0..1, to two decimals — `numeric`, not `real`, for the reason
  -- `009_dates.sql` gives: a `real` 0.7 sits below an owner threshold of
  -- exactly 0.7, and the settings page offers exactly 0.7.
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  -- The words it was read from, so the owner can check the classifier. Sender
  -- controlled: every reader of this column fences it.
  phrase text not null,
  -- The total, when one was read beside the word for it. A number and a code,
  -- never the sender's own string: this is what the finding may state.
  amount numeric(14,2) null,
  currency text null check (currency is null or currency in ('EUR', 'USD', 'GBP')),
  found_at timestamptz not null default now(),
  -- One reading per message. A rescan improves it rather than doubling it.
  unique (message_id)
);

-- When this message was read for receipt vocabulary. Null means never, which
-- is what the bounded catch-up sweep looks for. Stamped even when nothing was
-- found: "not a receipt" is a result, not an omission.
alter table messages add column if not exists receipts_scanned_at timestamptz null;

-- Inbound only, in the predicate as well as in the query: the owner's own
-- outbound mail is never a receipt he was sent, and an index carrying it would
-- be mostly rows the sweep skips. `fetched_at` is the order the sweep asks
-- for, exactly, so it walks this index rather than sorting the mailbox.
create index if not exists messages_receipts_unscanned_idx
  on messages (fetched_at, id)
  where receipts_scanned_at is null and direction = 'in';

/* ------------------------------------------------------------------ *
 * The ask: credentials, a wire, a gift card
 * ------------------------------------------------------------------ */

create table if not exists suspicions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages (id) on delete cascade,
  -- Which of the three was asked for. The look-alike test is *not* stored: it
  -- is a fact about the mailbox as it stands today, not about this message,
  -- and it is computed in SQL on every tick so that a name the owner first
  -- wrote to this morning protects him this afternoon.
  kind text not null check (kind in ('credentials', 'wire', 'gift-card')),
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  -- The words that fired. Never more of the body than this, anywhere.
  phrase text not null,
  urgent boolean not null default false,
  found_at timestamptz not null default now(),
  unique (message_id)
);

alter table messages add column if not exists suspicion_scanned_at timestamptz null;

create index if not exists messages_suspicion_unscanned_idx
  on messages (fetched_at, id)
  where suspicion_scanned_at is null and direction = 'in';

/* ------------------------------------------------------------------ *
 * Names, for the look-alike test
 * ------------------------------------------------------------------ */

-- The display name a From or To header carries, or '' when it carries none.
-- `"Jean Dupont" <jean@x.test>` and `Jean Dupont <jean@x.test>` are both the
-- one name; a bare address is nobody, which is right — an impostor with no
-- display name is not imitating anything.
create or replace function display_name_of(raw text) returns text as $$
  select trim(both '"' from trim(coalesce(substring(coalesce(raw, '') from '^(.*?)\s*<'), '')));
$$ language sql immutable;

-- Two display names compared the way a person compares them: case, accents and
-- punctuation are not the difference between `Jean-Paul MEYER` and
-- `jean paul meyer`. The TypeScript side has the same function (`nameKey` in
-- `phrases.ts`), and the DB suite holds the two to the same answers.
--
-- `translate` rather than `unaccent`: the extension is not installed on every
-- Postgres an owner might point us at, and a watcher that exists only where a
-- contrib package does is not a watcher.
create or replace function name_key(raw text) returns text as $$
  select trim(regexp_replace(
    translate(lower(coalesce(raw, '')),
              'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
              'aaaaaaceeeeiiiinooooouuuuyy'),
    '[^a-z0-9]+', ' ', 'g'));
$$ language sql immutable;

/* ------------------------------------------------------------------ *
 * The tail is history, not catch-up
 * ------------------------------------------------------------------ */

-- On an existing installation every message ever fetched is unscanned. The
-- receipt window is a fortnight and the ask window a week; reading a decade of
-- mail 200 rows an hour to classify messages neither watcher will ever report
-- is work for nothing. Anything older than thirty days is stamped as read with
-- no rows, so both sweeps start near the present and empty in a few ticks.
update messages
   set receipts_scanned_at = now()
 where receipts_scanned_at is null
   and direction = 'in'
   and coalesce(internal_date, fetched_at) < now() - interval '30 days';

update messages
   set suspicion_scanned_at = now()
 where suspicion_scanned_at is null
   and direction = 'in'
   and coalesce(internal_date, fetched_at) < now() - interval '30 days';
