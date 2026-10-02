<p align="center"><img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/header.png" alt="buddi, with the Buddi Blob" width="800"></p>

**A small AI team that lives on your computer.**

buddi is a personal agent platform you run yourself: AI teammates that use
tools, work on schedules, remember what matters, and ask before doing
anything consequential. Everything runs on your machine, with your keys.

**Just want to use it?** See [withbuddi.com](https://withbuddi.com), or
`npm install -g @withbuddi/buddi && buddi`. This page is for working on buddi
itself.

[withbuddi.com](https://withbuddi.com) · [npm](https://www.npmjs.com/package/@withbuddi/buddi) · [docs](docs/README.md) · [plugins](https://withbuddi.com/plugins/) · [Chrome extension](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)

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

**The core has no tools.** Every capability is a plugin. Built in: `system`,
`email`, `memory`, `artifacts`, `web`, `browser`, `host`, `reminder`,
`schedule`, `goal`, `learning` and `canvas`. Domain plugins (`weather`,
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

**Surfaces.** The dashboard (with a canvas beside the chat that shows what a
run looked at), Telegram, the terminal, `buddi mcp` for Claude Code, and the
Chrome extension for acting in the owner's own browser.

**Data.** One data directory holds the Postgres cluster, agents, skills,
files, logs and backups. Secrets live in the OS keychain (an encrypted file
vault on Linux); no command, page or tool prints one back, and values are
scrubbed from anything an agent sees. Each agent's context goes only to the
provider its file names. Besides that: a daily npm version check, plugin
installs on request, and the market list when Browse opens. No telemetry.
[docs/operations.md](docs/operations.md) has the full list.

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

Also: `examples/` (the shipped agents and skills, and an example plugin),
`scripts/` (migrations, release, docs generators, boundary checks), `docs/`
(the reference, also published at [withbuddi.com/docs](https://withbuddi.com/docs/)).

The domain plugins live in a separate repository, `buddi-plugins`, and
install like any other plugin. The roadmap is kept outside this repository.

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
checkout. `buddi init` is interactive and idempotent (`--yes` asks nothing):
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
migrated Postgres: point `DATABASE_URL` at a throwaway one, run
`node scripts/migrate.mjs`, then the suite. Set `BUDDI_VAULT=memory` so no
test touches the keychain.

**The packaged install.** `pnpm release:pack` builds the npm tarball;
`pnpm release:trial` puts it in a Docker image and starts it on a fresh
volume, without touching your machine.

## Writing agents

An agent is a folder with an `agent.md` and, optionally, `skills/` beside it.
Owners' agents live in their data directory; Agent Father writes them there
after an approval. The shipped ones are in `examples/agents` and
`packages/gateway/src/agents/starter`. Grants, step budgets, rollover and the
catalogue are in [docs/agents.md](docs/agents.md); providers and models in
[docs/providers.md](docs/providers.md).

## Writing plugins

A plugin is an npm package with a manifest: its tools and their tiers, its
own schema and migrations, its timers, the hosts it may reach, and optional
dashboard pages and widgets. Start from `examples/plugins/weather` and run it
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
  change to `packages/*/src` without one unless the commit message says
  `[no changelog]`.
- **Boundaries.** `node scripts/check-boundaries.mjs` (also in CI): core never
  imports a tool or an upper layer.
- **Docs.** A behaviour change updates its page in `docs/`. `pnpm docs:cli`
  and `pnpm docs:api` regenerate the CLI and API references.
- **CI.** A push to `main` runs the quick lane (web, gateway, typecheck, the
  rest) without a database. The full gate, with Postgres, runs on pull
  requests, nightly and before every release.
- **Releases.** A tag `v<version>` runs the gate, builds the tarball,
  publishes `@withbuddi/buddi` to npm with provenance and creates the GitHub
  release. The npm page is [scripts/release/npm-readme.md](scripts/release/npm-readme.md),
  not this file.

## Status

buddi is a 0.1 pre-release. macOS is the reference platform; Linux works and
is in trial; Windows is not supported yet. Native computer control is
macOS-only. Host commands are approved, not sandboxed
([docs/host-execution.md](docs/host-execution.md)). Nothing an agent says is
financial, legal or medical advice.

## License

[Apache License 2.0](LICENSE). Copyright 2026 withbuddi.
