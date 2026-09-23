-- When this mailbox was last read, as opposed to when mail last arrived.
--
-- `max(fetched_at)` over the messages was standing in for both, and they are
-- not the same fact: a poller running perfectly against a quiet mailbox looks,
-- through that lens, exactly like a poller that stopped on Tuesday. A goal
-- that watches the mail has to be able to tell those apart — "0 waiting, read
-- ten minutes ago" is an answer, and "0 waiting, as far as we knew on Tuesday"
-- is not — so the poll writes down when it finished.
--
-- Null means this account has never completed a poll. It stays null for a
-- mailbox whose credentials are wrong or whose server stopped answering, which
-- is the point: nothing here is ever back-filled from the messages, because a
-- message's `fetched_at` says when a row landed, not that a pass finished.

alter table accounts add column if not exists last_synced_at timestamptz null;
