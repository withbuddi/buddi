-- The sender's domain, when the receiving server vouched for it
-- (docs/email.md §7, suspicious-sender; search_path = email, public).
--
-- Read at ingest from the first `Authentication-Results` header — the one the
-- owner's own mail server added on top; any the sender wrote sit below it and
-- are never read — and kept only when DMARC passed for the From domain, or
-- DKIM or SPF passed for a domain aligned with it. Null is "not vouched for",
-- which includes all mail stored before this column existed.
alter table messages add column if not exists auth_domain text;
