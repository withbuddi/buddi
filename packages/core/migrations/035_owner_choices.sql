-- Owner choices on an approval, and the state for an effect that never ran.
--
-- ## Choices
--
-- "What is approved is what is shown" has always meant the owner may only
-- authorize the exact effect the tool described. It did not mean the owner had
-- nothing to say. A send whose account has three aliases is one effect with
-- three honest shapes, and until now the only way to offer them was a sentence
-- in the preview asking the owner to go and ask the agent again.
--
-- So an action may carry `choices`: a list of `{key, label, options, default}`
-- the *tool* declared at describe time, and the approval may carry the
-- `owner_choices` the owner picked from them. Two columns, and the rule that
-- makes them safe is in core rather than in any tool: a submitted key must be
-- one of the declared keys and a submitted value must be one of that key's
-- declared options. Nothing else is written.
--
-- `choices` is part of the action object, so it is part of what the args hash
-- binds — an approval cannot be replayed against a different set of options
-- than the one the owner was shown. Existing rows carry `[]` and hash exactly
-- as they did before (see `hashAction`), so every approval already waiting
-- stays valid.
alter table core.actions add column if not exists choices jsonb not null default '[]'::jsonb;

-- What the owner picked, validated against the declared list at decision time.
-- Null on every approval that was never offered a choice, which is almost all
-- of them, and `{}` is a real (if empty) answer rather than "not asked".
alter table core.approvals add column if not exists owner_choices jsonb null;

-- ## `refused`
--
-- `failed` used to mean two different things: an effect that was dispatched and
-- threw, and an effect that was never dispatched at all because the thing the
-- owner approved is no longer the thing that would happen. Those are not the
-- same fact for the owner and they are not the same fact for an agent reading
-- the outcome: the first may have half-happened, the second certainly did not.
--
-- `refused` is the second. It is terminal, it carries the reason in `outcome`,
-- and it is only ever reached before a single byte leaves the machine — there
-- is no effect-attempt row under it, because nothing was attempted.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'approvals_state_check') then
    alter table core.approvals drop constraint approvals_state_check;
  end if;
  alter table core.approvals add constraint approvals_state_check
    check (state in ('pending', 'approved', 'rejected', 'expired', 'executing',
                     'succeeded', 'failed', 'refused', 'unknown'));
end
$$;
