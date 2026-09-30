-- Connections, local servers (docs/connections.md, "A program on this
-- computer"): a server buddi starts as the owner and speaks to over its
-- standard input and output, beside the remote ones.
-- Applied with search_path = mcp, public.
--
-- `url` holds the command line as the owner reads it and `host` says
-- "this computer"; neither is ever dialled for a program. A secret variable's
-- value is an owner secret (core.secrets, the `mcp.env` destination): `env`
-- keeps only its name, `{ "name": "TOKEN", "secretRef": "MCP_ENV_…" }`, next
-- to the plain ones, `{ "name": "URL", "value": "…" }`.

alter table connections add column if not exists transport text not null default 'http';
alter table connections drop constraint if exists connections_transport_check;
alter table connections add constraint connections_transport_check check (transport in ('http', 'stdio'));

alter table connections add column if not exists command text;
alter table connections add column if not exists args jsonb;
alter table connections add column if not exists env jsonb;

-- sha256 over the command, its arguments and the variables' names, as the
-- owner reviewed them: another one is another review.
alter table connections add column if not exists reviewed_spec text;

alter table connections drop constraint if exists connections_program_check;
alter table connections add constraint connections_program_check
  check (transport = 'http' or (command is not null and args is not null and env is not null));
