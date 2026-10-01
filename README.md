<p align="center"><img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/header.png" alt="buddi, with the Buddi Blob" width="800"></p>

**A small AI team that lives on your computer.**

AI teammates that use tools, work on schedules, remember what matters, and
ask before doing anything consequential.

[withbuddi.com](https://withbuddi.com) · [npm](https://www.npmjs.com/package/@withbuddi/buddi) · [docs](docs/README.md) · [plugins](https://withbuddi.com/plugins)

Give each teammate a job. Planner prepares your mornings. Mail Triage watches
your inbox. Ledger keeps an eye on your money. Add your own for anything
else.

They use tools, work with your files, browse the web in a browser of their
own, and keep working on schedules while you're away. **Anything
consequential stops for your approval**, as a card on the dashboard or on
your phone.

**Everything stays home.** Conversations, files and memory live in a private
database on your machine. When a teammate uses a remote AI, the context it
needs for that request goes to the provider and model you chose for that
teammate. The whole list of what leaves is short enough to print, and it is
[printed below](#where-your-data-lives-and-what-leaves-the-machine). Your
passwords live in a vault the team can use but never see.

Your first teammate is Buddi, the front desk, and the Buddi Blob is its face.
Rename it, rewrite its personality, or add others. Under the hood every
teammate is a markdown file, which the docs and the dashboard call an agent
where that is the accurate word.

<img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/home.png" alt="The buddi dashboard's Home: Good evening, Sam, then three widgets — the weather in Lisbon, what is coming up and a world clock with four analog faces — and the team." width="100%">

<img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/lock-screen.png" alt="The lock screen on the Dawn background: the date and the time large, a world clock, the weather and the next events, and a PIN field." width="100%">

---

## Install

You need Node 22 or newer. Nothing else: no Docker, no pnpm, no build step.

```sh
npm install -g @withbuddi/buddi
buddi
```

The first `buddi` does five things, one line each in the terminal, and asks
nothing:

1. creates the data directory,
2. sets up a private Postgres inside it, on a loopback port, with a password
   only the vault holds,
3. writes the few settings the service needs to start,
4. installs the background service and starts it: a launchd agent on macOS, a
   systemd user unit on Linux,
5. opens the setup wizard in your browser.

Every later `buddi` opens the dashboard. The link it prints is a sign-in link
good for five minutes; run `buddi` or `buddi dashboard` again for a new one.

The dashboard listens on `127.0.0.1:4317`. To use another port:

```sh
BUDDI_WEB_PORT=4417 buddi
```

**The browser.** The agents' own browser needs a browser binary, and the
package ships none. If Google Chrome is installed, buddi uses it. If not, the
wizard offers to fetch Chromium (about 150 MB), or you can run
`buddi browser install` at any time.

**Telegram.** The wizard can pair your phone: you ask @BotFather for a bot,
paste the token, and scan the QR code it draws. Skipped it, or want a second
phone? Settings → Notifications has the same steps, and lists the phones you
paired. `buddi telegram pair` does the same from a terminal. What arrives on
the phone, what you can send and the commands are in
[docs/telegram.md](docs/telegram.md).

**On Linux.** There is no OS keychain, so secrets go in an encrypted file vault
in the data directory, opened by a key stored beside it (`vault-key`, mode
600). Anyone who can read your data directory can open the vault; a backup is
different, it is sealed with your passphrase. On a server with no display the
agents' browser runs headless. The systemd user unit stops when you log out
unless you run this once:

```sh
loginctl enable-linger $USER
```

**Pre-releases.** Until 0.1 is out, every pre-release is published as
`latest`, so the plain install above is the newest one. After 0.1.0,
pre-releases go under `next`:

```sh
npm install -g @withbuddi/buddi@next   # after 0.1.0 only
```

To remove it: `buddi uninstall`, then `npm uninstall -g @withbuddi/buddi`.

The full install story, including what is not built yet, is
[docs/install.md](docs/install.md).

---

## The first ten minutes

**The wizard.** Five short chapters, with a map on the left so you always
know where you are and can go back:

1. **Hello**: your name and your clock, taken from the browser.
2. **A brain**: the AI your team thinks with. Free to start with Ollama Cloud
   in one tap; or your Claude or ChatGPT account; or an API key from
   Anthropic, OpenAI or Google; or Ollama on this computer. buddi tests it
   with one small call before moving on.
3. **What buddi takes on**: your days (weather and calendars, with Planner's
   morning brief), your mail, your money, voice, your code, pictures. Each
   tile installs its plugin in the background, from withbuddi.com, while you
   answer the rest; nothing runs before you have seen its card.
4. **Reach me**: your phone through Telegram, a mailbox for Mail Triage, buddi
   as an app and a browser of its own. All optional.
5. **Your assistant**: a name, a colour for the Blob, and a persona you can
   keep or rewrite.

Then your assistant speaks first, in the real chat, already knowing your
clock, the weather at home and who is on the team, and one card lists what is
still waiting. Every chapter keeps a "change" link, and a reload resumes where
you were. [docs/onboarding.md](docs/onboarding.md) is the full script.

**The first chat.** A few things to try:

- "What can you do?" It answers from the tools its file grants it.
- "Remind me to call the bank tomorrow at 10." A reminder it sets itself, and
  you can see it on the Reminders page.
- "Take a screenshot of example.com." It opens its own browser, asks you
  first, and shows the page on the canvas beside the chat.
- Drop a PDF or a CSV on the chat and ask about it.
- Click the camera in the composer, pick another tab of your browser, and ask
  about what it shows.
- "Every Friday at 6, send me a recap of the week." A mission, on a schedule.

**A mailbox.** In Settings → Mail, or in chapter 4 of the wizard, add an
account with its address and an app password. buddi then offers Mail Triage,
the teammate who reads new mail in the background. Accept it with one click;
until you do, mail is fetched and threaded but nobody reads it. Sending always stops at an approval card
that shows the full message. [docs/email.md](docs/email.md) has the rest.

**More teammates.** Home and the Agents page offer a starter team: Scout,
Planner and Keeper, one tap each. For anything else, Agent Father (@father)
interviews you, proposes the file and the tools it should have, and writes it
once you approve.

---

## How it works

**A teammate is a file.** One folder per agent, with an `agent.md` in it. The
front matter says which tools it may call; nothing else is callable, and no
conversation can grant more. The body is the persona, in plain
markdown. The provider and model are a line in the same file, and the
dashboard's Agents page edits them for you.

```markdown
---
id: ledger
handle: ledger
name: Ledger
description: Tracks my accounts and answers "can I afford this?".
provider: anthropic
model: claude-sonnet-5
tools: [finance.*, memory.*, reminder.*]
---

You are my finance advisor. There is exactly one owner: the person you are
talking to. Today is {{today}}.
```

**Tools and plugins.** The core has no tools; every capability is a plugin.
Built in: `system`, `email`, `memory`, `artifacts`, `web`, `browser`, `host`,
`reminder`, `schedule`, `goal`, `learning` and `canvas`. Installable from
[withbuddi.com/plugins](https://withbuddi.com/plugins), on the Plugins page's
Browse tab or with `buddi plugins install`: `weather`, `calendar`, `finance`,
`image`, `speech` and more. Installing a plugin shows everything it brings first: each tool
and whether it runs without asking, the database schema it will own, what it
runs on a timer, and the hosts it talks to. Nothing happens until you approve.
[docs/plugins.md](docs/plugins.md) is the guide to writing one.

**Approvals.** Every tool has a tier. Anything that is not safe to run on its
own, such as sending mail, running a command or acting in a browser, stops the
run and shows a card with exactly what will happen. You approve or reject it
on the dashboard or on Telegram. Unknown tools, bad arguments and missing
configuration never run. [docs/architecture.md](docs/architecture.md) has the model.

**Missions and watchers.** A mission is scheduled work. A watcher checks
something on an interval and produces findings; core decides whether a finding
is worth waking you for. An unattended run stays quiet unless it has something
to say, and when background work keeps failing you hear about it once, in
plain words. Goals add a target with a date: buddi checks it hourly and wakes
the agent that holds it when you drift ([docs/goals.md](docs/goals.md)).

**Groups.** A group is one persistent conversation with a team of agents. A
coordinator decides who works on each request, and you get one answer.
[docs/groups.md](docs/groups.md).

**Files.** What you send the agents and what they produce sit in one library,
the Files page, with the conversation each came from.
[docs/files.md](docs/files.md).

**Memory and learning.** Agents keep notes about you, with where each came
from, scoped per agent. Learning goes one step further: buddi proposes a
skill, a mail rule or a change to an agent's file, and nothing is kept until
you keep it. A weekly digest lists what is waiting.
[docs/learning.md](docs/learning.md).

**Owner secrets.** Your passwords, API tokens and one-time codes go in
Settings → Keys and secrets. An agent can have one filled into a login form,
typed, or sent as a header, after an approval card that names where it goes.
There is no way to read a value back, and values are scrubbed from anything an
agent sees. [docs/owner-secrets.md](docs/owner-secrets.md).

**The canvas.** The dashboard opens on a conversation, with a canvas beside
it. What a run looked at is drawn there: a table, a chart, a document, a web
page, an approval with its full envelope. It fills in live, and works the same
for a mission that ran at 6am. [docs/browser.md](docs/browser.md) covers the
browser views on it.

**Claude Code.** `buddi mcp` runs buddi as an MCP server over stdio. Reads
answer at once; every write becomes an approval card; `buddi.ask` talks to an
agent. [docs/mcp.md](docs/mcp.md).

```sh
claude mcp add -s user buddi -- buddi mcp
```

---

## Where your data lives and what leaves the machine

Everything buddi owns sits in one data directory:

| Platform | Data directory |
| --- | --- |
| macOS | `~/Library/Application Support/buddi` |
| Linux | `$XDG_DATA_HOME/buddi`, else `~/.local/share/buddi` |

`BUDDI_DATA_DIR` moves it. Inside are the Postgres cluster, your agents and
skills, the files library, logs and backups. Nothing is written outside it
except the service unit and, on macOS, the keychain entries.

**Secrets** go in the vault: the macOS keychain, or the encrypted file vault on
Linux. No command, page or tool prints one back.

**Backups** hold the database, your agents and your files, and never a secret.
They are encrypted with a six-word passphrase that only you keep. Turn on the
nightly schedule in Settings → Backup, or with
`buddi backup schedule install`.

**What leaves.** Each agent's conversation, including what its tools returned,
goes to the provider its file names, and nowhere else. A model is never
switched for you, and delegating to another agent uses that agent's provider.
Besides that, buddi makes three kinds of outbound call: a version check against
the npm registry once a day, which you can turn off in Settings, a plugin
install when you ask for one, and the plugin list from withbuddi.com, when you
open Browse. The dashboard loads nothing from the internet.
There is no telemetry.

[docs/operations.md](docs/operations.md) has the details: what an archive
contains, the passphrase, restoring, and recovery.

---

## Everyday commands

Most of this is on the dashboard. From a terminal:

| Command | What it does |
| --- | --- |
| `buddi` | open the dashboard (the first run sets everything up) |
| `buddi status` | one screen: service, database, agents, what needs you |
| `buddi ask "…"` | one question, one answer, then exit; `--json` for scripts |
| `buddi chat` | talk to the default agent in the terminal |
| `buddi upgrade` | back up, install the new version, migrate, restart |
| `buddi backup create` | one archive of everything, now |

`buddi help` lists every command, and `buddi help <command>` explains one.
The whole tree is in [docs/cli.md](docs/cli.md).

---

## Development

The developer checkout runs the same code against a Postgres in Docker. You
need git, Node 22 or newer, pnpm 11 and Docker.

```sh
git clone https://github.com/withbuddi/buddi && cd buddi
./scripts/install.sh      # checks the tools, then pnpm install, build, link
buddi init                # the terminal wizard: .env, database, service
pnpm test
```

`./scripts/install.sh` runs `pnpm install`, `pnpm -r build` and
`pnpm run link`, which puts a global `buddi` on your PATH that points at this
checkout. `buddi init` is interactive and idempotent; `buddi init --yes` asks
nothing. It starts the Postgres container, applies migrations, installs the
service and opens the same wizard in the browser.

Commands you will meet in a checkout:

```sh
buddi db up               # start the Postgres container after a reboot
buddi db secure           # give it a generated password, kept in the vault
buddi migrate             # apply core and plugin migrations
buddi serve               # the gateway and scheduler in the foreground
buddi vault set NAME      # put a secret in the vault (prompts, hidden)
buddi plugins dev ../my-plugin
buddi missions list
buddi jobs --state failed
buddi pause               # stop claiming work; running jobs finish
buddi resume              # start claiming again
buddi nudges status
```

To try the packaged install without touching your machine, `pnpm release:trial`
builds the tarball, puts it in a Docker image and starts it on a fresh volume.
`pnpm release:pack` builds only the tarball.

**Layout.** Under `packages/`:

- `core`: domain, database, event log, queue, the tool registry and the plugin
  contract. It never imports a tool.
- `runtime`: the agent loop and the provider adapters.
- `gateway`: the surfaces (dashboard server, Telegram, terminal) and the
  scheduler.
- `web`: the dashboard, React and Vite, built to static files.
- `cli`: the `buddi` binary for a checkout.
- `install`: the packaged launcher, the supervisor and the bundled Postgres.
- `extension`: the Chrome extension for the "Your browser" mode.
- `tools/*`: the built-in plugins (artifacts, browser, email, host, memory,
  web).

The domain plugins (finance, developer, image) live in a separate repository,
`buddi-plugins`, and install like any other plugin.

**CI and releases.** A push to `main` runs the quick lane: four parallel jobs
(web, gateway, typecheck, the rest), without a database. The full gate, with
Postgres, runs on pull requests, nightly, on demand and before every release.
A tag `v<version>` runs the gate, builds the tarball, publishes it to npm
(pre-release versions under `latest` until 0.1.0 exists and under `next`
after it, others under `latest`) and creates the
GitHub release.

**Changelog.** Every change an owner or plugin author could notice gets a line
under Unreleased in `CHANGELOG.md`, in the same commit; CI refuses a change to
`packages/*/src` without one unless the commit message says `[no changelog]`.
Before a tag, `node scripts/release/changelog.mjs cut <version>` turns
Unreleased into that version's section, which the release lifts into its notes.

Read next: [docs/architecture.md](docs/architecture.md) for the design,
[docs/plugins.md](docs/plugins.md) to write a plugin, and
[docs/README.md](docs/README.md) for the index of everything else. The roadmap
is kept outside this repository.

---

## Status

buddi is a 0.1 pre-release. macOS is the reference platform. Linux works and
is in trial: the file vault, the bundled Postgres and the systemd user unit
are built, and fixes land as the trial finds them. Windows is not supported
yet. Native computer control (operating your own apps) is macOS-only. Signing
in with a Claude subscription (on the plan's monthly Agent SDK credits) or a
ChatGPT subscription is offered by default;
`BUDDI_SUBSCRIPTION_SIGNINS=off` hides both
([docs/anthropic-oauth.md](docs/anthropic-oauth.md),
[docs/codex-accounts.md](docs/codex-accounts.md)). Host commands are approved,
not sandboxed ([docs/host-execution.md](docs/host-execution.md)). Nothing an
agent says is financial, legal or medical advice.

## License

[Apache License 2.0](LICENSE). Copyright 2026 withbuddi.
