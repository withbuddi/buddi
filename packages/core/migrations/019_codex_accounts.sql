-- Opt-in native client backend. Secret values remain in the existing vault.
alter table core.provider_accounts drop constraint provider_accounts_kind_check;
alter table core.provider_accounts drop constraint provider_accounts_auth_check;
alter table core.provider_accounts add constraint provider_accounts_kind_check
  check (kind in ('anthropic','openai','openai-compatible','codex'));
alter table core.provider_accounts add constraint provider_accounts_auth_check
  check (auth in ('api-key','none','legacy-subscription-token','chatgpt'));
alter table core.provider_accounts add constraint provider_accounts_codex_auth_check
  check ((kind = 'codex') = (auth = 'chatgpt'));
