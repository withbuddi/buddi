-- Whether a conversation needs the owner (docs/email.md §2, "Needs you";
-- search_path = email, public).
--
-- `threads.state` stays the fact — who wrote last. This is the judgement made
-- over it, in one place, so the Mail page, the "Waiting on you" widget, the
-- watcher, the metric and the agents' tools all count the same conversations.
-- `needs-you.ts` is the TypeScript side: the reason codes in words, and the
-- same sender pattern for anything that has an address but no row.
--
-- The rule, for a thread whose state is `waiting-on-me`, read off its newest
-- inbound message (by INTERNALDATE, `fetched_at` as fallback):
--
--   no-reply  the sender is an address nobody reads (`is_notification_address`)
--   bulk      the message was sent to many: List-Unsubscribe / Precedence
--             (`messages.bulk`) or a List-Id
--   ignored   a live ignore rule the owner kept covers its sender, domain,
--             list or thread
--   stale     it arrived more than 30 days before `p_now`, or its messages
--             have aged out: history, not a conversation waiting
--   known     the owner has written to this sender before, from this mailbox
--   asked     the latest triage verdict on that message is `reply-needed`
--   stranger  none of the above: somebody wrote, no reply is expected
--
-- checked in that order. Needs you = `known` or `asked`. Any other state
-- answers its own name (`waiting-on-them`, `muted`, `closed`).

create or replace function is_notification_address(raw text) returns boolean as $$
  select coalesce(
    split_part(email.address_of(raw), '@', 1)
      ~ '(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster|bounces?|notifications?|automated)($|[._+-])'
    or split_part(split_part(email.address_of(raw), '@', 2), '.', 1)
      ~ '^(no[._-]?reply|do[._-]?not[._-]?reply)$',
    false);
$$ language sql immutable;

/** How many days a waiting conversation stays news. `STALE_WAITING_DAYS` in watchers.ts. */
create or replace function attention_window_days() returns integer as $$
  select 30;
$$ language sql immutable;

create or replace function thread_attention(p_thread uuid, p_now timestamptz)
returns table (needs_you boolean, reason text, inbound_id uuid, inbound_at timestamptz)
as $$
  with t as (
    select id, account_id, thread_key, state from email.threads where id = p_thread
  ),
  li as (
    select m.id, m.account_id, m.from_addr, email.address_of(m.from_addr) as addr,
           coalesce(m.bulk, false) or m.list_id is not null as bulk, m.list_id,
           coalesce(m.internal_date, m.fetched_at) as at
      from email.messages m
      join t on m.thread_id = t.id
     where m.direction = 'in'
     order by coalesce(m.internal_date, m.fetched_at) desc, m.id desc
     limit 1
  ),
  r as (
    select li.id as inbound_id, li.at as inbound_at,
      case
        when t.state <> 'waiting-on-me' then t.state
        when li.id is not null and email.is_notification_address(li.addr) then 'no-reply'
        when li.bulk then 'bulk'
        when li.id is not null and exists (
          select 1 from email.policies p
           where p.revoked_at is null
             and p.proposed = false
             and p.action = 'ignore'
             and (p.account_id is null or p.account_id = li.account_id)
             and (
               (p.scope = 'sender' and p.matcher = li.addr)
               or (p.scope = 'domain' and p.matcher = split_part(li.addr, '@', 2))
               or (p.scope = 'list-id' and li.list_id is not null and p.matcher = li.list_id)
               or (p.scope = 'thread' and p.matcher = t.thread_key)
             )
        ) then 'ignored'
        when li.id is null
          or li.at < p_now - make_interval(days => email.attention_window_days()) then 'stale'
        when exists (
          select 1 from email.messages o
           where o.account_id = li.account_id
             and o.direction = 'out'
             and (
               exists (select 1 from jsonb_array_elements_text(coalesce(o.to_addrs, '[]'::jsonb)) as a(addr)
                        where email.address_of(a.addr) = li.addr)
               or exists (select 1 from jsonb_array_elements_text(coalesce(o.cc, '[]'::jsonb)) as a(addr)
                           where email.address_of(a.addr) = li.addr)
             )
        ) then 'known'
        when (
          select tr.category from email.triage tr
           where tr.message_id = li.id
           order by tr.decided_at desc, tr.processing_version desc
           limit 1
        ) = 'reply-needed' then 'asked'
        else 'stranger'
      end as reason
      from t left join li on true
  )
  select reason in ('known', 'asked'), reason, inbound_id, inbound_at from r;
$$ language sql stable;
