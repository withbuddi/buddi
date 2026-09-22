-- The draft lifecycle (docs/specs/email.md §8), applied with search_path = email, public.
--
-- A draft used to be a row with one piece of state: `sent_at`, null or not. It
-- is now a small lifecycle, because the owner is in it:
--
--   draft -> edited -> sent | discarded | lapsed
--
-- `draft` is what an agent wrote. `edited` is what the *owner* wrote over it,
-- and it is the one status an agent may not overwrite: `email.draft_reply` on a
-- thread whose live draft the owner has edited refuses to replace it and says
-- to read it first. `sent` is the terminal success and is exactly what
-- `sent_at is not null` already meant. `discarded` is the owner saying no.
-- `lapsed` is time saying no: a live draft nobody touched for a fortnight stops
-- being a thing the owner is expected to decide about.
--
-- Nothing here destroys a row. A discarded or lapsed draft is still readable,
-- still points at its artifact, and is still refused by `email.send` at
-- describe time — which is the point: a refusal the owner can read beats a
-- missing row they cannot.

-- The lifecycle column. `draft` for everything that was never sent, which is
-- what every stored row without `sent_at` already was.
alter table drafts add column if not exists status text not null default 'draft';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'drafts_status_check') then
    alter table drafts add constraint drafts_status_check
      check (status in ('draft', 'edited', 'sent', 'discarded', 'lapsed'));
  end if;
end
$$;

-- The backfill: a row that was sent says so. `sent_at is not null` was the only
-- statement of it there has ever been, so it is the only evidence trusted here.
update drafts set status = 'sent' where sent_at is not null and status <> 'sent';

-- When this draft last changed — written, edited, or claimed by a send. It is
-- what the fortnight of `lapsed` is measured from, so it defaults to `now()`
-- rather than to `created_at`: a row that existed before this migration has not
-- been looked at by the new lifecycle yet, and starting its clock in the past
-- would lapse the owner's live drafts on the first sweep after an upgrade.
alter table drafts add column if not exists updated_at timestamptz not null default now();

alter table drafts add column if not exists discarded_at timestamptz null;
alter table drafts add column if not exists lapsed_at timestamptz null;

-- Who wrote the current body. Null while it is the authoring agent's words;
-- `owner` once the owner has saved over them. It is a separate column from
-- `status` on purpose: `status` is where the draft is in its life, and this is
-- whose words are in it, and a later "edited by another agent" must not have to
-- borrow a status to say so.
alter table drafts add column if not exists edited_by text null;

-- The conversation this draft belongs to. Derived from `in_reply_to` — the
-- message being answered already knows its thread — and null for a
-- `draft_new`, which answers nothing and therefore has no conversation until
-- it is sent. It is a stored column rather than a join because the live-draft
-- lookup on every `draft_reply` and every thread view is by thread, and a
-- two-hop join through `messages` for that is a join per draft per page.
alter table drafts add column if not exists thread_id uuid null
  references threads (id) on delete set null;

update drafts d
   set thread_id = m.thread_id
  from messages m
 where d.in_reply_to = m.id
   and d.thread_id is null
   and m.thread_id is not null;

-- The one query the lifecycle adds: "does this conversation already have a live
-- draft?" — asked by `draft_reply` before it writes and by the thread view
-- before it draws. Partial, because a thread accumulates sent drafts forever
-- and none of them is an answer to that question.
create index if not exists drafts_live_thread_idx on drafts (thread_id)
  where status in ('draft', 'edited');

-- The lapse sweep's own read: live drafts by age, across every thread.
create index if not exists drafts_live_updated_idx on drafts (updated_at)
  where status in ('draft', 'edited');
