<p align="center"><img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/header.png" alt="buddi, with the Buddi Blob" width="800"></p>

**A small AI team that lives on your computer.**

buddi is a personal agent platform you run yourself: AI teammates that use
tools, work on schedules, remember what matters, and ask before doing
anything consequential. Everything runs on your machine, with your keys.

**Just want to use it?** On a Mac, [download buddi.app](https://withbuddi.com/download/mac)
(or `brew install withbuddi/tap/buddi`). On Linux, or a Mac from the terminal:
`npm install -g @withbuddi/buddi && buddi`. This page is for working on buddi
itself.

[withbuddi.com](https://withbuddi.com) · [Download for Mac](https://withbuddi.com/download/mac) · [Homebrew](https://github.com/withbuddi/homebrew-tap) · [npm](https://www.npmjs.com/package/@withbuddi/buddi) · [docs](docs/README.md) · [plugins](https://withbuddi.com/plugins/) · [Chrome extension](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)

<img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/home.png" alt="The buddi dashboard's Home: Good evening, Sam, then three widgets — the weather in Lisbon, what is coming up and a world clock — and the team." width="100%">

---

## Architecture

**A teammate is a file.** One folder per agent, with an `agent.md` in it. The
front matter says which tools it may call; nothing else is callable, and no
conversation can grant more. The body is the persona, in plain markdown.

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

**The core has no tools.** Every capability is a plugin. Compiled in:
`email`, `memory`, `artifacts`, `web`, `browser`, `host` and MCP connections
(`packages/tools/*`), beside the gateway's own families (`system`, `reminder`,
`schedule`, `goal`, `learning`, `canvas`, `owner`, `platform`). Domain plugins (`weather`,
`calendar`, `finance`, `image`, `speech`, …) install from the
[market](https://withbuddi.com/plugins/). An install shows every tool and its
tier, the database schema the plugin will own, its timers and the hosts it
talks to, and nothing runs until the owner approves.

**Approvals.** Every tool has a tier. Anything not safe to run on its own
(sending mail, a shell command, acting in a browser) stops the run and shows
a card with exactly what will happen, on the dashboard or Telegram. Unknown
tools, bad arguments and missing configuration never run.

**Work in the background.** Missions are scheduled runs; watchers check
something on an interval and core decides whether a finding is worth waking
the owner for; goals add a target with a date. All of it goes through one
Postgres-backed queue.

**Surfaces.** The dashboard, in a browser or buddi.app's window (with a canvas beside the chat that shows what a
run looked at), Telegram, the terminal, `buddi mcp` for Claude Code, and the
Chrome extension for acting in the owner's own browser.

**Data.** In a packaged install one data directory holds the Postgres
cluster, agents, skills, files, logs and backups; a checkout keeps Postgres
in a Docker volume. Secrets live in the OS keychain (an encrypted file
vault on Linux); no command, page or tool prints one back, and values are
scrubbed from anything an agent sees. Each agent's context goes only to the
provider its file names. Besides that: a daily npm version check (buddi.app's
own shell updates come from its Sparkle feed), plugin installs on request, and the
market list when Browse or the agent catalogue opens. No telemetry.
[docs/install.md](docs/install.md) §10 has the full list.

[docs/architecture.md](docs/architecture.md) is the design in full.

## Repository layout

Under `packages/`:

- `core`: domain, database, event log, queue, the tool registry and the
  plugin contract. It never imports a tool.
- `runtime`: the agent loop and the provider adapters.
- `gateway`: the surfaces (dashboard server, Telegram, terminal), the
  scheduler, the agent catalogue.
- `web`: the dashboard, React and Vite, built to static files.
- `cli`: the `buddi` binary for a checkout.
- `install`: the packaged launcher, the supervisor and the bundled Postgres.
- `extension`: the Chrome extension for the "Your browser" mode.
- `tools/*`: the built-in plugins (artifacts, browser, email, host, mcp,
  memory, web).

Also: `apps/mac` (buddi.app, the native Mac shell around the npm release),
`examples/` (the shipped agents and skills, and an example plugin),
`scripts/` (install, migrations, test database, release and review, docs
generators, boundary checks), `release/` (the release request CI reads),
`docker-compose.yml` (the checkout's Postgres), `docs/` (the reference, also
published at [withbuddi.com/docs](https://withbuddi.com/docs/)).

The domain plugins live in a separate repository,
[buddi-plugins](https://github.com/withbuddi/buddi-plugins), and install like
any other plugin. The plugin and agent listings on withbuddi.com come from
[buddi-market](https://github.com/withbuddi/buddi-market). The roadmap is kept
outside this repository.

## Development

You need git, Node 22 or newer, pnpm 11 and Docker. The checkout runs the
same code as the npm package, against a Postgres in Docker.

```sh
git clone https://github.com/withbuddi/buddi && cd buddi
./scripts/install.sh      # checks the tools, then pnpm install, build, link
buddi init                # the terminal wizard: .env, database, service
pnpm test
```

`./scripts/install.sh` runs `pnpm install`, `pnpm -r build` and
`pnpm run link`, which puts a global `buddi` on your PATH pointing at this
checkout (`pnpm buddi …` from the checkout works without the link, and is
the unambiguous form on a machine that also has buddi.app or the npm
package). `buddi init` is interactive and idempotent (`--yes` asks nothing):
it starts the Postgres container, applies migrations, installs the service
and opens the setup wizard in the browser.

The loop after a change:

```sh
pnpm -r build
buddi service restart     # or pnpm dev:refresh: build, migrate, restart
```

Commands you will meet in a checkout:

```sh
buddi db up               # start the Postgres container after a reboot
buddi migrate             # apply core and plugin migrations
buddi serve               # the gateway and scheduler in the foreground
buddi vault set NAME      # put a secret in the vault (prompts, hidden)
buddi plugins dev ../my-plugin
buddi jobs --state failed
buddi pause | buddi resume
```

`buddi help` lists every command; the tree is in [docs/cli.md](docs/cli.md).

**Tests.** `pnpm test` runs the boundary checks, build, typecheck and every
package's tests. Database suites (`*.db.test.ts`, the gateway) need a
migrated Postgres; `pnpm test:db` brings a throwaway one:

```sh
pnpm -r build                                   # migration reads the built packages
pnpm test:db                                    # the whole of pnpm test
pnpm test:db -- --filter @buddi/gateway         # one package (repeat --filter for more)
pnpm test:db -- --filter @buddi/gateway --keep  # leave the container up afterwards
```

It starts `postgres:16` in Docker on a free port, migrates it, runs the
suite with `DATABASE_URL` pointing at it, `BUDDI_VAULT=memory` (no test
touches the keychain) and `BUDDI_PLUGINS_FILE` in a scratch folder under
`node_modules/.cache`, then removes the container, on Ctrl-C too. It refuses
to run when `DATABASE_URL` already points at the dev database's port 55433.

**Releasing.** `pnpm release pre.N` (or `0.1.0-pre.N`) checks the tree is
clean, on main and level with origin, stamps new routes into `API_SINCE`,
moves the `## Unreleased` lines of `CHANGELOG.md` under a dated heading,
refreshes `docs/api.md` and `docs/cli.md`, commits `Release 0.1.0-pre.N`
with `release/REQUEST.json`, pushes main (no tag) and prints the workflow run
to watch. CI tags `v0.1.0-pre.N` once the full gate is green and publishes
from the tag; a red gate is fixed with a normal push on top
([docs/release.md](docs/release.md)). `--dry-run` shows the plan and writes
nothing.

**Reviewing a release.** Before `pnpm release`, `pnpm review` finds the last
`v0.1.0-pre.N` tag, writes the release-review prompt (the Unreleased lines of
`CHANGELOG.md` and a standard focus list; `--focus "…"` adds to it) and runs
`codex exec --sandbox read-only` over `git diff <tag>..HEAD` into
`codex-review-pre.<N+1>.md` (in `$BUDDI_REVIEW_DIR`, a temp folder by default,
or `--out <dir>`). It then prints the brief for a second, independent review
agent; save that agent's findings to a file and `pnpm review --merge <file>`
puts both into `review-pre.<N+1>.md`. `--print` shows the prompt and the brief
and runs nothing.

**The packaged install.** `pnpm release:pack` builds the npm tarball;
`pnpm release:trial` puts it in a Docker image and starts it on a fresh
volume, without touching your machine.

## Writing agents

An agent is a folder with an `agent.md` and, optionally, `skills/` beside it.
Owners' agents live in their data directory; Agent Father writes them there
after an approval. A fresh install ships two, in `examples/agents`
(the front desk and Agent Father); the catalogue agents are packages in
[buddi-market](https://github.com/withbuddi/buddi-market). Grants, step budgets, rollover and the
catalogue are in [docs/agents.md](docs/agents.md); providers and models in
[docs/providers.md](docs/providers.md).

## Writing plugins

A plugin is an npm package with a manifest: its tools and their tiers, its
own schema and migrations, its timers, the hosts it may reach, and optional
dashboard pages and widgets. `buddi plugins init <name>` writes one you can
build and install (`examples/plugins/weather` is a worked example); run it
with `buddi plugins dev <folder>`.

- [docs/plugins.md](docs/plugins.md): the guide.
- [docs/plugin-host-api.md](docs/plugin-host-api.md): `ctx.buddi`, what a
  plugin can call.
- [docs/plugin-pages.md](docs/plugin-pages.md): pages and widgets.

To list a plugin on withbuddi.com, publish it to npm and open a pull request
on the market repository.

## Contributing

Issues and pull requests are welcome at
[github.com/withbuddi/buddi](https://github.com/withbuddi/buddi/issues).

- **Changelog.** Every change an owner or plugin author could notice gets a
  line under Unreleased in `CHANGELOG.md`, in the same commit. CI refuses a
  push that changes `packages/*/src` (or `packages/tools/*/src`) without one,
  unless the head commit's message says `[no changelog]`.
- **Boundaries.** `node scripts/check-boundaries.mjs` (also in CI): core never
  imports a tool or an upper layer.
- **Docs.** A behaviour change updates its page in `docs/`. `pnpm docs:cli`
  and `pnpm docs:api` regenerate the CLI and API references.
- **CI.** Every push to `main` runs the changelog check and the full gate
  (`gate.yml`: boundaries, build, typecheck, every suite including the
  database ones against Postgres, the generic-install check, the scripts'
  tests). The gate also runs on pull requests, nightly and before every
  release. `pnpm check` (boundaries and typecheck) is the quick local subset.
- **Releases.** A release commit on main runs the gate; on green CI tags
  `v<version>`, and a run on that tag builds the tarball, publishes
  `@withbuddi/buddi` to npm with provenance, creates the GitHub release (the
  tarball, the extension zip, the Linux install script), rebuilds
  withbuddi.com, and builds the signed, notarized buddi.app DMG and its
  Sparkle feed. The Homebrew cask follows from the tap's own workflow; the
  Chrome Web Store upload is by hand. The npm page is [scripts/release/npm-readme.md](scripts/release/npm-readme.md),
  not this file.

## Status

buddi is a 0.1 pre-release (`0.1.0-pre.N`, the latest on
[GitHub releases](https://github.com/withbuddi/buddi/releases)). macOS is the
reference platform, shipped as buddi.app, the Homebrew cask and the npm
package; Linux installs from npm and is in trial; Windows is not supported
yet. Computer control (the Computer plugin) is macOS-only. Host commands are approved, not sandboxed
([docs/host-execution.md](docs/host-execution.md)). Nothing an agent says is
financial, legal or medical advice.

## License

[Apache License 2.0](LICENSE). Copyright 2026 withbuddi.
