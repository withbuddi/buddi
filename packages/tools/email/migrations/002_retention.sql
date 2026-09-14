-- Mail retention (applied with search_path = email, public).
--
-- The mailbox occurrence is kept forever; the *body* is not. Headers, the
-- snippet and what triage decided are small, durable and the part the owner
-- and the agents actually reason over later. The full body is the bulky,
-- attacker-controlled half, and it is the half that ages badly: after the
-- retention window it is nulled out and the row keeps saying it existed.
--
-- Nothing here deletes a row. A purge is one update: `body_text` to null and
-- `body_purged_at` stamped, so "no body" is never confused with "empty mail".

-- Purging sets it to null, so the column can no longer be NOT NULL. Ingest
-- still always writes a (possibly empty) string; null means *purged*.
alter table messages alter column body_text drop not null;

alter table messages add column if not exists body_purged_at timestamptz null;

-- The purge scans by age among the rows that still have a body. Partial, so
-- the index stays the size of the un-purged tail rather than the whole mailbox.
create index if not exists messages_retention_idx
  on messages (coalesce(date, fetched_at))
  where body_purged_at is null;

-- The owner's settings for this plugin, one row per key, jsonb values — the
-- same shape finance uses for its preferences. `retention_days` is the only
-- key today; it is a *number of days*, and `email.set_settings` is how the
-- owner changes it from a chat rather than by editing a file.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
