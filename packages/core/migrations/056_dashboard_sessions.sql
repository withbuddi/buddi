-- Dashboard sessions that survive a restart (docs/web.md, "Sessions").
--
-- The gateway used to keep sessions in memory only, so every restart or
-- upgrade signed the owner out. A row here is a session the dashboard
-- honours; the gateway keeps a small cache in front of it
-- (packages/gateway/src/web/sessions.ts).
--
-- id_hash:      sha256 of the session cookie's value, hex. The value itself is
--               never stored: a copy of this table cannot be replayed as a
--               cookie.
-- (no csrf):    the CSRF value is derived from the session id
--               (HMAC-SHA256 keyed by the id), so there is nothing to store and
--               nothing here that a write could be forged with.
-- scope:        where the session was established, decided from the socket.
-- via:          how it was established; tailscale_* are the daemon-confirmed
--               identity it is bound to and re-checked against.
-- ttl_ms:       the idle lifetime it runs on.
-- expires_at:   the sliding idle edge, written back at most every few minutes,
--               so after a restart it may be up to that much earlier than the
--               in-memory value was.
-- absolute_expires_at: the edge no use extends (Tailscale sessions only).
-- last_seen_at: when that sliding edge was last written.
create table if not exists core.dashboard_sessions (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('local', 'remote')),
  via text not null check (via in ('local', 'ticket', 'tailscale')),
  tailscale_login text,
  tailscale_address text,
  tailscale_name text,
  ttl_ms bigint not null check (ttl_ms > 0),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz,
  last_seen_at timestamptz not null
);

create index if not exists dashboard_sessions_expires on core.dashboard_sessions (expires_at);
