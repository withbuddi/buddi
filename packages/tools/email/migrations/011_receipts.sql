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

-- Two display names compared the way a person compares them.
--
-- This is `nameKey` in `packages/tools/email/src/phrases.ts`, step for step,
-- and `step6.db.test.ts` pins the two against a table of names: the look-alike
-- test asks one side of the question in SQL and the other in TypeScript, and a
-- pair that disagreed would mean a name that evades the test silently rather
-- than mismatching loudly.
--
--  1. NFKD, which takes accents apart and folds the compatibility forms;
--  2. drop the combining marks — removed, never replaced by a space, or
--     `Ríos` becomes `ri os` and matches nothing it should;
--  3. lower, which also brings Cyrillic and Greek down to the case below;
--  4. the letters no decomposition touches (æ, œ, ß, þ, ð, ø, đ, ł, ı) and the
--     homoglyph table — Cyrillic and Greek letters drawn as Latin ones, which
--     is the whole of what makes this test worth running against somebody who
--     is trying;
--  5. everything that is not a letter or a digit becomes a space;
--  6. sort the tokens, so `MEYER, Jean-Paul` is `Jean-Paul Meyer`.
--
-- `translate` and `replace` rather than `unaccent`: the extension is not
-- installed on every Postgres an owner might point us at, and a watcher that
-- exists only where a contrib package does is not a watcher.
create or replace function name_key(raw text) returns text as $$
  select coalesce(
    (select string_agg(token, ' ' order by token)
       from unnest(
         string_to_array(
           trim(
             regexp_replace(
               translate(
                 replace(replace(replace(replace(
                   lower(regexp_replace(normalize(coalesce(raw, ''), NFKD), '[\u0300-\u036f]', '', 'g')),
                   'æ', 'ae'), 'œ', 'oe'), 'ß', 'ss'), 'þ', 'th'),
                 -- The 1:1 letters, then the Cyrillic and Greek homoglyphs.
                 -- Both strings are `LETTER_FOLDINGS` + `CONFUSABLES` from
                 -- `phrases.ts`, in that order, character for character.
                 'ðøđłıавекмнорстухіјѕһԁԛɡαβεηικνορστυχμγ',
                 'dodliabekmhopctyxijshdqgabenikvopotuxuy'),
               '[^a-z0-9]+', ' ', 'g')),
           ' ')
       ) as token
      where token <> ''),
    '');
$$ language sql immutable;

-- Display names too generic to identify anybody: `phrases.ts`'s
-- `GENERIC_NAMES`, and the same list. `Support` is a name the owner writes to
-- at a dozen addresses, so "same name, another address" says nothing about it.
-- The list is of name *keys*, so already normalised and token-sorted.
create or replace function generic_name(key text) returns boolean as $$
  select key = any (array[
    'admin', 'billing', 'client service', 'contact', 'hello', 'hr', 'info',
    'no reply', 'notifications', 'payments', 'sales', 'security', 'support', 'team'
  ]);
$$ language sql immutable;

-- Is this display name worth comparing at all? Empty is not a name — an
-- impostor with no display name is imitating nothing — and neither is a
-- generic one. `discriminatingName` in `phrases.ts` is the same test.
-- Qualified, and it has to be: a function body resolves its own names against
-- the *caller's* `search_path`, not the one the migration was applied under,
-- and the sentinels query from `public`.
create or replace function discriminating_name(raw text) returns boolean as $$
  select email.name_key(raw) <> '' and not email.generic_name(email.name_key(raw));
$$ language sql immutable;

/* ------------------------------------------------------------------ *
 * The tail is history, not catch-up
 * ------------------------------------------------------------------ */

-- On an existing installation every message ever fetched is unscanned. The
-- receipt window is a fortnight and the ask window a week; reading a decade of
-- mail to classify messages neither watcher will ever report is work for
-- nothing. Anything older than thirty days is stamped **as read**, with no
-- rows, so both sweeps start near the present.
--
-- `not exists (… is not null)` makes this a no-op on a replay. Without it, a
-- migration run a second time a year later would stamp a year of mail that the
-- watchers had been reading perfectly well, and stamp it for ever: the guard
-- says "only when nothing has ever been stamped", which is true exactly once.
update messages
   set receipts_scanned_at = now()
 where receipts_scanned_at is null
   and direction = 'in'
   and coalesce(internal_date, fetched_at) < now() - interval '30 days'
   and not exists (select 1 from messages m2 where m2.receipts_scanned_at is not null);

update messages
   set suspicion_scanned_at = now()
 where suspicion_scanned_at is null
   and direction = 'in'
   and coalesce(internal_date, fetched_at) < now() - interval '30 days'
   and not exists (select 1 from messages m2 where m2.suspicion_scanned_at is not null);

/* ------------------------------------------------------------------ *
 * The sweeps' own indexes
 * ------------------------------------------------------------------ */

-- Created **after** the backfill, deliberately: the update above touches most
-- of the rows these indexes would cover, and building them first means
-- maintaining them through that write for nothing. Inbound only, in the
-- predicate as well as in the query — the owner's own outbound mail is never a
-- receipt he was sent — and `(fetched_at, id)` is the sweeps' `order by`,
-- exactly, so they walk the index rather than sorting the mailbox.
create index if not exists messages_receipts_unscanned_idx
  on messages (fetched_at, id)
  where receipts_scanned_at is null and direction = 'in';

create index if not exists messages_suspicion_unscanned_idx
  on messages (fetched_at, id)
  where suspicion_scanned_at is null and direction = 'in';
