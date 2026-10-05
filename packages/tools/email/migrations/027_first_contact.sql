-- What a new mailbox left alone when buddi first opened it (docs/email.md;
-- search_path = email, public).
--
-- A first contact plants the inbox cursor at UIDNEXT-1, minus EMAIL_BACKFILL:
-- buddi reads new mail from that moment and never walks the history. The Mail
-- page of a fresh mailbox says so — "Reading new mail from now on; 412 older
-- messages left alone." — and that number is only known at the moment the
-- cursor is planted (the folder's EXISTS, less what the backfill brought), so
-- it is written down then. Null on folders first opened before this column,
-- and on a re-plant after a UIDVALIDITY change, which is not a first contact.

alter table folders add column if not exists first_contact_at timestamptz null;
alter table folders add column if not exists left_alone integer null;
