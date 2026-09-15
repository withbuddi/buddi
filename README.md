# buddi

buddi is a personal agent platform you run yourself. An agent is a markdown file
you write: its frontmatter lists the tools it may call, its body is its persona.
Agents get real access to your data and your tools — a bank export, an inbox, a
file you drop on them — and you reach them from Telegram, from a terminal, and
from a small dashboard on localhost. They also work while you are not there:
scheduled missions, watchers that only speak when something is wrong, one-off
reminders they set themselves. Anything irreversible stops and waits for you to
approve it. Everything runs on your machine, against a Postgres container on
your machine; the one thing that leaves is the prompt, which goes to whichever
AI provider each agent's file pins — so that one line in that one file decides
which company sees that agent's conversations.

Design and rationale: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Install

**Prerequisites**

- **Node 22 or newer** (developed on 26)
- **pnpm 11**
- **Docker Desktop**, for the Postgres container. Turn on *Settings → General →
  Start Docker Desktop when you sign in* — buddi is one database away from
  working, and that setting is the difference between "it came back after the
  reboot" and "nothing works this morning".

```sh
git clone <this repo> buddi && cd buddi
./scripts/install.sh
```

`install.sh` checks for git, node, pnpm and docker — naming what is missing and
where to get it, installing no system software itself — then runs the three
steps you can also run by hand:

```sh
pnpm install
pnpm -r build
pnpm run link     # puts the global `buddi` on your PATH
```

`pnpm run link`, not `pnpm link`: the latter is pnpm's own builtin and means
something else. It is `pnpm add --global ./packages/cli`, a global install
pointing at this checkout, so a rebuild is picked up without relinking.
`pnpm run unlink` removes it. If `buddi` is not found afterwards, pnpm's global
bin directory is not on your PATH: run `pnpm setup`, open a new shell, and
`pnpm run link` again. Everything also works unlinked, as `pnpm buddi …` from
the repo.

Then:

```sh
buddi init
```

---

## First ten minutes

### 1. `buddi init`

An interactive wizard, and idempotent — a second run asks only about what is
still missing. It prints its plan before it does anything:

```
buddi init
installation: /Users/you/buddi

  node    26.2.0
  pnpm    11.0.0
  docker  Docker version 27.4.0

Plan
 • create .env from .env.example
 • a model credential (subscription token or API key)
 • a Telegram bot token (optional)
 • the timezone every agent means by "today"
 • what the agents should call you
 • your private agents directory, seeded with the example agent
 • start the postgres container
 • build the workspace
 • apply core + plugin migrations
 • pair a device by QR code
 • run the surfaces + scheduler in the background, at login
 • open the local dashboard
```

Every step is skippable, and a step you skip never blocks the next one. It ends
by naming the first three things to say to an agent.

`buddi init --yes` is the same wizard with nobody at the keyboard: it does
everything that needs no input and skips everything that does, saying which. A
run with no TTY behaves the same way.

**Credentials.** Two ways in: `claude setup-token` for a Claude subscription
(paste the `sk-ant-oat01-…` into `CLAUDE_CODE_OAUTH_TOKEN`), or an
`ANTHROPIC_API_KEY` from console.anthropic.com. Secrets go into `.env` at mode
600 and are never printed back. `buddi vault import-env` later moves them into
the OS keychain.

**The database password.** You never type one. `buddi init` generates 32 random
characters, hands them to Postgres, and keeps them in the OS keychain under
`BUDDI_DB_PASSWORD`; `DATABASE_URL` is assembled around that at runtime and is
**not** in `.env` — the file holds `DATABASE_URL="<vault>"`, a marker. If you
already run buddi with the old defaults, `buddi db secure` does the migration:
it rotates the password in the running server, stores it, rewrites `.env`, and
puts the old one back if anything fails.

The escape hatch: set `DATABASE_URL` in `.env` and it wins over everything. That
is for running your own Postgres — buddi then neither generates nor rotates a
password it did not issue.

**Port note.** The container publishes on **`127.0.0.1:${BUDDI_DB_PORT:-5432}`**
and nothing else. If 5432 is already taken, set `BUDDI_DB_PORT` alone — the
assembled URL reads it:

```sh
BUDDI_DB_PORT=55433
```

The `127.0.0.1` in `docker-compose.yml` is load-bearing. Without it Docker binds
`0.0.0.0` and your database — every conversation, every transaction, every mail
body — is reachable from every other machine on the network you happen to be on.
The one legitimate reason to change it is reaching this database from another
machine **of your own over a private network**: a Tailscale or WireGuard
address, named explicitly (`100.x.y.z:${BUDDI_DB_PORT:-5432}:5432`). Never bind
it to `0.0.0.0` on a network you do not control. `buddi doctor` fails the
`database exposure` row if you do.

