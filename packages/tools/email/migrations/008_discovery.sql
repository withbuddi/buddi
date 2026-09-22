-- Discovery is a fact about the account, and a participant count is derived
-- (applied with search_path = email, public).
--
-- Two corrections, both of the same shape: a running scalar that is written
-- once and hoped about is replaced by something that can be checked.
--
--  1. **`accounts.folders_discovered_at`.** Folder discovery used to be
--     triggered by the shape of the `folders` table: an account with at most
--     one row had never been listed. That reads the wrong fact. An account
--     whose INBOX row was written and whose *Sent* row failed to insert —
--     a transient error on one statement — has two rows the moment any other
--     folder is recorded, so it looked discovered forever and never got the
--     Sent row it needs. Its threads would then never hear the owner's side,
--     silently, for the life of the installation.
--
--     So discovery records itself: null means "not discovered", and the stamp
--     is written only when every folder the plan named was persisted, Sent
--     included. A partial pass leaves it null and the next poll tries again.
--     A server with genuinely no Sent folder also leaves it null — that is a
--     running state, not a failure (the inbox is polled as it always was), and
--     it is the only way a Sent folder created later is ever found.
--
--     Existing rows are left null on purpose. Re-discovery is one LIST and a
--     handful of idempotent upserts that cannot move a cursor already in use
--     (see `ensureFolder`), and it is how an installation that lost its Sent
--     row to this bug gets it back.
--
--  2. **`threads.participants_overflow` is no longer maintained.** It was a
--     running counter incremented on every upsert by "how many more distinct
--     addresses than the cap this message brings", which double-counts the
--     ordinary case: the same fifty people writing twice added their overflow
--     twice, and the number the owner was shown ("and N more") grew without
--     anybody new ever appearing. A count is not something to accumulate. It
--     is now derived at read time from the thread's own messages — the
--     distinct normalised addresses over From, To and Cc — so it cannot drift
--     from what is stored.
--
--     The column is kept rather than dropped: `backfill_threads` (007) writes
--     it, and re-declaring that hundred-line function here just to remove one
--     column would leave two copies of it to drift apart. So it is made
--     nullable, loses its default, and every value stored by the old running
--     counter is cleared — nothing can read a stale count and mistake it for a
--     live one. Ingest no longer writes it and no query selects it; the only
--     thing that still fills it is that one backfill, with a value it computes
--     correctly and that nothing reads.

-- 1 -------------------------------------------------------------- discovery
alter table accounts add column if not exists folders_discovered_at timestamptz null;

comment on column accounts.folders_discovered_at is
  'When folder discovery last completed for this account: every folder the plan named was persisted, Sent included. Null means discovery has not completed and the next poll lists again.';

-- 2 ------------------------------------------------------- derived overflow
alter table threads alter column participants_overflow drop not null;
alter table threads alter column participants_overflow drop default;
update threads set participants_overflow = null where participants_overflow is not null;

comment on column threads.participants_overflow is
  'Legacy and unused. The count of participants beyond the stored cap is derived at read time from the thread''s messages (see participantsTotals). Ingest stopped maintaining this column at migration 008 and nothing reads it.';
