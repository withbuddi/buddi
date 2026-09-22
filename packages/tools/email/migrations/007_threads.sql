-- Threads, direction, and the folders of a mailbox (search_path = email, public).
--
-- docs/email.md §2: **the thread is the unit, not the message. Who wrote last
-- is state.** Everything in this file exists to make that sentence true of the
-- schema rather than of the prose.
--
-- Three changes, and one of them is a rename.
--
--  1. `mailboxes` becomes `folders`. It is the same table — the same rows, the
--     same ids, the same cursor, the same `(account, name)` key — with the two
--     columns a discovered folder needs: what *kind* of folder it is (the
--     inbox, the Sent folder, or one of the dozens a real account has) and
--     whether buddi polls it. A second cursor table beside the first would
--     have been two places for one fact; a rename is none. `messages.mailbox_id`
--     follows it to `folder_id`, and the identity quad
--     `(account, folder, uidvalidity, uid)` is unchanged under its new name.
--
--  2. `threads`, one row per conversation per account, keyed by the
--     `thread_key` the messages already carry. It holds what a conversation is
--     when you are not looking at it: who is in it, when it started, when it
--     last moved, how many messages it has, who wrote last, and — the column
--     everything else is for — its `state`.
--
--     `waiting-on-me` and `waiting-on-them` are *derived*: they are who wrote
--     last, nothing more, and the Sent folder is what makes them honest. Before
--     this migration buddi could not tell a thread the owner had answered from
--     his phone from one nobody had answered at all. `muted` is the owner's own
--     decision and is sticky: new mail never lifts it. `closed` is the one
--     judgement here, and it is made conservatively — see the backfill.
--
--  3. `messages.direction`: `in` for mail that arrived, `out` for what the
--     owner sent. Derived at ingest from the folder a message landed in, not
--     from its From header (sender-controlled). Every row already stored
--     came through INBOX, the only folder ever polled before this migration,
--     so the backfill below leaves them all `in` — nothing is inferred from
--     `From`.
--
-- The thread-scope policy matcher moves with all this. A `thread` policy used
-- to name a `thread_key` — a string the sender writes — and now names the
-- thread's own id, which is ours. Existing rows are re-pointed at the end so a
-- rule the owner already wrote keeps deciding the conversation it was about.

-- 1 ----------------------------------------------------------------- folders
alter table if exists mailboxes rename to folders;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'email' and table_name = 'messages' and column_name = 'mailbox_id'
  ) then
    alter table messages rename column mailbox_id to folder_id;
  end if;
end
$$;

-- What the folder is *for*. `other` is the honest default: a folder nobody has
-- classified is not the inbox and is not Sent.
alter table folders add column if not exists kind text not null default 'other';
-- Whether the poll walks it. Two folders are synced by default — the inbox and
-- Sent — and docs/email.md §11 keeps "more than two" as a later choice.
alter table folders add column if not exists synced boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'folders_kind_check') then
    alter table folders add constraint folders_kind_check check (kind in ('inbox', 'sent', 'other'));
  end if;
end
$$;

-- Every folder this installation already had is the inbox: it is the only one
-- that was ever polled, and its cursor is the one thing here that must survive.
update folders set kind = 'inbox', synced = true where upper(name) = 'INBOX';

create index if not exists folders_synced_idx on folders (account_id) where synced;

-- 2 ----------------------------------------------------------------- threads
create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  -- The conversation's key, as `threadKeyFor` derives it: the root of the
  -- References chain. A message that carries no id at all is a conversation of
  -- one and is keyed `message:<row id>`, so every message has a thread and
  -- "no thread" never has to mean two different things.
  thread_key text not null,
  subject text not null default '',
  -- Every address that has written or been written to in this conversation,
  -- the owner's own included. Searchable by participant (docs/email.md §9).
  -- Capped at `participants_cap()` (50): see the function below.
  participants jsonb not null default '[]'::jsonb,
  -- How many more distinct participants have written into this conversation
  -- than the cap keeps. Zero for every ordinary thread.
  participants_overflow integer not null default 0,
  first_at timestamptz null,
  last_at timestamptz null,
  -- Who the conversation is waiting on. `waiting-on-me` and `waiting-on-them`
  -- are derived from who wrote last; `muted` is the owner's decision and is
  -- never lifted by new mail; `closed` says nothing more is expected.
  state text not null default 'waiting-on-me'
    check (state in ('waiting-on-me', 'waiting-on-them', 'closed', 'muted')),
  -- The policy that decides this conversation, when one does.
  policy_id uuid null references policies (id) on delete set null,
  message_count integer not null default 0,
  last_direction text not null default 'in' check (last_direction in ('in', 'out')),
  -- The folder and uid of the message that decided `last_direction` and
  -- `last_at`. Not shown anywhere; it exists only so that two messages
  -- landing with the *same* ordering clock (see `internal_date` below) have a
  -- deterministic winner — folder, UIDVALIDITY, uid, then message row id —
  -- instead of whichever one this poll happened to process last.
  last_folder_id uuid null references folders (id) on delete set null,
  last_uidvalidity bigint null,
  last_uid bigint null,
  last_message_id uuid null references messages (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (account_id, thread_key)
);

