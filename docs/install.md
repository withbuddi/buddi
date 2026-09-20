# Install: one command, then the dashboard

Status: proposed spec, 2026-09-20. Not built.

Someone who is not a developer but can type `npm` should get from nothing to a
working buddi, with their first agent answering in the browser, in ten minutes
and without reading a terminal. Today the path is `git clone`, Docker Desktop,
`.env`, `buddi init` and a handful of CLI commands. This spec replaces that
path for owners, keeps it for developers, and makes the dashboard the surface
that owns onboarding, upgrades and plugins.

This is not a desktop app. A packaged app (Electron or Tauri, DMG or MSI) is a
thin shell over everything below and is deferred until the install described
here has a second owner running it. Nothing here prevents that shell; most of
it is what the shell would need anyway.

---

## 1. What an owner does

```
npm install -g buddi
buddi
```

The first `buddi` with no data directory:

1. creates the data directory (§4),
2. provisions a private Postgres inside it (§3),
3. writes the minimum to boot the gateway: database URL, a session secret, a
   loopback port,
4. installs the background service and starts it (§6),
5. opens the browser on `http://127.0.0.1:4317/#/welcome`.

Everything else — provider and keys, who the owner is, the first agent,
Telegram, plugins — happens in the wizard (§5). The terminal prints one line
per step and the URL; it asks nothing. Every later `buddi` with no arguments
opens the dashboard.

`buddi init`, `buddi doctor`, `buddi service`, `buddi vault`, `buddi upgrade`
remain as they are for developers and for a headless machine. The wizard calls
the same functions through the API; there is one implementation of each step.

---

## 2. Distribution

`buddi` becomes one published npm package that carries the CLI, the gateway,
core, runtime, the built dashboard and the built-in tools. The monorepo stays;
publishing is a bundling step (`pnpm -r build`, then a single package assembled
from `packages/*/dist` with its runtime dependencies), not a restructuring.
`@buddi/core` is published alongside it, unbundled, because plugins import it
(§7).

Requirements on the machine: Node 22 or newer. Nothing else. No Docker, no
git, no pnpm, no build step. `postinstall` runs nothing; provisioning happens
on first run so a failed install leaves no half-state.

Versioning: the package version is the product version. `buddi upgrade`
becomes `npm install -g buddi@latest` followed by the existing
build-free sequence: backup, migrate, restart. The dashboard shows the running
version and says when a newer one is published (a version check against the
npm registry, once a day, owner can turn it off).

---

## 3. Postgres without Docker

Postgres stays. The queue's `skip locked` claims, the scheduler's locks, jsonb
everywhere, 27 core migrations and every plugin's own schema make a port to
SQLite a rewrite, not an option.

The install ships Postgres binaries for the platform through the
`embedded-postgres` family of npm packages (per-platform optional
dependencies, roughly 30 MB each; npm installs only the matching one). On
first run buddi:

- runs `initdb` into `<data>/postgres` with a generated superuser password
  stored in the vault,
- picks a free loopback port and records it,
- starts the server, creates the `buddi` role and database, and migrates.

The gateway owns the Postgres process: the service starts it before the
gateway and stops it after. `buddi doctor` reports its state. A stopped or
missing cluster is a doctor finding with a repair action, never a crash at
the moment an agent needs the database.

An owner with their own Postgres sets `DATABASE_URL` in the data directory's
`.env`, exactly as today, and no cluster is provisioned. Docker is no longer
mentioned anywhere in the install path; `docker compose` remains for the
development checkout only.

Backups: `buddi backup` already dumps the database. With a bundled cluster it
uses the bundled `pg_dump`, so a backup never depends on tools the owner did
not install. The wizard's last step offers to schedule one.

---

## 4. The data directory

One directory holds everything buddi owns:

| Platform | Default |
|---|---|
| macOS | `~/Library/Application Support/buddi` |
| Linux | `$XDG_DATA_HOME/buddi`, else `~/.local/share/buddi` |
| Windows | `%LOCALAPPDATA%\buddi` |

Inside: `postgres/` (the cluster), `artifacts/` (the store), `plugins/`
(§7), `logs/`, `backups/`, `.env` (the few settings that are not secrets) and
the file vault where there is no OS keychain. `BUDDI_DATA_DIR` overrides it,
as today. Nothing is written outside it except the service unit and the OS
keychain entries.

