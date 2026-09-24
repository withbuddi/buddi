-- Where the inbox's flag re-sync left off.
--
-- A message's `flags` used to be written once, at ingest, and never again, so
-- a message read on the phone stayed unread here for good. The poll now
-- re-reads FLAGS for the messages it already holds (`sources/inbox-poll.ts`),
-- and on a server that does CONDSTORE (RFC 7162; Gmail does) it asks only for
-- what changed since the HIGHESTMODSEQ it last saw. That value is this column.
--
-- Null means "no incremental answer is possible yet": a folder never re-synced,
-- a server without CONDSTORE, or a UIDVALIDITY change (a modseq belongs to its
-- generation, so re-planting the cursor clears it). Null sends the next poll
-- down the capped full FLAGS fetch, which writes the value when it can.
--
-- bigint, not numeric: RFC 7162 keeps a mod-sequence within 63 bits.

alter table folders add column if not exists highest_modseq bigint null;
