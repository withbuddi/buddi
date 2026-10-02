-- Dismissing failed jobs (docs/architecture.md, "Queue, concurrency, recovery").
--
-- A failed job is the queue waiting for a human. Until now the only answers
-- were Retry and Cancel, so a job nobody wanted to run again sat in the
-- footer's "N failed" for ever. Dismissing it keeps the row — its error and
-- its history are still the record of what did not happen — and takes it out
-- of every count that asks the owner for something.
--
--   acknowledged_at  when the owner dismissed it; null while it still asks.
--                    A failed job older than 14 days counts as dismissed
--                    without a write (core/src/queue/failures.ts, AUTO_QUIET_DAYS).
--   acknowledged_by  'owner' from the dashboard or the CLI.
--
-- A retry, or a new failure of the same row, clears both: that is new news.
alter table core.jobs
  add column if not exists acknowledged_at timestamptz null,
  add column if not exists acknowledged_by text null;

-- The counts and the Jobs page read failed rows by this.
create index if not exists jobs_failed_idx on core.jobs (updated_at desc)
  where state = 'failed';