### 2. `buddi doctor`

One table, and an exit code a script can use: `1` when something critical is
broken.

```
$ buddi doctor
buddi doctor — /Users/you/buddi

  ok    node              26.2.0
  ok    pnpm              11.0.0
  ok    docker            Docker version 27.4.0
  ok    postgres          reachable at 127.0.0.1:55433
  ok    database exposure 127.0.0.1:55433 (loopback only); password in the vault
  ok    migrations        up to date (23 applied)
  ok    vault             keychain (3 secrets)
  ok    model credential  CLAUDE_CODE_OAUTH_TOKEN accepted by anthropic
  ok    config            agents: examples + private/agents (1 private)
  ok    agents            1 agent, 1 runnable — assistant (anthropic/claude-sonnet-5)
  warn  telegram bot      TELEGRAM_BOT_TOKEN is not set — the Telegram surface is off
  warn  paired devices    none — run `buddi telegram pair`
  ok    queue             running; 0 pending, 0 failed
  ok    dashboard         127.0.0.1:4317, token in the keychain
  warn  service           not installed — run `buddi service install`
  ok    timezone          Europe/Paris

everything critical is in place; 3 thing(s) to look at
```

`buddi status` is the same report under the name people reach for.

### 3. `buddi chat`

A REPL against the default agent. `/help` lists the commands, `/quit` or Ctrl-D
leaves. Tool calls are echoed as dim `⚙ memory.note` lines so you can see what
the agent actually did.

```sh
buddi chat
buddi chat --agent ledger      # by @handle or id
buddi chat --last              # continue the most recent conversation
```

### 4. `buddi telegram pair`

Ask @BotFather for a bot token, put it in `.env`, then:

```
$ buddi telegram pair
  █▀▀▀▀▀█ ▀▄▀ ▀█▄█ █▀▀▀▀▀█
  █ ███ █ █▀▀▄ ▄▀█ █ ███ █
  █ ▀▀▀ █ ▀ █▄▀▄▀▀ █ ▀▀▀ █
  ▀▀▀▀▀▀▀ █ ▀ █ █▄ ▀▀▀▀▀▀▀
  ▀█▄█▄▀▀▄▄▀█▀▄ ▄██▀▄▄▀█▄▀
  ▀ ▀▀ ▀▀▀▄█ ▄▀█▄▀▀▀▄█▀▄▄█
  █▀▀▀▀▀█ ▄▀ ▄▀▄█ █ ▀ ▄▄▀█
  █ ███ █ █▄▀█▄▄▀███▀▀▄█▀▀
  █ ▀▀▀ █ ▄ ▀▄ ▀█ ▄▀▄█▄▄▀
  ▀▀▀▀▀▀▀ ▀  ▀▀ ▀▀  ▀▀▀ ▀▀

  Scan it, or open this link on the device:
  https://t.me/your_bot?start=K7M2QX9B
  code K7M2QX9B
  valid until 2026-09-14T15:04:00.000Z (10 minutes). Anyone holding it can
  pair — do not paste it anywhere public.
  `buddi serve` (or the installed service) must be running to receive it.
```

Scan it. The bot answers *Paired. You're talking to buddi as <you>.* Your first
real message gets a two-line orientation above the reply, once, and never
again. `buddi init` can do this step for you, QR and all, waiting up to two
minutes for the scan.

### 5. `buddi service install`

Runs the Telegram surface and the scheduler in the background, starting at
login. `buddi serve` is the same thing in your shell, in the foreground.

Then, once:

```sh
buddi backup schedule install    # nightly at 03:30, prune included
```

A second, separate background job — a service that is crash-looping must not be
the reason last night's backup did not happen.

### 6. `buddi dashboard`

Prints a one-time link and opens it.

---

## Your agents are yours

The agents in this repository are **examples**. Yours live in a directory that
is never committed — a persona names your bank, your landlord, your inbox, and
none of that belongs in a repository you might push.

Both halves are loaded, in this order, **later winning**:

| Order | Agents | Skills |
| --- | --- | --- |
| 1. shipped examples | `examples/agents/` | `examples/skills/` |
| 2. yours | `$BUDDI_AGENTS_DIR`, else `private/agents` if it exists, else `~/.buddi/agents` | `$BUDDI_SKILLS_DIR`, else `private/skills`, else `~/.buddi/skills` |

An agent of yours with the same **id** as an example one *replaces* it wholesale
— the file, never a merge — so the way to change an example is to copy the
folder across and edit the copy. A skill of yours with the same **name**
replaces one of theirs the same way. `buddi agents` prints where each one came
from.