-- Keep the migration itself re-runnable while these winner columns evolve.
alter table threads add column if not exists last_uidvalidity bigint null;
alter table threads add column if not exists last_message_id uuid null references messages (id) on delete set null;

create index if not exists threads_state_idx on threads (account_id, state, last_at desc nulls last);
create index if not exists threads_last_at_idx on threads (last_at desc nulls last);

alter table messages add column if not exists thread_id uuid null
  references threads (id) on delete set null;

-- `in` is the right answer for every row already stored: only INBOX was ever
-- polled, so everything here arrived through it, and that is the only
-- evidence trusted for direction. Ingest sets it explicitly from the folder a
-- message lands in from now on.
alter table messages add column if not exists direction text not null default 'in';

-- IMAP INTERNALDATE: the server's own record of when it received the
-- message, as opposed to `date` (the `Date` header, which the sender writes
-- and which `threads.ts` never trusts for ordering — see there). Null only
-- for a row from before this column existed, or a server that genuinely
-- omits it; `fetched_at` is the fallback ordering clock either way.
alter table messages add column if not exists internal_date timestamptz null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_direction_check') then
    alter table messages add constraint messages_direction_check check (direction in ('in', 'out'));
  end if;
end
$$;

create index if not exists messages_thread_id_idx on messages (thread_id);
create index if not exists messages_direction_idx on messages (account_id, direction);

-- How many distinct participants a thread is allowed to hold. Nothing stops a
-- sender who knows a thread key from repeatedly attaching arbitrary To/Cc
-- lists — `docs/email.md` never promised that address to be honest — and an
-- unbounded jsonb column is an unbounded row and an ever more expensive
-- upsert. Names past the cap are still counted, in `participants_overflow`,
-- just not stored: the owner sees "and N more" rather than either an
-- unbounded row or a silently dropped fact.
create or replace function participants_cap() returns integer as $$
  select 50;
$$ language sql immutable;

-- The union of two participant lists, sorted, without duplicates, capped. A
-- function rather than an inline sub-select because `on conflict do update`
-- is where it is used, and that clause is no place for a subquery.
create or replace function merge_participants(a jsonb, b jsonb) returns jsonb as $$
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    from (
      select distinct value
        from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb)) as e(value)
       order by value
       limit email.participants_cap()
    ) capped;
$$ language sql immutable;

-- How many distinct participants two lists hold together, uncapped — what
-- `participants_overflow` is derived from.
create or replace function merge_participants_count(a jsonb, b jsonb) returns integer as $$
  select count(distinct value)::int
    from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb)) as e(value);
$$ language sql immutable;

