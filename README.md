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

An agent file may pin a different provider (`provider: openai`), which reads
`OPENAI_API_KEY` and `BUDDI_OPENAI_MODEL` (default `gpt-5`) and nothing else —
no subscription token, no fallback to the Anthropic key, and no model borrowed
from the other provider's catalogue. `@scout` ships that way. If its key is
absent, `buddi agents` lists it as unavailable and says which variable is
missing; every other agent is unaffected. `pnpm eval --provider openai` runs the
golden set against it, skipping — out loud — every case that needs the finance
tools it does not have.

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
are up to date, whether the model credential is actually accepted, one
`agents` row summarising which engine each agent runs on and which of them this
machine can reach (it FAILS only when the *default* agent cannot run), whether
the bot token is valid, how many devices are paired, where the dashboard is bound
and whether it has a token yet, whether the background service is running, and
which timezone is in force. It exits 1 if anything critical is
broken, so it is usable from a script.

## Usage

```sh
buddi chat                      # interactive REPL, new conversation
buddi chat --agent ledger       # ... with a specific agent, by @handle or id
buddi chat --resume <id>        # continue a conversation
buddi chat --last               # continue the most recent one
buddi ask "can I afford a 600 EUR bike on the 20th?"
buddi ask "..." --resume <id>   # one turn against an existing conversation
buddi agents                    # every agent installed, and where it came from
```

## Your agents are yours

The agents in this repository are **examples**. Your own live in a private
directory that is never committed — a persona names your bank, your landlord,
your inbox, and none of that belongs in a repository you might share or push.

Both are loaded, in this order, later winning:

| Order | Agents | Skills |
| --- | --- | --- |
| 1. shipped examples | `examples/agents/` | `examples/skills/` |
| 2. yours | `$BUDDI_AGENTS_DIR`, else `private/agents` if it exists, else `~/.buddi/agents` | `$BUDDI_SKILLS_DIR`, else `private/skills`, else `~/.buddi/skills` |

An agent of yours with the same **id** as an example one *replaces* it wholesale
— the file, not a merge — so the way to change an example is to copy the folder
across and edit the copy. A skill of yours with the same **name** as an example
one replaces it the same way. `buddi agents` prints where each one came from
(`example` or `private`), and so does the `config` row of `buddi doctor`.

**Adding one.** Make a folder named for the id, put an `agent.md` in it, restart:

```sh
mkdir -p private/agents/ledger
$EDITOR private/agents/ledger/agent.md   # id, handle, name, description, tools + persona
buddi agents                             # confirm it loaded
buddi service restart                    # the running surfaces reload the catalog
```

**`private/` is gitignored.** Nothing in it is tracked, and `buddi init` writes a
`private/README.md` saying so. If you keep your agents somewhere else entirely,
point `BUDDI_AGENTS_DIR` (and `BUDDI_SKILLS_DIR`) at it.

**Sharing a persona.** Hand somebody the agent's folder. It is a markdown file
with a frontmatter block — no data, no credentials, nothing machine-specific.
They drop it into their own private agents directory and restart.

**Upgrading from an older clone.** If your agents are still in `<repo>/agents`,
buddi keeps loading them and prints a one-line notice. Move them once:

```sh
buddi agents migrate            # --dry-run to see it first
buddi service restart
```

It moves `agents/` and `skills/` into your private directory, never overwrites a
file already there, leaves `examples/` alone, and does nothing on a second run.

### Choosing the engine

Which provider and model an agent runs on is a line in its own file —
`<private>/agents/<id>/agent.md` — because an endpoint is a data destination: this line,
and nothing ambient, decides which company sees that agent's conversations.

```yaml
provider: anthropic        # or openai; absent means anthropic
model: claude-sonnet-5     # validated against that provider's catalogue
maxTurns: 12
```

You do not have to edit it by hand:

```sh
buddi agents                                  # handle, id, provider, model, credential, availability, roles
buddi agents show ledger                      # persona file, tools, skills, capabilities, last run
buddi agents models                           # the catalogue, per provider, and what this machine can reach
buddi agents models --provider openai
buddi agents set ledger --model claude-opus-5 # edits the frontmatter in place
buddi agents set scout --provider openai --model gpt-5
buddi agents set ledger --max-turns 8 --language en
buddi agents test ledger                      # one cheap live turn: provider, served model, latency, tokens, cost
```

`set` rewrites only the keys you named — the persona body, the comments and the
key order are left exactly as they were — and it refuses a model the pinned
provider does not serve, in the catalogue's own words. A model is never migrated
for you: moving an agent to another provider means naming both, `--provider` and
`--model`, together. The same controls are on the dashboard's Agents page, which
writes through `POST /api/agents/:id/engine` and calls the same function.

Where a file pins nothing, the environment decides: `BUDDI_MODEL` (default
`claude-sonnet-5`) for Anthropic agents and `BUDDI_OPENAI_MODEL` (default
`gpt-5`) for OpenAI ones — never one for the other. The credential is named, not
discovered: `CLAUDE_CODE_OAUTH_TOKEN` if you ran `claude setup-token`, otherwise
`ANTHROPIC_API_KEY`; `OPENAI_API_KEY` for OpenAI, which has no subscription-token
form and no fallback. An agent whose credential is absent is *listed*, marked
unavailable with the reason, and every other agent keeps working.

