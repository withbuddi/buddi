-- What the owner says one account's models can hold, when they know better.
--
-- The conversation lifetime sizes a transcript against the bound model's
-- context window (`packages/runtime/src/context-window.ts`). That table is a
-- fallback: no provider serves its window over the wire in a shape worth
-- depending on, and a locally served model holds whatever the host was started
-- with — an Ollama `num_ctx` of 8k or of 256k, with the same model name either
-- way.
--
-- It belongs to the *account*, not to the provider: two OpenAI-compatible
-- accounts are two endpoints, and a laptop serving 8k and a hosted endpoint
-- serving 256k are both "openai-compatible". One number for both would
-- overflow the small one on every long conversation.
--
-- Null means "use the table", which is the answer for everyone who never
-- touches it. The bounds are sanity, not policy.
alter table core.provider_accounts
  add column if not exists context_window_tokens integer
    check (context_window_tokens is null
           or (context_window_tokens >= 8000 and context_window_tokens <= 2000000));
