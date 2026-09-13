# buddi

A personal AI agent platform for a single owner. Today it ships one agent: a **finance
advisor** you talk to from the terminal. It records your balances, incomes and fixed
charges in Postgres, and answers "can I afford this?" from a deterministic day-by-day
cash-flow projection — the model explains, it never computes.

Design and rationale: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Prerequisites

- Node 26
- pnpm 11
- Docker (for the Postgres container)

## Setup

```sh
cp .env.example .env
claude setup-token          # paste the sk-ant-oat01-… token into CLAUDE_CODE_OAUTH_TOKEN
                            # (or set ANTHROPIC_API_KEY instead — either works)
pnpm install
pnpm db:up                  # docker compose: postgres
pnpm -r build
pnpm db:migrate             # core schema + the finance plugin's own schema
```

Credentials are never read ambiently: an agent names the *environment variable* it wants,
and resolution fails closed with a typed problem if it is missing or empty. If
`CLAUDE_CODE_OAUTH_TOKEN` is set the agent uses the subscription token; otherwise it uses
`ANTHROPIC_API_KEY`. Pin a different model with `BUDDI_MODEL` (default `claude-sonnet-5`).

**Port note.** The container publishes `${BUDDI_DB_PORT:-5432}`. If 5432 is already taken on
your machine, set `BUDDI_DB_PORT` **and** the port in `DATABASE_URL` together, e.g.:

```sh
BUDDI_DB_PORT=55433
DATABASE_URL=postgres://buddi:buddi@localhost:55433/buddi
```

## Usage

```sh
pnpm chat                      # interactive REPL, new conversation
pnpm chat --resume <id>        # continue a conversation
pnpm chat --last               # continue the most recent one
pnpm ask "can I afford a 600 EUR bike on the 20th?"
pnpm ask "..." --resume <id>   # one turn against an existing conversation
```

In the REPL: `/tools` lists the registered tools, `/id` prints the conversation id,
`/quit` (or Ctrl-D) exits. Tool calls are echoed as dim `⚙ finance.…` lines so you can see
what the agent actually did.

Start by telling it the facts — it stores each one and confirms:

> My checking balance is 900 EUR as of today. I get paid 3200 on the 28th, rent is 1200 on
> the 1st, a streaming sub of 40 on the 15th. Keep a safety floor of 200.

Then ask it things. Any "can I afford / is it wise" question goes through
`finance.project_cashflow`, and the verdict quotes the minimum balance, the date it happens
and the next income.

**CSV import.** Bank CSV export is the primary intake in v1: drop the file anywhere and ask
the agent to import it, giving the path and the account:

> Import ~/Downloads/checking-2026-09.csv into Checking

It detects the date/amount/description columns, handles `;`/`,` separators and comma
decimals, and skips rows already imported.

## Development

```sh
pnpm -r build
pnpm typecheck
pnpm test        # includes the check that core imports no tool package
```

Packages: `core` (domain, db, event log, tool registry, provider port), `runtime` (agent
loop + Anthropic adapter), `gateway` (the CLI surface), `tools/finance` (the finance
plugin, which owns the `finance` schema). Core never imports a tool; delete
`packages/tools/finance` and the system still boots.