A change reaches the next `buddi chat` or `buddi ask` immediately — they are
their own processes. The running surfaces (`buddi serve`, Telegram, the
scheduler, the dashboard) hold the catalog they loaded at boot, so finish with:

```sh
buddi service restart
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

## Dashboard

`buddi serve` also serves a small local dashboard over the event log — bound to
`127.0.0.1:4317`, session-authenticated, and reachable with one command:

```sh
buddi dashboard           # prints the URL with a one-time link, and opens it
buddi dashboard --token   # just the one-time token, for piping
buddi dashboard --off     # how to turn it off
```

Overview, Events, Conversations, Missions, Approvals, Jobs, Reminders,
Sentinels and Agents. It is read-first: the writes it offers are the ones you
already have elsewhere — approve or reject a pending action, pause and resume,
enable or disable a mission and change its misfire policy, retry or cancel a
job, cancel a reminder — and every one of them calls the same core function the
CLI and Telegram call, so a decision made here is the same atomic transition
and shows up in the log a second later.

**How the link works.** A long random token is generated on first run and kept
in the OS keychain under `BUDDI_WEB_TOKEN` (or, with no usable vault, in
`data/web-token`, mode 600). It never appears in a URL. What `buddi dashboard`
prints is a *ticket* signed with it: single-use and valid for five minutes. The
server verifies it, spends it, and swaps it for an HttpOnly, `SameSite=Strict`
session cookie on a clean URL. Every write additionally needs a double-submit
CSRF header and an `Origin` that is the bound address; there is no CORS, and a
request without a valid session gets `401` and an empty body. Failed
authentications are rate-limited per address.

| Variable | Default | What it means |
| --- | --- | --- |
| `BUDDI_WEB` | `1` | `0` turns the dashboard off entirely. |
| `BUDDI_WEB_HOST` | `127.0.0.1` | Bind address. Anything but loopback exposes an approval button to your network — put it behind an authenticated transport if you do, and `buddi doctor` will warn about it. |
| `BUDDI_WEB_PORT` | `4317` | Port. |

The UI is a small React app built by Vite into `packages/web/dist`, served as
static files by the same process. It makes no external requests at all — no
CDN, no web fonts, no telemetry — so it works with the machine offline.

## Missions

```sh
buddi missions list
buddi missions add-defaults     # register every mission the installed plugins suggest
buddi missions add-recap        # just the recap mission (add-friday-recap still works)
buddi missions run-now <id> [--inline]
buddi missions enable <id> | disable <id>
buddi migrate                   # core + every installed plugin's schema
```

A scheduled mission is not something the gateway knows: each plugin *suggests*
its own (`missions` in its manifest), naming the agent by **role** rather than
by id. `add-defaults` registers what it can place and prints, for anything it
cannot, the one line that would fix it — a role no installed agent claims is a
configuration state, not a failure. The only mission the gateway owns is
`sentinel-wake`, which has no schedule: a watcher enqueues it.

### Roles

`/status` and `/recap` name a capability, never an agent. An agent claims one in
its frontmatter:

```yaml
roles: [overview, recap]        # free-form, kebab-case; core ships no vocabulary
```

`/status` runs whoever claims `overview` (without switching the agent you are
talking to); `/recap` runs the recap mission with whoever claims `recap`. If no
installed agent claims the role, both say so and name the key above. The
dashboard's money cards follow the same rule: they appear only when an
`overview` agent and a plugin that reports balances are both installed.

## Reminders

An agent can put one future nudge on its own clock (`reminder.set`): when it
fires the agent is woken with its own note and checks the fact again before
saying anything. The firing loop ticks once a minute, so a reminder lands within
about a minute of its instant. The budget is enforced in code, not in a prompt,
and every number in it is tunable in `.env`:

| Variable | Default | Range | What it means |
| --- | --- | --- | --- |
| `BUDDI_REMINDER_MIN_LEAD_MINUTES` | `5` | 1–1440 | How far out a reminder must be. Below this the agent should just say it now. |
| `BUDDI_REMINDER_MAX_HORIZON_DAYS` | `365` | 1–3650 | How far out a reminder may be. |
| `BUDDI_REMINDER_MAX_PENDING_PER_AGENT` | `10` | 1–100 | Pending reminders one agent may hold. |
| `BUDDI_REMINDER_MAX_PENDING_TOTAL` | `25` | 1–500 | Pending reminders across every agent. |

A value outside its range is clamped and a value that is not a whole number is
ignored — either way the reason is logged once at startup and the machine still
comes up. The tool's own description is built from the resolved numbers, so the
agent is told the limits this installation actually has. Changing any of them
needs a restart (`buddi service stop && buddi service start`).

```sh
buddi reminders list
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
`web` (the dashboard UI, React + Vite, built to static files the gateway serves),
`cli` (the single `buddi` binary — a dispatcher over the gateway's own entry points,
plus `init`, `doctor` and `service`), `tools/finance` (the finance plugin, which owns the
`finance` schema). Core never imports a tool; delete `packages/tools/finance` and the
system still boots.