**`private/` is gitignored.** `buddi init` writes a `private/README.md` saying
so. If you keep your agents somewhere else entirely, point `BUDDI_AGENTS_DIR`
(and `BUDDI_SKILLS_DIR`) at it.

### Writing an agent file

One folder per agent, named for its id, with an `agent.md` in it:

```sh
mkdir -p private/agents/ledger
$EDITOR private/agents/ledger/agent.md
buddi agents             # confirm it loaded, and from where
buddi service restart    # the running surfaces reload the catalog
```

```markdown
---
id: ledger                 # required. kebab-case, and it must equal the folder name
handle: ledger             # required. what you type as @ledger; 2–20 chars, starts with a letter
name: Ledger               # required. what surfaces call it in a sentence
description: Tracks my accounts and answers "can I afford this?".   # required. one line
provider: anthropic        # optional. anthropic | openai. Absent means anthropic
model: claude-sonnet-5     # optional. validated against that provider's catalogue
tools: [finance.*, memory.*, reminder.*]   # required. globs allowed; nothing else is callable
maxTurns: 12               # optional. how many model turns one run may take
language: mirror           # optional. mirror | en | fr — mirror answers in the language you wrote
roles: [overview, recap]   # optional. free-form capability claims; /status asks for `overview`
default: true              # optional. the agent a bare `buddi chat` talks to. One per directory
---

You are my finance advisor. There is exactly one owner: the person you are
talking to. Today is {{today}}.

Everything below the second `---` is the persona — plain markdown, no schema.
Say what the agent is for, what it must never do, and how it should sound.
```

The frontmatter parser is strict: an unknown key is a load error, not a warning.
An empty body is a load error too. `{{today}}` is substituted with the owner's
date in `BUDDI_TZ`.

**Skills** are shared procedure, not capability: markdown files that are
composed into an agent's prompt. Two homes, both auto-discovered —
`private/agents/<id>/skills/*.md` loads for that agent only, and
`private/skills/*.md` loads for every agent (or, with an `agents:` list in its
own frontmatter, only for the ones it names). A skill may never carry `tools`
or `tier`: that is a privilege escalation attempt and fails the load loudly.

**`delegates.json`** sits next to `agent.md` and is an authorization file, which
is why it is not a frontmatter key — the file the model's persona lives in is
not where authorization belongs. It is a plain JSON array of agent ids:

```json
["credit-coach"]
```

Missing file means no delegation. A delegate never delegates again, so cycles
cannot exist. Anything that is not an array of ids fails loudly.

**Sharing a persona.** Hand somebody the folder. It is a markdown file with a
frontmatter block — no data, no credentials, nothing machine-specific.

**Upgrading from an older clone.** If your agents are still in `<repo>/agents`,
buddi keeps loading them and prints a notice. Move them once with
`buddi agents migrate` (`--dry-run` to see it first), then
`buddi service restart`.

### The shipped example, in one screen

`examples/agents/assistant/agent.md`:

```markdown
---
id: assistant
handle: assistant
name: Assistant
description: The example agent buddi ships with — explains what buddi is and how to add agents of your own.
default: true
tools: [memory.*, reminder.*]
maxTurns: 8
language: mirror
---

You are buddi's example assistant. There is exactly one owner: the person you
are talking to. Today is {{today}}.

## What buddi is
- buddi is a personal agent platform the owner runs themselves, on their own
  machine, against their own data. …
- An agent is a configuration file, not code. Adding an agent means adding a
  file. A conversation never grants a tool.

## What you do and do not do
- Your tools are memory and reminders, nothing else. You cannot read a balance,
  an inbox or a calendar, and you never guess at one.
- When a question needs data you do not have, say so plainly and say what would
  answer it: an agent the owner writes, with the tool that reaches that data.

## Style
- Short and concrete. Two or three sentences, then the next step.
- Plain text, no markdown — the owner may be reading this in Telegram.
```

That is the whole shape: nine frontmatter keys, a persona, no code.

---

## Choosing the engine

Which provider and model an agent runs on is a line in its own file, because an
endpoint is a data destination: **that line, and nothing ambient, decides which
company sees that agent's conversations.**

You do not have to edit it by hand:

```sh
buddi agents                                    # handle, id, provider, model, credential, availability, roles
buddi agents show ledger                        # persona file, tools, skills, capabilities, last run
buddi agents models                             # the catalogue, per provider, and what this machine can reach
buddi agents models --provider openai
buddi agents set ledger --model claude-opus-5   # edits the frontmatter in place
buddi agents set scout --provider openai --model gpt-5
buddi agents set ledger --max-turns 8
buddi agents test ledger                        # one cheap live turn: provider, served model, latency, tokens, cost
```

