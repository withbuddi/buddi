-- Secrets in the sign-in flow (docs/owner-secrets.md §6, "Saved from a
-- conversation"): an agent's `secret.request` card is a question with a
-- request attached — the site, the field labels the agent saw, any warning —
-- never a value. A secret saved from that card remembers the conversation it
-- came from and the set it was saved with, so Keys and secrets links back to
-- the conversation and one approval can cover the whole set.
alter table core.questions add column if not exists request jsonb null;
alter table core.questions drop constraint if exists questions_request_object;
alter table core.questions add constraint questions_request_object check (request is null or jsonb_typeof(request) = 'object');

alter table core.secrets add column if not exists conversation_id uuid null references core.conversations (id) on delete set null;
alter table core.secrets add column if not exists set_id uuid null;
alter table core.secrets add column if not exists site text null;
create index if not exists secrets_set_idx on core.secrets (set_id) where set_id is not null;
