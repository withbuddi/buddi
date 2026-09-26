-- Ollama Cloud connected with a device key (specs/ollama-connect.md): the key
-- pair stays in the vault; the row only says how the account signs in.
alter table core.provider_accounts drop constraint provider_accounts_auth_check;
alter table core.provider_accounts add constraint provider_accounts_auth_check
  check (auth in ('api-key','none','legacy-subscription-token','chatgpt','anthropic-oauth','device-key'));
alter table core.provider_accounts add constraint provider_accounts_device_key_check
  check (auth <> 'device-key' or (kind = 'openai-compatible' and base_url = 'https://ollama.com/v1'));