`set` rewrites only the keys you named — persona body, comments and key order
are left exactly as they were — and it refuses a model the pinned provider does
not serve, in the catalogue's own words. A model is never migrated for you:
moving an agent to another provider means naming `--provider` and `--model`
together. The dashboard's Agents page writes through the same function.

Where a file pins nothing, the environment decides — never one provider's
default for the other:

| Variable | Default | For |
| --- | --- | --- |
| `BUDDI_MODEL` | `claude-sonnet-5` | Anthropic agents with no `model:` |
| `BUDDI_OPENAI_MODEL` | `gpt-5` | OpenAI agents with no `model:` |

The credential is named, not discovered: `CLAUDE_CODE_OAUTH_TOKEN` if you ran
`claude setup-token`, otherwise `ANTHROPIC_API_KEY`; `OPENAI_API_KEY` for
OpenAI, which has no subscription-token form and no fallback. An agent whose
credential is absent is *listed*, marked unavailable with the reason, and every
other agent keeps working.

**The vault.** `.env` is the day-1 fallback; the OS keychain is the real home.
`buddi vault import-env` moves every known secret into it and rewrites each line
in `.env` to `NAME="<vault>"` — a marker, not a value, which resolution treats
as absent so the vault answers instead. The quotes matter: unquoted, `<` is a
shell redirection. `buddi vault list`, `buddi vault get <NAME>`,
`buddi vault set <NAME>` and `buddi vault delete <NAME>` manage the keychain
directly, and no command ever prints a value back.

A change reaches the next `buddi chat` or `buddi ask` immediately — they are
their own processes. The running surfaces hold the catalog they loaded at boot,
so finish with `buddi service restart`.

---

## Tools and plugins

The core is the trust boundary, and **the core has no tools**. Every
world-touching capability is a plugin, and a plugin can contribute four things:

- an **effect tool** — something an agent proposes and the approval machinery
  gates (`email.send`);
- a **source** — something that polls the world and enqueues a run when it finds
  something (an IMAP inbox);
- a **sentinel** — a watcher that produces *findings*; core alone decides
  whether a finding is worth waking you for;
- a **suggested mission** — scheduled work the plugin thinks is worth doing,
  addressed to a **role** rather than to an agent id.

Four ship in this repository:

| Plugin | Schema | What it gives an agent |
| --- | --- | --- |
| `finance` | `finance` | Accounts, recurring charges, transactions and CSV import, receipts, liabilities, credit utilization and payoff, and a deterministic day-by-day cash-flow projection. Six sentinels (floor breach, minimum due, statement closing, stale balance, unmatched receipts, unprocessed files) and three suggested missions. |
| `email` | `email` | One Gmail account: an IMAP **source** that triages new mail, and `email.send` as a **gated effect tool**. |
| `memory` | `memory` | Owner preferences (revisioned) and agent-written notes with provenance and expiry, plus keyword recall. No embeddings. |
| `artifacts` | *none* | Reads over the artifact store, so an agent can look at the file you dropped on it. Owns no schema: uninstalling removes tools, not your files. |

Core boots with none of them installed — that is a test
(`packages/gateway/src/generic-install.test.ts`), not an aspiration, and
`scripts/check-boundaries.mjs` fails the build if core ever imports a tool
package.

**Writing one.** [docs/plugins.md](docs/plugins.md) is the guide: the four
contributions, the rules that bite, and a complete worked example
(`examples/plugins/weather`) you can copy. The contract itself is
`packages/core/src/tools.ts` — read it first. The smallest complete plugin in the
repository is `packages/tools/memory/src/index.ts`: 35 lines, a manifest, five
tools, one migration. For sources and gated effects, read
`packages/tools/email/src/index.ts`. Apply your schema with `buddi migrate`,
which runs core's migrations and every installed plugin's.

---

## Every surface

An agent is not bound to a surface. These are three adapters over the same
conversations.

### Telegram

| Command | |
| --- | --- |
| `/agents` | every agent, with a button to switch |
| `/use <handle>` | switch, e.g. `/use @ledger` |
| `@handle …` | ask that agent one message without switching |
| `/whoami` | which agent is active here |
| `/status` | where you stand right now (answered by whoever claims the `overview` role) |
| `/recap` | run the recap mission now |
| `/files` | the last files you sent |
| `/reminders` | what the agents put on the clock, with a button to cancel one |
| `/quiet [1d\|1w\|off]` | stop proactive messages for a while (7 days by default) |
| `/approvals` | anything waiting for you |
| `/devices` | the devices paired to this installation |
| `/new` | a fresh conversation with the active agent |
| `/id` | your numeric user id and this chat id |
| `/help` | the list |

