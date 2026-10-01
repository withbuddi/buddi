-- Rules that keep themselves, and the facts they are decided on
-- (docs/email.md §5, "What keeps itself"; search_path = email, public).
--
--  - `messages.bulk`: the message carried `List-Unsubscribe`, or
--    `Precedence: bulk | list | junk`. Read at ingest from the headers; a
--    message stored before this column is false, and the learning also counts
--    `list_id` (already stored) and a no-reply address as bulk.
--  - `policies.kept_by`: who kept a learned rule — the owner from Settings →
--    Proposals, or the plugin itself (`auto`) under its own rule. The Mail
--    page's Learned list reads the `auto` ones.
--  - `policies.proposal_id`: the `core.proposals` card the rule came from, so
--    an Undo on the Learned list can turn it into the owner's discard.
--  - `policies.auto_reason`: why it kept itself (`bulk`, `track-record`).

alter table messages add column if not exists bulk boolean not null default false;

alter table policies add column if not exists kept_by text null;
alter table policies add column if not exists proposal_id uuid null;
alter table policies add column if not exists auto_reason text null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'policies_kept_by_check') then
    alter table policies add constraint policies_kept_by_check check (kept_by in ('owner', 'auto'));
  end if;
end $$;

update policies set kept_by = 'owner' where kept_by is null and kept_at is not null;

create index if not exists policies_kept_auto_idx on policies (kept_at desc) where kept_by = 'auto';
