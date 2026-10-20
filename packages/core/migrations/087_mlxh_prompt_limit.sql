-- The prompt limit an mlxh account is held to, as its probe last said:
-- `max_prompt_tokens`, 0 when the server turned the limit off, null when it was
-- never probed (mlxh's default applies). Its own column, so
-- reported_context_windows holds only model ids and their windows.
alter table core.provider_accounts add column mlxh_prompt_limit integer
  check (mlxh_prompt_limit is null or mlxh_prompt_limit >= 0);
