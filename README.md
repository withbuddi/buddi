# buddi

A personal AI agent platform for a single owner. Today it ships one agent: a **finance
advisor** you talk to from the terminal. It records your balances, incomes and fixed
charges in Postgres, and answers "can I afford this?" from a deterministic day-by-day
cash-flow projection — the model explains, it never computes.

Design and rationale: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Install

buddi is one command. Install it once, run it from anywhere.

```sh
git clone <this repo> buddi && cd buddi
pnpm install && pnpm -r build
pnpm run link               # puts the global `buddi` on your PATH
buddi init                  # credentials, timezone, database, migrations
```

`scripts/install.sh` does exactly those four steps on a fresh machine, after
checking for git, node, pnpm and docker — it names what is missing and where to
get it, and installs no system software itself.

```sh
./scripts/install.sh
```

`pnpm run link`, not `pnpm link` — the latter is pnpm's own builtin and means
something else. It is `pnpm add --global ./packages/cli`: a global install that
points straight at this checkout, so a rebuild is picked up with no relinking.
`pnpm run unlink` removes it.

If `buddi` is not found afterwards, pnpm's global bin directory is not on your
PATH: run `pnpm setup`, open a new shell, and `pnpm run link` again. Everything
also works unlinked, as `pnpm buddi …` from the repo.

### Prerequisites

- Node 22 or newer (26 is what it is developed on)
- pnpm 11
- Docker (for the Postgres container)

### What `buddi init` does

It is an interactive wizard, and it is idempotent — a second run asks only about
what is still missing. It copies `.env.example` to `.env`, asks for a model
credential (`claude setup-token` for a Claude subscription, or an
`ANTHROPIC_API_KEY`), an optional Telegram bot token which it validates against
`getMe` and names the bot back to you, your timezone (defaulting to this
machine's) and what the agents should call you. Then it starts postgres, builds
and migrates. Secrets go into `.env` (mode 600) and are never printed back.

Credentials are never read ambiently: an agent names the *environment variable*
it wants, and resolution fails closed with a typed problem if it is missing or
empty. If `CLAUDE_CODE_OAUTH_TOKEN` is set the agent uses the subscription
token; otherwise it uses `ANTHROPIC_API_KEY`. Pin a different model with
`BUDDI_MODEL` (default `claude-sonnet-5`).

**Secrets.** `.env` is the day-1 fallback; the OS keychain is the real home.
`buddi vault import-env` moves every known secret into it and rewrites each line
in `.env` to `NAME="<vault>"` — a marker, not a value, which resolution treats as
absent so the vault answers instead. The quotes matter: unquoted, `<` is a shell
redirection and `set -a; . ./.env` would fail. `buddi vault list | get | set |
delete` manage the keychain directly, and no command ever prints a value back.

**Port note.** The container publishes `${BUDDI_DB_PORT:-5432}`. If 5432 is already taken on
your machine, set `BUDDI_DB_PORT` **and** the port in `DATABASE_URL` together, e.g.:

```sh
BUDDI_DB_PORT=55433
DATABASE_URL=postgres://buddi:buddi@localhost:55433/buddi
```

### Is it working?

```sh
buddi doctor
```

One table: node/pnpm/docker versions, postgres reachability, whether migrations
are up to date, whether the model credential is actually accepted, whether the
bot token is valid, how many devices are paired, whether the background service
is running, and which timezone is in force. It exits 1 if anything critical is
broken, so it is usable from a script.

## Usage

```sh
buddi chat                      # interactive REPL, new conversation
buddi chat --agent ledger       # ... with a specific agent, by @handle or id
buddi chat --resume <id>        # continue a conversation
buddi chat --last               # continue the most recent one
buddi ask "can I afford a 600 EUR bike on the 20th?"
buddi ask "..." --resume <id>   # one turn against an existing conversation
buddi agents                    # every agent installed under agents/
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

## Always on

`buddi serve` runs both halves of the installation in your shell: the Telegram
surface (inbound) and the mission scheduler (outbound). To have it run in the
background and come back at login:

```sh
buddi service install     # macOS: a launchd LaunchAgent, KeepAlive + RunAtLoad
buddi service status      # installed? running? which pid?
buddi service logs        # follow data/logs/serve.log and .err
buddi service start       # load and run it (the plist stays where it is)
buddi service stop        # unload it; `start`, or the next login, brings it back
buddi service restart
buddi service uninstall   # stops it and removes the unit; the logs stay
```

`install` refuses if `.env` is missing what `serve` needs, and warns if a
`serve` is already running — two pollers fight over the same bot. On Linux the
same commands write a **systemd user unit** instead; that implementation is
best-effort and untested.

Then pair a device:

```sh
buddi telegram pair       # a QR code and the same deep link as text
buddi telegram devices
buddi telegram unpair <id>
```

The pairing code is a bearer credential for the ten minutes it lives: it is
printed once, and `buddi serve` must be running to receive it.

### After a reboot

Everything here sits on one Postgres container, so if Docker Desktop did not
start, nothing works. Two things make that a non-event:

- Turn on **Docker Desktop → Settings → General → Start Docker Desktop when you
  sign in**. The container itself is `restart: unless-stopped`, so it comes back
  by itself whenever the daemon does.
- Or start it by hand: `buddi db up` (`buddi db status`, `buddi db down`).

The background service does not need either one to be true *at the moment it
starts*: with no database it waits and retries — 5s, 10s, 20s, up to a minute —
instead of exiting, so launchd has nothing to crash-loop on and `serve`
connects on its own once Docker is up. `buddi service logs` shows it waiting.

The foreground commands do the opposite: `buddi chat`, `buddi ask`,
`buddi missions` and `buddi jobs` fail immediately with

```
database not reachable at localhost:55433 — is Docker running? try: buddi db up
```

`buddi status` (the same report as `buddi doctor`) is the thing to run when
something is off: the `docker` row says **Docker is not running (open -a
Docker)** when the daemon is down, the rows under the database say
`skipped: database unreachable` rather than repeating the same failure, and the
`service` row points at `buddi service start` when the LaunchAgent is installed
but the process is not up.

## Missions

```sh
buddi missions list
buddi missions add-friday-recap
buddi missions run-now <id> [--inline]
buddi missions enable <id> | disable <id>
buddi migrate                   # core + every installed plugin's schema
```

## Development

```sh
pnpm -r build
pnpm typecheck
pnpm test        # includes the check that core imports no tool package
```

Every `pnpm` script still works from the repo (`pnpm chat`, `pnpm serve`,
`pnpm missions …`) — they call the same binary. `pnpm run link` / `pnpm run unlink`
attach and detach the global `buddi`.

Packages: `core` (domain, db, event log, tool registry, provider port), `runtime` (agent
loop + Anthropic adapter), `gateway` (the surfaces: terminal, Telegram, scheduler),
`cli` (the single `buddi` binary — a dispatcher over the gateway's own entry points,
plus `init`, `doctor` and `service`), `tools/finance` (the finance plugin, which owns the
`finance` schema). Core never imports a tool; delete `packages/tools/finance` and the
system still boots.
