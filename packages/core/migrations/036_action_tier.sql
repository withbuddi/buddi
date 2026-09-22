-- The tier an action was created under.
--
-- Until now the tier was a property of the *tool*, so the action did not have
-- to say it: `email.send` is gated, was gated, and will be gated. Then
-- `ToolDefinition.tierFor` made the tier a property of the **call** — the same
-- `developer.run` is auto for `ls` and gated for `npm install` — and "which
-- tier was this recorded under" stopped being something a reader could work
-- out from the tool's declaration alone.
--
-- So it is written down. Two things follow from it:
--
--  * The Executor asserts it. An action that reaches `executeApproved` must
--    say `gated`, because that is the only tier that produces an action at
--    all; anything else is a defect somewhere upstream, and it settles without
--    dispatch rather than running.
--  * It is inside the args hash (see `hashAction`), so an approval cannot be
--    replayed as though it had been created under a different rule.
--
-- Nullable, with no default, and folded into the hash *only when present*:
-- every approval already waiting for the owner was created before this column
-- existed, hashes to exactly the value it hashed to then, and stays valid.
alter table core.actions add column if not exists tier text null;

alter table core.actions drop constraint if exists actions_tier_check;

alter table core.actions add constraint actions_tier_check
  check (tier is null or tier in ('auto', 'draft', 'gated', 'session'));
