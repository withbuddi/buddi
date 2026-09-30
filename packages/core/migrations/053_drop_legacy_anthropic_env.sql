-- buddi no longer reads Anthropic credentials from `.env` or the vault under
-- their old global names: Anthropic comes in only as a named model account.
-- The two accounts the legacy-v1 migration seeded from those variables, and
-- the subscription-token auth only they used, go; so do the agent bindings
-- that point at them (the foreign key is `on delete restrict`), which leaves
-- those agents asking for an account in Settings rather than failing to load.

delete from core.agent_provider_accounts
 where account_id in (
   select id from core.provider_accounts
    where id in ('legacy-anthropic-api', 'legacy-anthropic-subscription')
       or auth = 'legacy-subscription-token'
 );

-- Plugin bindings have no foreign key (040); one to a gone account binds nothing.
delete from core.plugin_account_bindings
 where account_id in ('legacy-anthropic-api', 'legacy-anthropic-subscription');

delete from core.provider_accounts
 where id in ('legacy-anthropic-api', 'legacy-anthropic-subscription')
    or auth = 'legacy-subscription-token';

alter table core.provider_accounts drop constraint provider_accounts_auth_check;
alter table core.provider_accounts add constraint provider_accounts_auth_check
  check (auth in ('api-key','none','chatgpt','anthropic-oauth','device-key'));

-- Only OpenAI's key is still a global credential with a tombstone.
delete from core.provider_credential_state where name <> 'OPENAI_API_KEY';
alter table core.provider_credential_state drop constraint provider_credential_state_name_check;
alter table core.provider_credential_state add constraint provider_credential_state_name_check
  check (name = 'OPENAI_API_KEY');