Secrets go in the vault, which already has a macOS keychain backend and an
encrypted-file backend. Linux gains a Secret Service backend (`secret-tool`
or the D-Bus API) where one is present, and falls back to the file vault
otherwise; Windows gains Credential Manager through the same interface. The
file vault's passphrase is derived from a per-install key kept alongside the
data, so an owner is never asked for a passphrase; the trade-off (the data
directory is the trust boundary) is stated in the security page of the wizard.

---

## 5. The first-run wizard

A route, `#/welcome`, shown until onboarding is complete and reachable from
Settings afterwards. Each step is one screen with one job, saved as it is
completed, resumable after a reload or a restart. Steps in order:

1. **Welcome and security.** What buddi is, that it runs on this machine only,
   what is stored where, and that the dashboard listens on loopback. One
   button.
2. **You.** Name, how the agents address you, timezone. The existing "You"
   settings page, reused.
3. **A model.** Pick a provider: Anthropic, OpenAI, or an OpenAI-compatible
   endpoint. Ollama is detected when it answers on its default port and
   offered as the local choice with a note on which models fit. The key is
   pasted once and lands in the vault; the wizard checks it with one cheap
   call and shows the answer. The provider-accounts work already covers the
   storage and the choice of model.
4. **Your first agent.** A name, a handle, a face, and a short description
   of what it is for. Created from the generic template, no roles, no
   plugins. The owner talks to it on the next screen.
5. **Say hello.** The chat, with the new agent, inside the wizard. The
   first answer arriving is the moment the install is real.
6. **Optional extras**, each one a card that can be skipped: Telegram
   (the existing pairing flow, with the token pasted here rather than in a
   terminal), plugins (§7), a daily backup.
7. **Done.** Where things are, how to open buddi again, how to upgrade.

The wizard uses the same API the settings pages use. There is no wizard-only
endpoint that writes anything; every step is an existing settings action or
becomes one. `core.onboarding` already records steps done; the wizard reads
and writes that record so the CLI and the dashboard agree on progress.

Developer install (`git clone`, `buddi init`) ends by opening the same route
at step 3, since steps 1 and 2 are what `init` already asked in the terminal.

---

## 6. Running in the background

The service manager already writes a launchd agent on macOS and a systemd
user unit on Linux. Windows gains a Task Scheduler entry at logon (no
service host, no admin). Each unit runs `buddi serve`, which now starts the
bundled Postgres first.

The dashboard shows service state on Settings and offers start, stop, restart
and "open at login" as switches. `buddi service` remains the CLI face of the
same manager. Logs are files in the data directory and are shown in the
dashboard's Activity page on request.

A menu-bar or tray presence is out of scope; it belongs to the deferred app
shell.

---

## 7. Plugins: distribution and install

Today a plugin is compiled into the gateway at its composition root and
installed from a built directory. That stays the developer path. For an
owner, a plugin is an npm package:

- **Contract unchanged.** A plugin package exports a `PluginManifest` from
  its entry point and depends on `@buddi/core` as a peer dependency. Its
  migrations, tools, sentinels, views and suggestions are as `docs/plugins.md`
  describes. Nothing in the manifest changes.
- **Naming.** Packages are discoverable by the keyword `buddi-plugin` and a
  `buddi` field in `package.json` naming the manifest export and the minimum
  core version. Unscoped names, scoped names and private registries all work;
  the name is whatever npm resolves.
- **Install.** `buddi plugins install <name>[@version]` and the same action
  in Settings → Plugins. The gateway runs `npm install --prefix <data>/plugins
  <name>` (npm is present because buddi came from it), loads the manifest,
  and runs the existing install plan: refuse a name or schema collision,
  refuse a manifest that fails validation, show the summary of what the
  plugin contributes and every host it intends to reach, and only then
  register it, apply its migrations into its own schema and record the
  install with its provenance (package, version, integrity hash). The plan
  exists (`packages/gateway/src/plugins/install.ts`); the npm source is the
  piece it was written to wait for.
- **Loading.** Installed plugins are loaded at gateway start from
  `<data>/plugins`, after the built-ins, through the same manifest loader.
  A plugin that fails to load is reported in doctor and on the Plugins page
  and is skipped; it never stops the gateway.
