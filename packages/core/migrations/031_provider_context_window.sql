-- What the owner says a provider's models can hold, when they know better.
--
-- The conversation lifetime sizes a transcript against the bound model's
-- context window (`packages/runtime/src/context-window.ts`). That table is a
-- fallback: no provider serves its window over the wire in a shape worth
-- depending on, and a locally served model holds whatever the host was started
-- with — an Ollama `num_ctx` of 8k or of 256k, with the same model name either
-- way. This column is where an owner says so, per provider, in tokens.
--
-- Null means "use the table", which is the answer for everyone who never
-- touches it. The bounds are sanity, not policy: outside them the table wins.
alter table core.provider_settings
  add column if not exists context_window_tokens integer
    check (context_window_tokens is null
           or (context_window_tokens >= 8000 and context_window_tokens <= 2000000));
