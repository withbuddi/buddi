-- The dashboard's lock screen (docs/dashboard.md, "Lock screen").
--
-- A privacy screen over a signed-in session, opened with a PIN. The PIN's
-- hash and its tries live in core.web_settings under `lock.pin`, the delay
-- and the background under `lock` (packages/core/src/lock.ts); what is per
-- session lives on the session row:
--
-- locked_at:   when this session locked; null while it is open. A locked
--              session's API calls are answered 423 except the lock screen's
--              own (packages/gateway/src/web/lock.ts).
-- lock_reason: why: `owner` (Lock now), `idle` (nobody used it for the
--              delay), `start` (a session that began while a PIN was set).
-- active_at:   when the owner last used this session, as the page reports
--              it. The server locks a session idle past the delay whether or
--              not the page says so.
-- client:      `browser`, or `mcp` for buddi's own command-line clients
--              (`buddi mcp`, `buddi connections`), which a lock never covers.
alter table core.dashboard_sessions
  add column if not exists locked_at timestamptz,
  add column if not exists lock_reason text check (lock_reason in ('owner', 'idle', 'start')),
  add column if not exists active_at timestamptz,
  add column if not exists client text not null default 'browser' check (client in ('browser', 'mcp'));

-- The owner's picture behind the lock screen: one JPEG this server encoded,
-- at most 2560 pixels on its long side. One row or none.
create table if not exists core.lock_background (
  id smallint primary key default 1 check (id = 1),
  jpeg bytea not null,
  sha256 text not null,
  width integer not null,
  height integer not null,
  updated_at timestamptz not null default now()
);