- **Trust.** Installing is `gated`: the owner approves the summary. A plugin
  runs in the gateway's process with the gateway's rights, as built-ins do;
  the safety properties remain the registry, the approval machinery and the
  network allowlist, not isolation. The Plugins page says so in one line.
  There is no marketplace and no curation; a plugin comes from a name the
  owner typed.
- **Update and remove.** `buddi plugins update <name>` reinstalls at the
  newer version and re-runs the plan (migrations forward only). Uninstall
  keeps the schema; `--purge` drops it, as today.
- **Agents that need a plugin.** A suggested agent whose role no plugin
  claims stays a suggestion; the Plugins page shows which suggestions each
  plugin would unlock, so "install finance" and "accept Ledger" are two
  steps the owner sees together.

Sharing a plugin between two owners is therefore `npm publish` on one side
and `buddi plugins install` on the other, or a tarball path for a plugin that
should never be public.

---

## 8. Platforms

- **macOS**: the reference platform. Everything above; computer control
  (browser plugin's computer mode) stays macOS-only as it is today.
- **Linux**: full support. systemd user unit, Secret Service or file vault,
  bundled Postgres. Browser automation through Playwright works; computer
  control does not, and says so.
- **Windows**: the core loop, the dashboard, the bundled Postgres, Telegram,
  email, memory and web plugins work. Host execution (`host.exec`) refuses on
  Windows today and stays refused until it is written against PowerShell
  with the same approval shape; browser automation via Playwright works. The
  Task Scheduler service and Credential Manager vault are the new pieces.
  Windows is supported for the generic install; plugins declare their own
  platform support in the manifest, and the Plugins page shows it.

Anything platform-specific is behind one function with a stated fallback;
`generic-install.test.ts` gains a run per platform in CI (macOS, Ubuntu,
Windows runners) that installs the published package into a clean home,
runs first-run headless, and asserts the gateway answers.

---

## 9. Security

- The dashboard listens on loopback only, unchanged. The wizard never
  proposes a network bind.
- Keys never touch a terminal, a log or `.env`; they go from the wizard's
  form to the vault over the loopback session with the CSRF header, as
  every write does.
- The bundled Postgres listens on loopback with a password only the vault
  holds; there is no trust authentication.
- Plugin install is approved by the owner with the contributions and hosts
  in front of them, and is recorded with the package integrity hash so
  doctor can say if what is on disk is what was approved.
- The version check and the plugin install are the only outbound calls the
  install path makes, both to the npm registry, both through the shared
  transport, both disclosed on the security screen.

---

## 10. Acceptance

1. A clean macOS user account with Node 22: `npm install -g buddi && buddi`
   opens the wizard within a minute; a pasted key and a first agent produce
   an answer without any other terminal command.
2. The same on Ubuntu and on Windows 11, with computer control and host
   execution declining in the words above rather than failing.
3. Reload or restart in the middle of the wizard resumes at the same step
   with everything already entered still there.
4. `npm install -g buddi@<next>` then `buddi upgrade` migrates and restarts
   with a backup taken first; the dashboard shows the new version.
5. `buddi plugins install <published plugin>` shows the plan, waits for
   approval, registers the plugin, and its tools appear in the agents'
   tool lists; uninstall removes them and `--purge` drops the schema.
6. A developer checkout with Docker keeps working with `buddi init`
   unchanged, ending in the same wizard at step 3.
7. `pnpm test` still passes `generic-install` with zero plugins, and the
   new CI job passes on the three platforms.

---

## 11. Order of work

1. Bundled Postgres under the gateway's control, `buddi` first run, data
   directory layout. This removes Docker from the owner path and is the
   only part with real risk.
2. The published package: bundling, `bin`, CI that installs it clean.
3. The wizard, reusing the settings pages; `init` ends in it.
4. Plugins from npm: the loader for `<data>/plugins`, the install action in
   Settings, provenance and doctor checks. `@buddi/core` published.
5. Linux and Windows: vault backends, Task Scheduler unit, the three-platform
   CI job.
6. Version check and the upgrade action in the dashboard.

The app shell, if it comes, wraps the result of steps 1 to 3 and adds
signing, auto-update and a tray. It is not on this list.
