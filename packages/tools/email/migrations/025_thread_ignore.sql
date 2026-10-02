-- A thread ignore rule matches the conversation it names (docs/email.md §2,
-- "Needs you"; search_path = email, public).
--
-- 023 compared a `thread` policy's matcher with `threads.thread_key`, the
-- root Message-ID, but the matcher is the conversation's row id (the page
-- sends it, the gate matches it), so a thread the owner ignored still showed
-- as needing him. Same function, the comparison fixed, and bound the way the
-- policy gate binds a thread ignore: only for the sender recorded with it.

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
               -- By the conversation's own id, as the page stores it, and
               -- only for the sender recorded with the rule: a message joins
               -- a thread through headers its sender writes (`gate.ts`,
               -- `ignoreIsCorroborated`). Without a recorded sender a thread
               -- rule silences nothing the sender/domain lines do not.
               or (p.scope = 'thread'
                   and lower(trim(p.matcher)) = t.id::text
                   and coalesce(p.params->>'sender', '') <> ''
                   and email.address_of(p.params->>'sender') = li.addr)
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
