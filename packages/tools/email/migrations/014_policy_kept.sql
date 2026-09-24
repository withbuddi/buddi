-- When the owner kept a learned rule from Settings → Proposals.
--
-- A kept rule is written when the owner keeps its card, so `created_at` is
-- already the moment it started deciding — but the rules list could not tell
-- it from a rule learned days ago and kept the old way, and it read as one
-- more line under "learned 2 days ago". `kept_at` is the fact the list sorts
-- and speaks by: "kept 7 minutes ago", at the top.
--
-- Null for a rule the owner wrote themselves and for rules kept before this
-- column existed through the old in-page Keep. Rules kept through core's
-- Proposals inbox before now are found by their kept card: same plugin, same
-- matcher, decided within a minute of the row being written.

alter table policies add column if not exists kept_at timestamptz null;

do $$
begin
  if to_regclass('core.proposals') is not null then
    update email.policies p
       set kept_at = pr.decided_at
      from core.proposals pr
     where p.kept_at is null
       and p.origin = 'learned'
       and p.proposed = false
       and pr.kind = 'policy'
       and pr.state = 'kept'
       and pr.payload->>'plugin' = 'email'
       and pr.payload->'matcher'->>p.scope = p.matcher
       and pr.decided_at is not null
       and abs(extract(epoch from (p.created_at - pr.decided_at))) < 60;
  end if;
end $$;
