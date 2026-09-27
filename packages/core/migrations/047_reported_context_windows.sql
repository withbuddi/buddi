-- What each model holds, by the provider's own model list (the ChatGPT backend
-- says `context_window` per model). A map model id -> tokens, filled whenever a
-- model list is fetched for the account. The owner's `context_window_tokens`
-- still wins; this only replaces buddi's guess from the model name.
alter table core.provider_accounts add column reported_context_windows jsonb not null default '{}'::jsonb;
