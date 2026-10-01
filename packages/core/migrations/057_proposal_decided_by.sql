-- Who decided a proposal (docs/learning.md §4, "Rules that keep themselves").
--
-- Until now every decision on `core.proposals` was the owner's, or the
-- 30-day sweep's expiry. A plugin may now keep a policy proposal itself when
-- its own rule says so — a bulk sender it only quiets, or a kind of rule the
-- owner has kept five times running — and the row must say so: the owner's
-- track record is counted from the owner's decisions only, and the plugin's
-- "Learned" list reads the ones that kept themselves.
--
--  - `owner`: kept or discarded by the owner (a page, Telegram, an approved
--    MCP call), or a kept one the owner took back.
--  - `auto`: kept by the plugin that proposed it, under its own rule.
--  - null: still open, or expired by the sweep.

alter table core.proposals add column if not exists decided_by text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'proposals_decided_by_check'
  ) then
    alter table core.proposals
      add constraint proposals_decided_by_check check (decided_by in ('owner', 'auto'));
  end if;
end $$;

-- Everything decided before this column existed was decided by the owner.
update core.proposals set decided_by = 'owner'
 where decided_by is null and state in ('kept', 'discarded');

-- The track record reads one plugin's policy proposals of one kind.
create index if not exists proposals_policy_kind_idx
  on core.proposals ((payload->>'plugin'), (payload->>'kind'), decided_at)
  where kind = 'policy';
