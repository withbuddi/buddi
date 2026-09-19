-- OAuth envelopes stay in the vault; metadata never contains tokens.
alter table core.provider_accounts drop constraint provider_accounts_auth_check;
alter table core.provider_accounts add constraint provider_accounts_auth_check
  check (auth in ('api-key','none','legacy-subscription-token','chatgpt','anthropic-oauth'));
alter table core.provider_accounts add constraint provider_accounts_anthropic_oauth_check
  check (auth <> 'anthropic-oauth' or kind = 'anthropic');
