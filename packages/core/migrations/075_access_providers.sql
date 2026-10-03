-- Trusted access providers (specs/trusted-access.md §3, §4).
--
-- Tailscale used to be hard-coded into the sessions table: `via = 'tailscale'`
-- and three tailscale_* columns. It is now one provider of several, so a
-- session a provider verified says `via = 'provider'` and which one:
--
-- provider_id:      'tailscale', 'cloudflare-access' (later 'withbuddi').
-- provider_subject: who it verified, the login or email the provider checks
--                   again on every request (was tailscale_login).
-- provider_detail:  whatever else the provider keeps, as a JSON object of
--                   strings: a tailnet address and display name for
--                   Tailscale, the team domain for Cloudflare. Shown, never
--                   trusted.
--
-- Existing Tailscale sessions are rewritten in place, so nobody is signed out
-- by the upgrade.
alter table core.dashboard_sessions
  add column if not exists provider_id text,
  add column if not exists provider_subject text,
  add column if not exists provider_detail jsonb;

alter table core.dashboard_sessions drop constraint if exists dashboard_sessions_via_check;

update core.dashboard_sessions
   set via = 'provider',
       provider_id = 'tailscale',
       provider_subject = tailscale_login,
       provider_detail = jsonb_strip_nulls(jsonb_build_object('address', tailscale_address, 'name', tailscale_name))
 where via = 'tailscale';

-- A Tailscale row that somehow lost its login could never be confirmed again.
delete from core.dashboard_sessions where via = 'provider' and provider_subject is null;

alter table core.dashboard_sessions
  add constraint dashboard_sessions_via_check check (via in ('local', 'ticket', 'provider')),
  add constraint dashboard_sessions_provider_check check (
    (via = 'provider') = (provider_id is not null and provider_subject is not null)
  );

alter table core.dashboard_sessions
  drop column if exists tailscale_login,
  drop column if exists tailscale_address,
  drop column if exists tailscale_name;
