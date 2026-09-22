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
--     owner sent. Derived at ingest from whether the From is the account's own
--     address or one of its aliases, and backfilled the same way below.
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
  participants jsonb not null default '[]'::jsonb,
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
  created_at timestamptz not null default now(),
  unique (account_id, thread_key)
);

create index if not exists threads_state_idx on threads (account_id, state, last_at desc nulls last);
create index if not exists threads_last_at_idx on threads (last_at desc nulls last);

alter table messages add column if not exists thread_id uuid null
  references threads (id) on delete set null;

-- `in` is the right default for every row already stored: only INBOX was ever
-- polled, so everything here arrived. The backfill below corrects the few that
-- are the owner's own mail, and ingest sets it explicitly from now on.
alter table messages add column if not exists direction text not null default 'in';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_direction_check') then
    alter table messages add constraint messages_direction_check check (direction in ('in', 'out'));
  end if;
end
$$;

create index if not exists messages_thread_id_idx on messages (thread_id);
create index if not exists messages_direction_idx on messages (account_id, direction);

-- The union of two participant lists, sorted, without duplicates. A function
-- rather than an inline sub-select because `on conflict do update` is where it
-- is used, and that clause is no place for a subquery.
create or replace function merge_participants(a jsonb, b jsonb) returns jsonb as $$
  select coalesce(jsonb_agg(distinct value order by value), '[]'::jsonb)
    from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb));
$$ language sql immutable;

-- 3 ---------------------------------------------------------------- backfill
--
-- A function rather than a `do` block, for the same reason `004` made its seed
-- one: the test suite calls the code the migration called, on fixtures of its
-- own, instead of a copy of it that can drift.

/*
 * `out` is mail the owner sent: the From is the account's own address, or one
 * of the aliases it receives (and therefore sends) as. Nothing else is
 * evidence — a From header is a string anybody can write, and this is why the
 * *folder* is what decides direction at ingest from now on.
 */
create or replace function backfill_message_direction() returns integer as $$
declare
  touched integer;
begin
  with fixed as (
    update email.messages m
       set direction = 'out'
      from email.accounts a
     where a.id = m.account_id
       and m.direction <> 'out'
       and (
         email.address_of(m.from_addr) = lower(a.address)
         or email.address_of(m.from_addr) = any (select lower(x) from unnest(a.aliases) as x)
       )
    returning 1
  )
  select count(*)::int into touched from fixed;
  return touched;
end;
$$ language plpgsql;

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
  perform email.backfill_message_direction();

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
           coalesce(m.date, m.fetched_at) as at
      from email.messages m
  ),
  parts as (
    select g.account_id,
           g.tkey,
           jsonb_agg(distinct p.addr) as participants
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
    select account_id,
           tkey,
           (array_agg(subject order by at asc, uid asc))[1] as subject,
           min(at) as first_at,
           max(at) as last_at,
           count(*)::int as message_count,
           (array_agg(direction order by at desc, uid desc))[1] as last_direction,
           (array_agg(email.address_of(from_addr) order by at desc, uid desc))[1] as last_sender
      from msgs
     group by account_id, tkey
  ),
  rebuilt as (
  select r.account_id,
         r.tkey as thread_key,
         coalesce(r.subject, '') as subject,
         coalesce(p.participants, '[]'::jsonb) as participants,
         r.first_at,
         r.last_at,
         r.message_count,
         r.last_direction,
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
      (account_id, thread_key, subject, participants, first_at, last_at,
       message_count, last_direction, state, created_at)
    select account_id, thread_key, subject, participants, first_at, last_at,
           message_count, last_direction, state, seeded_at
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
update policies p
   set matcher = t.id::text
  from threads t
 where p.scope = 'thread'
   and p.revoked_at is null
   and lower(p.matcher) = lower(t.thread_key)
   and (p.account_id is null or p.account_id = t.account_id);

update threads t
   set policy_id = p.id
  from policies p
 where p.scope = 'thread'
   and p.revoked_at is null
   and p.matcher = t.id::text
   and t.policy_id is null;