-- Does the newly arrived message decide who wrote last? By the ordering
-- clock (`threads.ts`'s `at`, built from INTERNALDATE with a `fetched_at`
-- fallback — never the sender's `Date` header). When two messages carry the
-- exact same clock value, the winner is decided by folder, generation, uid
-- and immutable message row id, always
-- the same way for the same two messages, rather than by whichever one this
-- particular poll happened to write last.
create or replace function newer_wins(
  new_at timestamptz, old_at timestamptz,
  new_folder uuid, old_folder uuid,
  new_uidvalidity bigint, old_uidvalidity bigint,
  new_uid bigint, old_uid bigint,
  new_message uuid, old_message uuid
) returns boolean as $$
  select case
    when new_at is null then false
    when old_at is null then true
    when new_at > old_at then true
    when new_at < old_at then false
    when old_folder is null then true
    when new_folder is null then false
    when new_folder::text <> old_folder::text then new_folder::text > old_folder::text
    when old_uidvalidity is null then true
    when new_uidvalidity is null then false
    when new_uidvalidity <> old_uidvalidity then new_uidvalidity > old_uidvalidity
    when old_uid is null then true
    when new_uid is null then false
    when new_uid <> old_uid then new_uid > old_uid
    when old_message is null then true
    when new_message is null then false
    else new_message::text > old_message::text
  end;
$$ language sql immutable;

-- 3 ---------------------------------------------------------------- backfill
--
-- A function rather than a `do` block, for the same reason `004` made its seed
-- one: the test suite calls the code the migration called, on fixtures of its
-- own, instead of a copy of it that can drift.

/*
 * Build the threads from the messages that are already stored.
 *
 * State comes from the newest message's direction — out means the owner wrote
 * last and it is `waiting-on-them`, in means it is `waiting-on-me` — with one
 * exception, made deliberately narrowly:
 *
 * **`closed` is only for a conversation that is not one.** A thread is closed
 * when it is a single inbound message, older than 30 days, from a sender buddi
 * already has an `ignore` rule about — kept or merely proposed. That is a
 * newsletter, not a question left hanging, and calling it `waiting-on-me`
 * forever would be the waiting-on-me watcher's first false alarm. Anything with
 * a reply in it, anything recent, and anything from a sender nobody has ruled
 * on stays waiting, because "no reply is expected" is not something this
 * function is entitled to guess.
 */
create or replace function backfill_threads(seeded_at timestamptz default now())
  returns integer as $$
declare
  inserted integer;
begin
  -- Direction is not guessed from `From` here: every row already stored came
  -- through INBOX (the only folder ever polled before this migration) and the
  -- column defaults to `in`, which is already the right answer for it. A From
  -- header is a string the sender writes, and inferring `out` from it would
  -- let a spoofed or alias-addressed inbound message claim "the owner wrote
  -- last." Direction for new mail is set at ingest from the folder it landed
  -- in, not from a header.

  with msgs as (
    select m.id,
           m.account_id,
           coalesce(nullif(m.thread_key, ''), 'message:' || m.id::text) as tkey,
           m.subject,
           m.from_addr,
           m.to_addrs,
           m.cc,
           m.direction,
           m.uid,
           m.folder_id,
           -- The ordering clock. Preferred: INTERNALDATE, when this row has
           -- one. Legacy rows fall back to the header date only within one
           -- day of fetched_at; an already-stored hostile far-future Date
           -- must not pin a thread's state for years.
           coalesce(m.internal_date, least(m.date, m.fetched_at + interval '1 day'), m.fetched_at) as at,
           m.uidvalidity
      from email.messages m
  ),
  parts as (
    select g.account_id,
           g.tkey,
           email.merge_participants('[]'::jsonb, jsonb_agg(distinct p.addr)) as participants,
           count(distinct p.addr)::int as participant_count
      from msgs g,
           lateral (
             select email.address_of(g.from_addr) as addr
             union all select email.address_of(x) from jsonb_array_elements_text(g.to_addrs) as x
             union all select email.address_of(x) from jsonb_array_elements_text(g.cc) as x
           ) p
     where p.addr is not null and p.addr <> ''
     group by g.account_id, g.tkey
  ),
  rolled as (
    -- Ties on `at` are broken deterministically — folder, UIDVALIDITY, uid,
    -- then message row id — rather than by table output order.
    select account_id,
           tkey,
           (array_agg(subject order by at asc, folder_id asc, uidvalidity asc, uid asc, id asc))[1] as subject,
           min(at) as first_at,
           max(at) as last_at,
           count(*)::int as message_count,
           (array_agg(direction order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_direction,
           (array_agg(email.address_of(from_addr) order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_sender,
           (array_agg(folder_id order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_folder_id,
           (array_agg(uidvalidity order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_uidvalidity,
           (array_agg(uid order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_uid,
           (array_agg(id order by at desc, folder_id desc, uidvalidity desc, uid desc, id desc))[1] as last_message_id
      from msgs
     group by account_id, tkey
  ),
  rebuilt as (
  select r.account_id,
         r.tkey as thread_key,
         coalesce(r.subject, '') as subject,
         coalesce(p.participants, '[]'::jsonb) as participants,
         greatest(0, coalesce(p.participant_count, 0) - email.participants_cap()) as participants_overflow,
         r.first_at,
         r.last_at,
         r.message_count,
         r.last_direction,
         r.last_folder_id,
         r.last_uidvalidity,
         r.last_uid,
         r.last_message_id,
         case
           when r.message_count = 1
            and r.last_direction = 'in'
            and r.last_at < seeded_at - interval '30 days'
            and exists (
              select 1 from email.policies pol
               where pol.revoked_at is null
                 and pol.scope = 'sender'
                 and pol.action = 'ignore'
                 and pol.matcher = r.last_sender
                 and (pol.account_id is null or pol.account_id = r.account_id)
            )
             then 'closed'
           when r.last_direction = 'out' then 'waiting-on-them'
           else 'waiting-on-me'
         end as state
    from rolled r
    left join parts p on p.account_id = r.account_id and p.tkey = r.tkey
  ),
  written as (
    insert into email.threads
      (account_id, thread_key, subject, participants, participants_overflow, first_at, last_at,
       message_count, last_direction, last_folder_id, last_uidvalidity, last_uid, last_message_id, state, created_at)
    select account_id, thread_key, subject, participants, participants_overflow, first_at, last_at,
           message_count, last_direction, last_folder_id, last_uidvalidity, last_uid, last_message_id, state, seeded_at
      from rebuilt
    -- Idempotent: a thread that already exists keeps what ingest has been
    -- maintaining, which is newer than anything this function could rebuild.
    on conflict (account_id, thread_key) do nothing
    returning 1
  )
  select count(*)::int into inserted from written;

  -- Every message points at its thread, including the ones whose thread was
  -- already there.
  update email.messages m
     set thread_id = t.id
    from email.threads t
   where t.account_id = m.account_id
     and t.thread_key = coalesce(nullif(m.thread_key, ''), 'message:' || m.id::text)
     and (m.thread_id is null or m.thread_id <> t.id);

  return inserted;
end;
$$ language plpgsql;

select backfill_threads();

-- 4 ------------------------------------------------------- thread policies
--
-- The gate's `thread` scope now matches the thread's id rather than the
-- `thread_key` a sender writes. A rule the owner already wrote named the key,
-- so it is re-pointed at the thread it was always about; one that names a
-- conversation this installation does not hold is left exactly as it is, where
-- it matches nothing and is visible on the settings page.
--
-- A *global* thread policy (`account_id is null`) is the one case a plain
-- rename cannot handle: `thread_key` is only unique per account, so the same
-- root Message-ID can be the key of a thread in two different accounts, and a
-- thread's id is account-local — one global row cannot name both. Renaming it
-- in place would leave Postgres to pick one of the matching threads
-- arbitrarily and silently narrow "every account" down to whichever thread
-- won the join. Instead, expand: for every live global thread policy, insert
-- one account-scoped copy — same action, params, origin, proposed flag and
-- history — per thread it currently matches, already pointed at that thread's
-- id, and revoke the global row. The revoked row stays as the record that a
-- global rule once existed; its effect now lives in the per-account rows.
--
-- A function, for the same reason `backfill_threads` is one: the test suite
-- exercises the migration's own code on fixtures of its own, rather than a
-- copy that can drift.
create or replace function expand_global_thread_policies() returns integer as $$
declare
  expanded integer;
  target record;
  winner record;
begin
  expanded := 0;
  -- Reconcile one account/thread at a time. An account-scoped decision is
  -- more specific than a global one; among equally specific decisions the
  -- newest is the gate's winner. Losers are revoked before the winner is
  -- pointed at the UUID, so the live-policy unique index is never crossed.
  for target in
    select distinct t.id, t.account_id, t.thread_key
      from email.threads t
      join email.policies p
        on p.scope = 'thread' and p.revoked_at is null
       and (lower(p.matcher) = lower(t.thread_key) or p.matcher = t.id::text)
       and (p.account_id is null or p.account_id = t.account_id)
  loop
    select p.* into winner
      from email.policies p
     where p.scope = 'thread' and p.revoked_at is null
       and (lower(p.matcher) = lower(target.thread_key) or p.matcher = target.id::text)
       and (p.account_id is null or p.account_id = target.account_id)
     order by (p.account_id is not null) desc, p.created_at desc, p.id desc
     limit 1;

    update email.policies p set revoked_at = now()
     where p.scope = 'thread' and p.revoked_at is null
       and p.account_id = target.account_id
       and (lower(p.matcher) = lower(target.thread_key) or p.matcher = target.id::text)
       and p.id <> winner.id;

    if winner.account_id is null then
      insert into email.policies
        (account_id, scope, matcher, action, params, origin, proposed, created_from, created_at)
      values
        (target.account_id, 'thread', target.id::text, winner.action, winner.params,
         winner.origin, winner.proposed, winner.created_from, winner.created_at);
      expanded := expanded + 1;
    elsif winner.matcher <> target.id::text then
      update email.policies set matcher = target.id::text where id = winner.id;
      expanded := expanded + 1;
    end if;
  end loop;

  -- A global row is superseded only after every account it covered has its
  -- winning scoped row. A rerun sees UUID-scoped rows only and changes none.
  update email.policies p set revoked_at = now()
   where p.scope = 'thread' and p.revoked_at is null and p.account_id is null
     and exists (select 1 from email.threads t where lower(t.thread_key) = lower(p.matcher));

  update email.threads t
     set policy_id = p.id
    from email.policies p
   where p.scope = 'thread'
     and p.revoked_at is null
     and p.matcher = t.id::text
     and p.account_id = t.account_id
     and t.policy_id is null;

  return expanded;
end;
$$ language plpgsql;

select expand_global_thread_policies();