**Attachments.** Send a document, a photo or a CSV. With a caption, the agent
starts working on it immediately; without one, it is kept and acknowledged, and
"import that statement" a few minutes later still means that file. Size is
checked three times, and only the downloaded length is believed. Voice notes are
kept, never transcribed.

**Approvals** arrive as a message with *Approve* / *Reject* buttons. Tapping one
re-authenticates you against the paired identity, runs the same core transition
the dashboard and the terminal call, and edits the message into its outcome.

Unpairing is deliberately not a chat command: a stolen phone is already in a
paired chat. Revocation stays on the machine — `buddi telegram unpair <id>`.

### The terminal

```sh
buddi chat [--agent <handle>] [--resume <id>] [--last] [--quiet]
```

| | | | |
| --- | --- | --- | --- |
| `/help` | `/agents` | `/use <handle>` | `/whoami` |
| `/new` | `/resume [n]` | `/id` | `/tools` |
| `/model` | `/usage` | `/status` | `/recap` |
| `/reminders` | `/quiet [1d\|1w\|off]` | `/files [n]` | `/attach <path>` |
| `/approvals` | | | |
| `/approve <id>` | `/reject <id>` | `/devices` | `/clear` |
| `/quit` | | | |

`@handle …` asks one agent a single message without switching. A line ending in
`\` continues; `"""` on its own line opens a literal block where nothing,
including a leading `/`, is interpreted. Ctrl-C cancels a run in flight.

**Attachments.** `/attach ~/Downloads/statement.pdf`, or just drag the file into
the terminal — if the whole message is a path that exists, it asks
`Attach …? [Y/n]`. Staged files ride with exactly one next message.

**Inline approvals.** When a run stops on a gated call, the preview is printed
and the prompt becomes `Approve this? [y]es / [n]o / [l]ater`. `later` leaves it
pending, where `/approvals` and Telegram can still reach it.

### The dashboard

`buddi serve` serves it on `127.0.0.1:4317`. `buddi dashboard` prints a
single-use link, valid five minutes, and opens it. `buddi dashboard --token`
prints just the ticket, for piping; `buddi dashboard --off` explains the off
switch.

**It opens on a conversation.** The landing page is a workbench: a chat column
on the left, a canvas on the right. Ask for something and what the run *looked
at* is drawn beside what it said — a projection as a chart with its floor and
its worst day marked, a staged import as its rows, a gated action as its full
envelope with Approve and Reject under it. The canvas is rendered from the
conversation's own tool calls, so it fills in live as a run proceeds and works
just as well on a mission that ran at 6am and on a conversation from last month.

Nothing on the canvas is written for a particular plugin. The dashboard ships
seven **generic renderers** — `timeseries`, `table`, `bars`, `keyvalue`,
`document`, `envelope`, `structured` — and a plugin says which one its tool
output should use by shipping a *view descriptor*: data, not code, fetched from
`GET /api/chat/views` and applied in the browser (see
[docs/plugins.md](docs/plugins.md) §2.5). An installation with no finance plugin
ships no finance code. A tool with no descriptor still gets a readable
structured view, never a dump. An agent that has something worth showing which
no tool result covers can say so directly with `canvas.show`.

The monitoring pages are all still there, one click away behind the rail:

| Page | Shows |
| --- | --- |
| Overview | Pending approvals, failed jobs and open urgent findings first; the numbers second |
| Events | The event log, polled every 5s, filterable; a row opens the whole envelope |
| Conversations | Recent runs, and one run's full transcript — persona words, tool calls, raw results, cost |
| Missions | Scheduled work: next fire, misfire policy, whether it spoke last time |
| Approvals | What is waiting, with the tool-written preview; approve or reject |
| Jobs | The durable queue by state; retry or cancel |
| Reminders | One-off nudges the agents set; cancel a pending one |
| Sentinels | Installed watchers, last run, open and resolved findings |
| Agents | Tools, skills, pinned provider and which env var holds the credential — never the credential |

Every write it offers calls the same core function the CLI and Telegram call, so
a decision made here is the same atomic transition. Light, dark and system are a
toggle on the rail, remembered in the browser and nowhere else. Below about
900px the canvas becomes a sheet the chat opens, so the page works from a phone
over the tailnet.

The UI makes no external requests at all — no CDN, no web fonts, no telemetry.
Everything is bundled locally and the type stack is the system's own; that is a
test on both sides of the wire, not a promise.

**How the link works.** A long random token is generated on first run and kept
in the OS keychain under `BUDDI_WEB_TOKEN` (or `data/web-token`, mode 600, where
there is no vault). It never appears in a URL. What you are handed is a *ticket*
signed with it: single-use, five minutes, swapped for an HttpOnly
`SameSite=Strict` session cookie on a clean URL. Every write additionally needs
a double-submit CSRF header and an `Origin` that is the bound address. There is
no CORS. A request without a valid session gets `401` and an empty body, and
failed authentications are rate-limited per address.

| Variable | Default | |
| --- | --- | --- |
| `BUDDI_WEB` | `1` | `0` turns the dashboard off entirely |
| `BUDDI_WEB_HOST` | `127.0.0.1` | Anything but loopback exposes an approval button to your network — put it behind an authenticated transport, and `buddi doctor` will warn about it |
| `BUDDI_WEB_PORT` | `4317` | |

### Scripts

```sh
buddi ask "can I afford a 600 EUR bike on the 20th?"
buddi ask "…" --agent ledger --quiet
```

One turn, then exit. Exit code `0` answered, `1` failed, `2` stopped awaiting
your approval.

---

## Running it

```sh
buddi service install     # macOS: a launchd LaunchAgent, KeepAlive + RunAtLoad
buddi service status      # installed? running? which pid?
buddi service logs        # follow data/logs/serve.log and .err
buddi service restart     # after changing an agent file or .env
buddi service start       # load and run it (the unit stays where it is)
buddi service stop        # unload it; `start`, or the next login, brings it back
buddi service uninstall   # stops it and removes the unit; the logs stay
```

`install` refuses if `.env` is missing what `serve` needs, and warns if a
`serve` is already running — two pollers fight over the same bot. On Linux the
same commands write a systemd **user** unit; that path is best-effort and
untested.

**What runs on its own**, once the service is up — four independent loops, so a
wedged network call never holds the clock:

| | Every | |
| --- | --- | --- |
| Scheduler | cron | Decides which mission occurrences are due and *queues* them. It never runs one itself. Catch-up by construction: a machine that was asleep does not silently skip work |
| Sentinels | 30s | Runs each watcher whose interval has elapsed and hands its findings to core |
| Sources | 30s | Polls each due source and enqueues runs idempotently on its own dedup key |
| Reminders | 60s | Fires the one-off nudges agents set for themselves |
| Queue worker | 1s | Actually executes the queued runs, with leases, retries and suspension on approval |

**Quiet by default.** An unattended run does not get to *answer*; it gets to
**decide**, and it decides by calling a tool — `mission.report` to deliver
exactly that text, or `mission.silent` with a reason. A run that calls neither
is treated as silent. Sentinels work the same way: a plugin can only produce a
finding, and core alone decides what it costs you — `urgent` wakes you now and
then stays quiet 24 hours for the same key, `info` is noted for the weekly
digest and stays quiet a week. Silence is the default, not an optimization.

Missions:

```sh
buddi missions list
buddi missions add-defaults          # register every mission the installed plugins suggest
buddi missions run-now <id>
buddi missions enable <id>
buddi missions disable <id>
buddi reminders                      # what is on the clock
buddi nudges status                  # the first-run arc: what it has sent, and whether it is still on
buddi pause                          # stop claiming work; running jobs finish
buddi resume
buddi jobs --state failed
```

A plugin's suggested mission names an agent by **role**, not by id.
`add-defaults` registers what it can place and prints, for anything it cannot,
the one line that would fix it — a role no installed agent claims is a
configuration state, not a failure.

### After a reboot

Everything sits on one Postgres container, so if Docker Desktop did not start,
nothing works. Two things make that a non-event:

- Turn on **Docker Desktop → Settings → General → Start Docker Desktop when you
  sign in**. The container is `restart: unless-stopped`, so it comes back by
  itself whenever the daemon does.
- Or start it by hand: `buddi db up` (`buddi db status`, `buddi db down`).

The background service does not need either to be true *at the moment it
starts*: with no database it waits and retries — 5s, 10s, 20s, up to a minute —
instead of exiting, so launchd has nothing to crash-loop on. `buddi service
logs` shows it waiting. The foreground commands do the opposite and fail
immediately, naming the port and the fix.

---

## Backups

An archive of the database, your private agents and the artifact store.

**No secret is ever in a backup** — not the model credential, not the bot token,
not `BUDDI_VAULT_KEY`; the manifest lists their *names* and the exact
`buddi vault set <NAME>` lines that put them back, and you type those by hand.

**[docs/operations.md](./docs/operations.md)** has the rest: everything an
archive contains, everything deliberately left out and why, and the restore
step by step.

```sh
buddi backup create
buddi backup list
buddi backup verify <archive>
buddi backup restore <archive>
buddi backup prune
buddi backup schedule install    # the nightly job, prune included
```

---

## Operations reference

Every command the binary has, as `buddi help` prints it. If something here is
wrong, a test fails (`packages/cli/src/readme.test.ts`).

**Setup and health**

| | |
| --- | --- |
| `buddi init` | set this machine up (interactive, idempotent) |
| `buddi init --yes` | the same, asking nothing: for scripts and CI |
| `buddi doctor` | check every moving part and say what is wrong |
| `buddi status` | the same report, under the name you reached for |
| `buddi migrate` | apply core + plugin migrations |

**Database**

| | |
| --- | --- |
| `buddi db up` | start the postgres container (after a reboot) |
| `buddi db down` | stop it |
| `buddi db status` | is it up? |
| `buddi db secure` | give it a generated password, kept in the vault (idempotent) |

**Talking to agents**

| | |
| --- | --- |
| `buddi chat` | talk to the default agent |
| `buddi chat --agent <handle>` | … to a specific agent, by @handle or id |
| `buddi chat --resume <id>` / `--last` | continue a conversation |
| `buddi ask "<question>"` | one turn, then exit |

**The agent catalog**

| | |
| --- | --- |
| `buddi agents` | every agent, its engine and whether it can run |
| `buddi agents show <handle>` | one agent in full: tools, skills, engine, last run |
| `buddi agents set <handle>` | `[--provider p] [--model m] [--max-turns n]` |
| `buddi agents models` | the model catalogue, and what this machine can reach |
| `buddi agents test <handle>` | one cheap live turn on that agent's provider |
| `buddi agents migrate` | move `agents/` and `skills/` into your private directory |

**Running**

| | |
| --- | --- |
| `buddi serve` | run the Telegram surface + scheduler in this shell |
| `buddi service install` | run it in the background, at login |
| `buddi service start` / `stop` | load/unload without touching the unit |
| `buddi service status` / `logs` / `restart` / `uninstall` | |

**Surfaces**

| | |
| --- | --- |
| `buddi dashboard` | open the local dashboard (one-time link) |
| `buddi dashboard --token` | print just the one-time token |
| `buddi dashboard --off` | how to turn the dashboard off |
| `buddi telegram pair` | a QR code + deep link that pairs a device |
| `buddi telegram devices` | every paired device |
| `buddi telegram unpair <id>` | revoke one |

**Work**

| | |
| --- | --- |
| `buddi missions list` | every registered mission |
| `buddi missions add-defaults` | register what the installed plugins suggest |
| `buddi missions add-friday-recap` | just the recap mission |
| `buddi missions run-now <id>` | run one now |
| `buddi missions enable <id>` / `disable <id>` | |
| `buddi reminders` | `[--agent <id>] [--all]` — one-off nudges the agents set |
| `buddi reminders cancel <id>` | |
| `buddi nudges status` | the first-run arc: messages sent, unanswered, quiet-until, active or not |
| `buddi nudges stop` / `resume` | turn the arc off permanently, or ask for it back |
| `buddi pause` | stop claiming work (running jobs finish) |
| `buddi resume` | start claiming again |
| `buddi jobs` | `[--state <s>] [--kind <k>] [--limit <n>]` |
| `buddi jobs retry <id>` / `cancel <id>` | |

**Secrets**

| | |
| --- | --- |
| `buddi vault set <NAME>` | keep a secret in the OS keychain (prompts, hidden) |
| `buddi vault get <NAME>` / `delete <NAME>` / `list` | |
| `buddi vault import-env` | move `.env` secrets into the keychain |

**Backups** — see [docs/operations.md](./docs/operations.md).

| | |
| --- | --- |
| `buddi backup create` | one archive: database, private agents, artifacts |
| `buddi backup list` | every archive, newest first |
| `buddi backup verify <archive>` | checksums + manifest, no database needed |
| `buddi backup restore <archive>` | `[--into <db>] [--yes] [--force]` — refuses over a database that has rows in it |
| `buddi backup prune` | `[--keep n]` |
| `buddi backup schedule install` | the nightly job, prune included |

---

## Troubleshooting

**`database not reachable at localhost:55433`.** Docker is not running, or the
container is not up. `buddi db up`. If that fails, open Docker Desktop. If the
port in the message is not the port in your `DATABASE_URL`, you changed one and
not the other — `BUDDI_DB_PORT` and `DATABASE_URL` must agree.

**`buddi service status` says installed but not running.** The unit is on disk
and nothing is alive: `buddi service start`. If it starts and dies, `buddi
service logs` has the reason, and it is usually a missing value in `.env` — the
service reads the file, not your shell.

**Telegram is silent.** In order: is `TELEGRAM_BOT_TOKEN` set and accepted
(`buddi doctor`, `telegram bot` row)? Is anything polling (`buddi service
status`)? Is your chat paired (`buddi telegram devices`)? An unpaired sender
gets silence by design, so "no reply" and "not paired" look identical from the
phone. Also check that only *one* `serve` is running — two pollers fight over
the same bot and drop each other's updates.

**An agent is listed as unavailable.** `buddi agents` names the environment
variable it wanted. Credentials are never discovered ambiently: the agent's file
pins a provider, the provider names one variable, and a missing one fails closed
for that agent and nothing else. `buddi agents show <handle>` says more; `buddi
agents test <handle>` proves it end to end.

**The dashboard answers `401`.** The link expired — it is single-use and lives
five minutes. Run `buddi dashboard` again. If every link fails, the token
changed under you (a new keychain entry, or a deleted `data/web-token`); the
next `buddi dashboard` mints a fresh one. If the page will not load at all,
check `BUDDI_WEB` is not `0` and that `buddi serve` is running.

---

## Privacy and safety

**What is stored, and where.** All of it on your machine:

| | |
| --- | --- |
| Postgres container (`buddi-pgdata` volume) | Conversations, the event log, missions, jobs, approvals, reminders, paired devices, and every plugin's schema |
| `data/` | Artifacts (the files you hand it), logs, the dashboard token where there is no vault. Gitignored |
| `private/` | Your agents and skills. Gitignored |
| `.env` (mode 600) | Configuration, and secrets until you run `buddi vault import-env` |
| OS keychain | Secrets after that. No command ever prints one back |

`buddi-pgdata` is a Docker named volume: it is not in git, it is not in any
clone, and `docker compose down -v` (or Docker Desktop's *Clean / Purge data*)
deletes it outright. A backup is the only copy of it that survives that — see
[docs/operations.md](./docs/operations.md).

**Where the database listens, and what protects it.** The container publishes
`127.0.0.1:${BUDDI_DB_PORT:-5432}` — loopback, so only this machine can open a
connection at all; nothing on your network can reach it, not the router, not the
other laptop, not the café. The password is 32 random characters generated at
`buddi init`, kept in the OS keychain as `BUDDI_DB_PASSWORD`, and never written
to any file: `.env` holds the marker `DATABASE_URL="<vault>"`, and the
connection string is assembled in memory at startup. `buddi doctor` has a
`database exposure` row that fails — critically, so the command exits 1 — if the
port is bound to anything but a loopback address, or if the password is still
the literal `buddi` this project once shipped with. `buddi db secure` fixes both
and is safe to run twice.

**A backup holds the data and never the credentials.** An archive contains the
`pg_dump`, your private agents and skills, and the artifact files. It contains
no model credential, no bot token, no app password, and no database password:
`.env` is scrubbed to `NAME="<vault>"` markers before it is written, and the
scrubbed text is scanned for every secret value the original held — if one
survived, no archive is written at all. The manifest lists the *names* you will
have to set again after a restore, and the exact `buddi vault set …` commands
that do it. So a backup on a USB stick is your data, not a way into it.

**What leaves.** Prompts, and only prompts. Each agent's file pins a provider —
Anthropic or OpenAI — and that agent's conversation, including whatever its
tools returned into the context, goes there and nowhere else. A model is never
migrated for you and one provider's credential is never used for another's
agent. Delegation resolves the provider of the agent being delegated *to*, so
handing work sideways never quietly changes the destination. The dashboard makes
no external requests at all. There is no telemetry.

**The approval gate is in code.** Tools are tiered; anything that is not
`auto` stops the run and waits for you. Unknown tools, invalid arguments and
missing configuration never execute — they fail closed. A conversation cannot
grant a tool: an agent can call only what its own file names and what this
installation actually has, and no text from a model, an email or a document can
change that.

**Strangers get silence.** A message from an unpaired Telegram user is logged as
`surface.rejected` and never answered — a reply would confirm the bot exists.
The single exception is `/start <code>` with a *valid* pairing code; a wrong,
spent or expired one gets the same silence, rate-limited to five attempts an
hour.

**This is not advice.** The finance plugin computes arithmetic and the model
explains it. Nothing here is financial, legal, tax or medical advice, and an
agent can be confidently wrong about your money. Check anything that matters.

---

## Development

```sh
pnpm -r build
pnpm typecheck
pnpm test          # includes the check that core imports no tool package
```

Every `pnpm` script works from the repo (`pnpm chat`, `pnpm serve`,
`pnpm missions …`) — they call the same binary.

Packages: `core` (domain, db, event log, tool registry, provider port, and the
plugin contract), `runtime` (the agent loop and the provider adapters),
`gateway` (the surfaces: terminal, Telegram, scheduler, dashboard server),
`web` (the dashboard UI, React + Vite, built to static files), `cli` (the single
`buddi` binary, plus `init`, `doctor`, `service` and `backup`), and
`tools/{finance,email,memory,artifacts}` (the plugins). Core never imports a
tool: delete `packages/tools/finance` and the system still boots.
