-- The prompt limit an mlxh account is held to, as its probe last said:
-- `max_prompt_tokens`, 0 when the server turned the limit off, null when it was
-- never probed (mlxh's default applies). Its own column, so
-- reported_context_windows holds only model ids and their windows.
alter table core.provider_accounts add column mlxh_prompt_limit integer
  check (mlxh_prompt_limit is null or mlxh_prompt_limit >= 0);

-- A build before this one kept the limit in the map under a reserved key.
update core.provider_accounts
   set mlxh_prompt_limit = case when jsonb_typeof(reported_context_windows -> '#mlxh:max_prompt_tokens') = 'number'
                                 and (reported_context_windows ->> '#mlxh:max_prompt_tokens')::numeric >= 0
                                 and (reported_context_windows ->> '#mlxh:max_prompt_tokens')::numeric <= 2147483647
                                then floor((reported_context_windows ->> '#mlxh:max_prompt_tokens')::numeric)::integer end,
       reported_context_windows = reported_context_windows - '#mlxh:max_prompt_tokens'
 where reported_context_windows ? '#mlxh:max_prompt_tokens';
