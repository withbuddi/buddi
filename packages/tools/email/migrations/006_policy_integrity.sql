-- What the gate's rows have to guarantee (search_path = email, public).
--
-- Three corrections, each of them a thing the previous migrations left as a
-- convention rather than as a constraint. A convention is something a later
-- caller can be wrong about; the point of this file is that they now cannot.
--
--  1. **One vault name, one account.** `secret_name` was derived from the
--     address by flattening every non-alphanumeric run to `_`, which is not
--     injective: `a-b@example.test` and `a.b@example.test` both became
--     `EMAIL_A_B_EXAMPLE_TEST`. Two rows sharing one name means adding the
--     second account overwrites the first's password in the keychain, and
--     removing either deletes the other's. The name now carries a hash of the
--     address (`config.ts`), and the unique index below is what makes the
--     collision impossible rather than merely unlikely.
--  2. **An event is one message's decision, and it says how far it got.**
--     `status` distinguishes a decision that was carried out from one that is
--     still being enqueued and from one whose enqueue threw. And one row per
--     message: a message the poll picks up again because it was never stamped
--     is the same decision being made again, not a second one, so the retry
--     updates the row instead of adding to it.
--  3. **Nothing learned applies itself.** docs/specs/email.md §3: only INBOX is
--     polled, so "the owner never wrote back" is inferred from drafts buddi
--     itself sent and not from the owner's Sent folder. Any learned ignore an
--     earlier build applied on that inference becomes a proposal again, listed
--     under "Learned, proposed" for the owner to keep or revoke, and the
--     backfill function is re-created to seed proposals from now on.

-- 1 ----------------------------------------------------------------- secrets
--
-- Rows that already collide are separated first: the newest keeps the name it
-- has (its vault entry is the one that survived the overwrite) and the others
-- are marked so the owner is told to add them again. A silent rename would
-- point a row at a keychain entry that does not exist.
update accounts a
   set secret_name = a.secret_name || '_NEEDS_REENTRY_' || left(replace(a.id::text, '-', ''), 8)
 where exists (
   select 1 from accounts b
    where b.secret_name = a.secret_name
      and b.id <> a.id
      and (b.created_at, b.id) > (a.created_at, a.id)
 );

create unique index if not exists accounts_secret_name_idx on accounts (secret_name);

-- 2 ------------------------------------------------------------------ events
alter table events add column if not exists status text not null default 'done';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_status_check') then
    alter table events
      add constraint events_status_check check (status in ('pending', 'done', 'failed'));
  end if;
end
$$;

-- One row per message. Duplicates from before this constraint are collapsed
-- onto the newest, which is the decision that is actually in force.
delete from events e
 using events keep
 where e.message_id = keep.message_id
   and (keep.at, keep.id) > (e.at, e.id);

create unique index if not exists events_message_unique_idx on events (message_id);

-- 3 --------------------------------------------------------------- proposals
update policies
   set proposed = true
 where origin = 'learned'
   and action = 'ignore'
   and proposed = false
   and revoked_at is null
   and created_from <> '[]'::jsonb;

create or replace function seed_learned_ignore_policies(seeded_at timestamptz default now())
  returns integer as $$
declare
  inserted integer;
begin
  with latest as (
    select distinct on (t.message_id)
           t.message_id,
           m.account_id,
           email.address_of(m.from_addr) as sender,
           t.category,
           t.urgency,
           t.processing_version,
           coalesce(m.date, m.fetched_at) as at
      from email.triage t
      join email.messages m on m.id = t.message_id
     order by t.message_id, t.processing_version desc
  ),
  ranked as (
    select *,
           row_number() over (partition by account_id, sender order by at desc, message_id desc) as k
      from latest
     where sender <> ''
  ),
  broken as (
    select account_id, sender, min(k) as first_other
      from ranked
     where category <> 'promo' and urgency <> 'low'
     group by account_id, sender
  ),
  streaks as (
    select r.account_id,
           r.sender,
           coalesce(b.first_other - 1, (select count(*) from ranked r2
                                         where r2.account_id = r.account_id and r2.sender = r.sender)) as streak
      from (select distinct account_id, sender from ranked) r
      left join broken b on b.account_id = r.account_id and b.sender = r.sender
  ),
  eligible as (
    select s.account_id, s.sender, s.streak
      from streaks s
     where s.streak >= 3
       and not exists (
         select 1 from email.drafts d
          where d.sent_at is not null
            and exists (
              select 1 from jsonb_array_elements_text(d.to_addrs) as a(addr)
               where email.address_of(a.addr) = s.sender
            )
       )
       and not exists (
         select 1 from email.policies p
          where p.revoked_at is null
            and p.scope = 'sender'
            and p.matcher = s.sender
            and (p.account_id is null or p.account_id = s.account_id)
       )
  ),
  seeds as (
    select e.account_id,
           e.sender,
           jsonb_agg(
             jsonb_build_object('messageId', r.message_id, 'processingVersion', r.processing_version)
             order by r.k
           ) as created_from
      from eligible e
      join ranked r on r.account_id = e.account_id and r.sender = e.sender and r.k <= e.streak
     group by e.account_id, e.sender
  ),
  written as (
    insert into email.policies
      (account_id, scope, matcher, action, params, origin, proposed, created_from, created_at)
    select account_id,
           'sender',
           sender,
           'ignore',
           jsonb_build_object('category', 'promo', 'urgency', 'low'),
           'learned',
           -- Proposed, always. Sent is not synced; see 004 and docs/specs/email.md §3.
           true,
           created_from,
           seeded_at
      from seeds
    on conflict do nothing
    returning 1
  )
  select count(*)::int into inserted from written;
  return inserted;
end;
$$ language plpgsql;
