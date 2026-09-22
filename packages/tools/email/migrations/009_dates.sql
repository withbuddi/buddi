-- Dates a message states (applied with search_path = email, public).
--
-- docs/specs/email.md §7, `email.date-stated`: *«a message states a date within
-- the next 14 days (a deadline, an appointment, a due date), and no reminder
-- exists for it»*. The finding is raised by the sentinel; what is kept here is
-- the *reading* — which day, from which words, and how sure the parser was.
--
-- Why a table rather than re-parsing on every tick:
--
--  * **The parse is the evidence.** A finding says "a date is stated"; the
--    owner's next question is "where", and `phrase` is the answer in the
--    sender's own words. Re-deriving it would mean re-reading bodies that
--    retention may already have purged.
--  * **It is done once.** Detection runs at ingest, on the body that is in
--    hand, and the sentinel only sweeps up what ingest missed —
--    `messages.dates_scanned_at` is the line between the two, so a message is
--    read for dates exactly once whatever order the two paths run in.
--  * **A body that goes away does not take the date with it.** Retention nulls
--    `body_text` after 90 days; a date found in it stays findable.
--
-- Nothing here is a decision. A row is a candidate the parser produced, with a
-- confidence between 0 and 1; whether it is worth saying anything about is the
-- sentinel's business, against the owner's `watcher_date_confidence`.

create table if not exists dates (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages (id) on delete cascade,
  -- The day itself, in the owner's zone: a date, not an instant. A deadline
  -- has no timezone the way an appointment does, and storing midnight
  -- somewhere would make one of the two wrong.
  on_date date not null,
  -- The words it was read from, so the owner can check the parser.
  phrase text not null,
  -- 0..1, to two decimals — `numeric`, not `real`. The parser rounds to 2dp
  -- and the threshold it is compared against (`watcher_date_confidence`) is
  -- typed the same way, because `real` 0.45 is 0.44999998807907104 and would
  -- sit *below* an owner threshold of exactly 0.45: a hit the settings page
  -- says qualifies, silently dropped.
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  found_at timestamptz not null default now(),
  -- One reading per day per message: the same Tuesday spelled twice is one
  -- fact, and re-scanning a message must not double its rows.
  unique (message_id, on_date)
);

-- The sentinel's own query: upcoming days, joined to their messages.
create index if not exists dates_on_date_idx on dates (on_date);

-- When this message was read for dates. Null means never — which is what the
-- catch-up sweep looks for, bounded, oldest first. Stamped even when nothing
-- was found: "no dates in it" is a result, not an omission.
alter table messages add column if not exists dates_scanned_at timestamptz null;

-- Inbound only, in the predicate as well as in the query: the owner's own
-- mail is never read for dates, so an index that carried it would be mostly
-- rows the sweep skips. `fetched_at` is the order `unscannedMessages` asks
-- for, exactly, so the sweep walks this index rather than sorting the mailbox.
create index if not exists messages_dates_unscanned_idx
  on messages (fetched_at, id)
  where dates_scanned_at is null and direction = 'in';

-- The tail is history, not catch-up. On an existing installation every message
-- ever fetched is unscanned, and reading a decade of mail 200 rows an hour to
-- find dates that went by years ago is work for nothing. Anything older than
-- sixty days is stamped as read with no rows: the sweep starts near the
-- present and empties in a few ticks rather than a few weeks.
update messages
   set dates_scanned_at = now()
 where dates_scanned_at is null
   and direction = 'in'
   and coalesce(internal_date, fetched_at) < now() - interval '60 days';
