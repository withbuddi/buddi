-- Policies, the gate's ledger, and the backfill (search_path = email, public).
--
-- docs/email.md §3 and §5. The principle underneath: **a decision is made
-- once**. A verdict the owner (or the model, three times running) reached about
-- a sender becomes a row here, and the next message from that sender is handled
-- by the row instead of by a model run. Nothing in this file decides anything;
-- it stores what was decided and what the gate then did about it.
--
-- Two tables and one function:
--
--  * `policies` — the decision. Scoped (thread, sender, list-id, domain), with
--    an action, its parameters, where it came from, and whether it has been
--    revoked. `origin = learned` with `proposed = true` is a *suggestion*: the
--    gate ignores it until the owner keeps it, and everything learned is one.
--  * `events` — what the gate did to each message. The owner can audit the
--    silence: "no run happened for this message, and here is the policy that
--    is why". One row per gate decision, including the decisions that matched
--    nothing, because "nothing matched and a run happened" is also an answer.
--  * `seed_learned_ignore_policies()` — the backfill, run once below and
--    re-runnable (it is idempotent: a live policy for a sender stops it). It is
--    a SQL function rather than a `do` block precisely so the test suite can
--    call the same code the migration called, on fixtures of its own.

-- List-Id, for the scope of the same name. Null on every row ingested before
-- this column existed, and that is the honest value — the header was never
-- recorded, which is not the same as the message not having carried one.
alter table messages add column if not exists list_id text null;
create index if not exists messages_list_id_idx on messages (list_id) where list_id is not null;

create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  -- Null means "every account on this installation". One account exists today;
  -- the column is here so that plural accounts do not need a second migration
  -- to scope a policy to one mailbox.
  account_id uuid null references accounts (id) on delete cascade,
  scope text not null check (scope in ('thread', 'sender', 'list-id', 'domain')),
  -- What the scope is matched against: a thread_key, a bare address, a
  -- normalized List-Id, or a domain. Stored lowercased by the writer.
  matcher text not null,
  action text not null check (
    action in ('ignore', 'archive', 'label', 'notify', 'draft', 'hand-to-agent', 'wake')
  ),
  -- Action parameters: the label name, the agent id, the drafting instruction,
  -- the category and urgency an `ignore` writes into its triage row.
  params jsonb not null default '{}'::jsonb,
  origin text not null check (origin in ('owner', 'learned', 'plugin')),
  -- A learned policy is a proposal until the owner keeps it. The gate reads
  -- only rows with `proposed = false`. An owner's own policy is never proposed.
  proposed boolean not null default false,
  -- The verdicts this was learned from: `[{ "messageId": ..., "processingVersion": ... }]`.
  -- Empty for a policy the owner wrote themselves.
  created_from jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  -- Revoking never deletes. The row is the record that the owner once decided
  -- this, and a deleted row would let the same policy be learned again
  -- tomorrow as though it had never been argued with.
  revoked_at timestamptz null
);

-- One live policy per (account, scope, matcher). A revoked row does not hold
-- the slot, so revoking and deciding again is one insert.
create unique index if not exists policies_live_idx
  on policies (
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope,
    matcher
  )
  where revoked_at is null;

create index if not exists policies_scope_idx on policies (scope, matcher) where revoked_at is null;

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  -- The message the gate decided about. Cascades: an event about a message
  -- that no longer exists is not evidence of anything.
  message_id uuid not null references messages (id) on delete cascade,
  -- Null when nothing matched, or when the policy has since been deleted
  -- outright (revocation keeps the row, so this stays set in the ordinary case).
  policy_id uuid null references policies (id) on delete set null,
  -- What was done: the action taken, 'none' when no policy matched, or
  -- 'refused' when a stored action this build cannot perform was skipped.
  action text not null,
  -- One line, owner-facing, saying it in words.
  detail text not null default '',
  at timestamptz not null default now()
);

create index if not exists events_message_idx on events (message_id);
create index if not exists events_policy_idx on events (policy_id, at desc);
create index if not exists events_at_idx on events (at desc);

-- The bare address inside a From header, lowercased. `from_addr` is normalized
-- on ingest, but rows are history and some of them predate that.
create or replace function address_of(raw text) returns text as $$
  select lower(trim(both '"' from coalesce(substring(coalesce(raw, '') from '<([^>]+)>'), coalesce(raw, ''))));
$$ language sql immutable;

/*
 * Seed learned `ignore` policies from the verdicts this installation already
 * holds (docs/email.md §3).
 *
 * The rule, exactly: a sender whose **three most recent verdicts running** are
 * all `promo` or all urgency `low`, and to whom the owner has **never sent
 * anything**. Consecutive matters — a sender judged promo, promo, reply-needed,
 * promo is a sender the owner may well hear from, and a policy that silenced
 * them would be learned from a coincidence rather than from a pattern.
 *
 * "No reply from the owner" is derived from the rows that exist today: a draft
 * addressed to that sender with `sent_at` set. A draft never sent is not a
 * reply — it is the owner deciding not to answer, which argues *for* the
 * policy, not against it.
 *
 * **Every seed is `proposed = true`.** It cannot be otherwise while only INBOX
 * is polled (docs/email.md §3): the owner's Sent folder is not read, so a
 * sender answered from a phone, from Gmail or from any other client looks here
 * like a sender who was never answered, and a backfill that applied itself
 * would silence people the owner has been talking to for years. The seeds are
 * listed under "Learned, proposed" on the settings page and the owner applies
 * them there, one tap each. When step 3 syncs Sent and reply history becomes a
 * fact rather than an inference, this can be revisited.
 */
create or replace function seed_learned_ignore_policies(seeded_at timestamptz default now())
  returns integer as $$
declare
  inserted integer;
begin
  with latest as (
    -- The current verdict per message: `processing_version desc` is what makes
    -- a re-triage win over the decision it replaced.
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
  -- Where the run of promo/low verdicts stops, counting back from the newest.
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
       -- Never silence somebody the owner has written to.
       and not exists (
         select 1 from email.drafts d
          where d.sent_at is not null
            and exists (
              select 1 from jsonb_array_elements_text(d.to_addrs) as a(addr)
               where email.address_of(a.addr) = s.sender
            )
       )
       -- Idempotent: a live policy for this sender already says it.
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
           -- Proposed, never applied. See the note above.
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

select seed_learned_ignore_policies();
