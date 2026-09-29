-- Connections, token sign-in (docs/connections.md, "Connect"): a server that
-- takes a token the owner pasted, sent in one header on every request.
-- Applied with search_path = mcp, public.
--
-- The token itself is an owner secret (core.secrets), bound to `http.header`
-- for this connection's host; `vault_ref` names it. Here only the header's
-- name and the words before the token.

alter table connections drop constraint if exists connections_auth_kind_check;
alter table connections add constraint connections_auth_kind_check
  check (auth_kind in ('none', 'oauth', 'token'));

alter table connections add column if not exists token_header text;
alter table connections add column if not exists token_prefix text;
