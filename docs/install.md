# Install: one command, then the dashboard

Status: proposed spec, 2026-09-20. An experimental [packaged-install
foundation](install-foundation.md) is implemented separately, and the first-run
first run of §5 is now built on top of it (the thread of onboarding.md, minus the deferrals named
there). Plugins from npm and the backup contract are not built.

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
git, no pnpm, no build step. `buddi` itself has no install script. The one
package that would want one is the Postgres binary package, whose upstream
rebuilds the symlinks inside its binaries directory that way; it is not
needed, because first run copies that directory into the data directory,
checks the binaries are runnable and creates those links itself from the
manifest the package ships (`prepareBinaries`). Every install in this project,
the upgrade included, therefore passes `--ignore-scripts`. Provisioning of the
cluster happens on first run, so a failed install leaves no half-state.

Versioning: the package version is the product version. `buddi upgrade`
becomes `npm install -g buddi@latest` followed by the existing
build-free sequence: backup, migrate, restart. The dashboard shows the running
version and says when a newer one is published (a version check against the
npm registry, once a day, owner can turn it off).

As built, the supervisor runs that sequence itself — `backup`, `stopping`,
`installing`, then it hands over to the code it just installed, which migrates
and records the outcome. The install passes `--ignore-scripts` like every
other install here; the symlinks the Postgres package would have made are made
at the successor's first start instead. The prefix comes from the install root
that is running rather than from npm's configuration, so an installation made
with `--prefix` upgrades itself and not some other copy — and an installation
that turns out to sit inside somebody's project is refused in one sentence
rather than upgraded by rewriting that project's `package.json`.

What may be installed is one version: `1.2.3`, or `1.2.3-rc.1`. A range, a
tag, a URL or an npm alias is refused by the dashboard route, by the control
socket and by the supervisor alike; `latest` is a word the check resolves to a
version before npm is told anything, and after npm returns the installed
`package.json` has to say `buddi` at exactly that version or the upgrade is a
failure that leaves the running version running. The backup taken first is
encrypted exactly as the backup schedule says, so an installation with
encryption on and no vault is told so before anything stops.

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

The cluster manager itself lives in `@buddi/core` (`packages/core/src/postgres`),
so the checkout CLI and the packaged launcher run one implementation: the
binaries, `initdb`, the authenticated start and the liveness probe. The
postmaster is always this process's own child. A server left on the cluster by
a supervisor that was killed is stopped (`pg_ctl stop -m fast`) and started
again, never adopted, so there is exactly one lifecycle to reason about.

An owner with their own Postgres sets `DATABASE_URL` in the data directory's
`.env`, exactly as today, and no cluster is provisioned. Docker is no longer
mentioned anywhere in the install path; `docker compose` remains for the
development checkout only.

Backups are §8; they need no `pg_dump`, so the bundled cluster changes nothing.

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

## 5. First run: you meet buddi

**Built.** The seven screens this section used to describe are gone; the screen
script is [onboarding.md](onboarding.md), and that document is the contract.
What is here is only what the rest of this page depends on.

The route is unchanged: `#/welcome`, and the dashboard sends the owner there —
replacing the entry, not pushing it — when `core.onboarding` is still `pending`
*and* the installation has no usable model account. A record that is `done`,
`skipped` or `in-progress` (an interview another surface already claimed), and
any installation that already has an account, never sees it. Settings → System
has "Run setup again" regardless.

What the owner sees is one thread, not a tour: buddi asks four things in
message bubbles — a name, a clock, a brain for the assistant, and the assistant
itself — each answered inline where a reply would go, each answer staying above
with a "change" link. Then the assistant speaks first, on the model, and the
screen does not change; only the speaker does. Reload replays the answered
questions from the record, the profile and the accounts, and asks the first one
nobody has answered.

The server routes are `GET /api/onboarding`, `POST /api/onboarding/step`,
`/complete`, `/skip`, `/agent` and `/agent/update` (the script promises the
owner can change their assistant's name, face and purpose, and once one exists
that is an edit of its file rather than a second agent), plus
`GET /api/onboarding/ollama` (is Ollama
running on *this* machine — the page never reaches `localhost:11434` itself)
and `POST /api/telegram/token` and `/api/telegram/pairing`, which is Telegram
without a terminal: the token BotFather gave the owner goes into the vault, the
surface starts in the running gateway when the process can start it, and the
pairing code comes back as a link the thread draws as a QR code. All of them
are behind the dashboard's ordinary session, Origin and CSRF gate.
A step carries what its name cannot — the account the owner chose, and the
conversation the handover opened — and `GET /api/onboarding` answers with both
under `details`. That is what a reload mid-handover reads: the assistant is
introduced by one turn, sent on the owner's behalf, claimed against the record
so it can happen only once, marked as first run's on the message row and left
out of every transcript the owner reads.

`/complete` refuses while the installation still has no model account or no
agent — "done" has to mean done — and `/skip` is the explicit bypass that
always works. `done` and `skipped` are terminal in core, so the two endings
cannot overwrite each other. Finishing or skipping here also closes the
Telegram nudge arc, which has nothing to add to an owner who set up in the
dashboard.

Everything else uses the API the settings pages use: the owner profile, the
provider accounts (saved, then tested with one small call), and `/onboarding/agent`,
which has an endpoint of its own because the alternative — an approval-gated
tool call — is the wrong shape for the owner acting directly from their own
dashboard. It takes the id of the account the thread just tested, so the
assistant is bound to the brain the owner chose.

Developer install (`git clone`, `buddi init`) ends by opening the same route.

---

## 6. Running in the background

The service manager already writes a launchd agent on macOS and a systemd
user unit on Linux. Windows gains a Task Scheduler entry at logon (no
service host, no admin).

The unit runs a small supervisor, `buddi supervise`, not the gateway
directly. The supervisor owns the bundled Postgres and the gateway as two
children: it starts Postgres, waits for it to answer, then starts the
gateway; it restarts the gateway when it exits; and it keeps Postgres up
while the gateway is down. Maintenance therefore never needs the gateway:

- The supervisor's whole control surface is a Unix domain socket,
  `supervisor.sock` in the data directory, mode 0600 inside a 0700 directory.
  It answers `GET /status` and `POST /start|/stop|/restart`, the backup verbs,
  `GET /version`, `POST /version/check`, `PUT /version/check` and
  `POST /upgrade`, JSON in and out, with no token and no session: the
  filesystem is the credential, because only the owning user can open the
  socket. There is no second web surface to log in to.
- `buddi upgrade`, `buddi backup restore` and `buddi db migrate` talk to the
  supervisor over that socket: "stop the gateway, keep the database", do the
  work, "start the gateway". With no supervisor running (a headless developer
  checkout, or the service not installed) they start Postgres themselves for
  the duration and stop it after, as `buddi init` does today.
- The Start, Stop and Restart switches live in the dashboard, in Settings →
  System, and act through the supervisor rather than the gateway — so a
  restart leaves the database up. They are there only while the gateway is up
  to serve them: a stop or a restart closes the page it was pressed on, and
  the page says so before it asks. When the gateway is down, `buddi` in a
  terminal starts it again. A checkout with no supervisor shows no section at
  all.
- An interrupted upgrade is recoverable by construction: the backup is taken
  first, migrations run in one transaction each, and the supervisor records
  the step it was on in a state file; the next start reads it, finishes or
  rolls back, and reports in doctor. The gateway refuses to start against a
  schema newer than its own code and says which version it needs.

  As built: `installation.json` carries `phase: upgrading` plus the versions
  and the archive from the moment the new code is on disk until the supervisor
  running that code has migrated. On success the phase is `ready` again and
  `<data>/upgrade.json` gains a `done` entry; on failure the phase stays
  `upgrade-failed`, the gateway is deliberately not started, and doctor prints
  the one sentence that names the archive and the two commands back. Under
  launchd the hand-over is an exit: the agent has `KeepAlive` and its
  `ProgramArguments` name the launcher inside the install root, which the
  install has just replaced, so launchd starts the new code from the same path.
  That case is recognised by identity — `XPC_SERVICE_NAME` naming this
  installation's own agent — and not by having pid 1 as a parent, which every
  detached process has. Off launchd the supervisor spawns its own successor and
  waits up to a minute for it to answer `/status` with the new version, which
  is the readiness that matters (holding the lock is not: a successor can take
  the lock and then die bringing the cluster up). It tries a second time, and
  if nothing answers it writes the attempt down as failed at `starting`, with
  the recovery sentence, before it goes.

  Which upgrade is half done is the marker in `installation.json`, not the
  phase: a crash while migrating can leave any phase on disk, so a start
  finishes whatever `state.upgrade` names and clears it only together with the
  outcome. From the moment the new code is on disk the old gateway is never
  started again — what is down stays down until the new supervisor brings it
  up, rather than serving last month's code over a database the new code owns.

`buddi service` remains the CLI face of the same manager and gains
`buddi service status --json` for the page. Logs are files in the data
directory, one per child, shown in the dashboard's Activity page on request.

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
- **Install, in two halves with approval between them.** Importing a
  plugin's entry point executes its code; the existing loader says so. So
  nothing of the plugin runs before the owner has approved it:
  1. *Stage.* `npm pack` the package into a staging directory under
     `<data>/plugins/staging`, and install its dependencies there with
     `--ignore-scripts`. Nothing is imported. Read only static metadata:
     `package.json` (name, version, the `buddi` field, dependencies,
     whether any dependency declares lifecycle scripts, the peer range on
     `@buddi/core`), the registry's integrity hash and publisher, and the
     `buddi.md` the package ships, which is where a plugin states in prose
     what it does, which schema it owns and which hosts it reaches. A
     manifest cannot be validated at this point, and the page says the
     summary is the package's claim.
  2. *Approve.* The owner sees name, version, publisher, integrity hash,
     dependency count and any with install scripts, the claimed schema and
     hosts, and this sentence: **a plugin runs inside buddi's process with
     everything buddi can do; it is not sandboxed, and a plugin that wants to
     can bypass tool approvals and the network allowlist. Install only what
     you would run as yourself.** Approval is `gated` and recorded with the
     integrity hash.
  3. *Load and plan.* Only now is the entry point imported. The existing
     plan runs: the manifest is validated, a name or schema collision is
     refused, the claims in `buddi.md` are compared with the manifest's
     contributions and hosts and any difference is shown and needs a second
     approval. Then it is registered, its migrations are applied into its
     own schema, and the install is recorded with its provenance.
  The plan exists (`packages/gateway/src/plugins/install.ts`); staging and
  the npm source are the pieces it was written to wait for. A package the
  owner rejects is deleted from staging.
- **Loading.** Installed plugins are loaded at gateway start from
  `<data>/plugins`, after the built-ins, through the same manifest loader.
  A plugin that fails to load is reported in doctor and on the Plugins page
  and is skipped; it never stops the gateway.
- **Trust, stated plainly.** The registry, the approval machinery and the
  network allowlist protect the owner from what the *model* does through a
  well-behaved plugin. They do not protect against the plugin's own code,
  which runs with the process's full privileges and can reach the database,
  the vault and the network directly. Isolation is not on this roadmap;
  the honest control is the approval above, the recorded hash, and doctor
  reporting when what is on disk no longer matches what was approved. There
  is no marketplace and no curation; a plugin comes from a name the owner
  typed, and the Plugins page repeats the sentence from step 2.
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

## 8. Backup and restore

`buddi backup` already exists with `create`, `list`, `verify`, `restore`,
`prune` and `schedule`, and the archive is a plain `tar.gz` that opens without
buddi: the database as text, the artifact files, `.env` with every secret removed,
plugin migration records, and a manifest with per-file hashes, table counts
and the version that wrote it. Restore verifies before it touches anything and
refuses to overwrite a live database without the name typed back. This section
keeps all of that and adds four things: the bundled cluster, the dashboard,
encryption, and a copy off the machine.

### 8.1 With the bundled cluster

There is no `pg_dump`: the bundled Postgres (`@embedded-postgres/*`, and the
zonky jars behind it) ships `initdb`, `pg_ctl` and `postgres` and nothing else,
so an engine that shelled out to one would work only on a developer machine
with Homebrew Postgres on it. Instead every table in the buddi-owned schemas
(`core`, plus each plugin schema recorded in `core.migrations`) is copied out
with `COPY … TO STDOUT` over the ordinary connection, inside one repeatable-read
transaction so the whole archive is one snapshot of a live installation, and
restore rebuilds the schema from our own migrations up to the level the dump
recorded, loads the data back with `session_replication_role = replica`, resets
the sequences and then applies the migrations the dump did not have. For a
cross-version restore that means the *code* has to know the schema, not the
server: any Postgres this build runs on can read any archive this build wrote,
newer or older cluster alike, and `pg_upgrade` is never needed.

The engine is `packages/core/src/backup` so the CLI, the supervisor and the
dashboard all call the same one. The manifest records the Postgres major
version, the `@buddi/core` version that wrote the archive (never `git
describe`, which says nothing on a packaged install) and the migration level of
every schema. The upgrade command takes a backup before it migrates, as today.

What an archive holds, so that a fresh machine comes back whole:

- the database dump;
- the artifact files;
- the private agents and skills directories, as today;
- `.env` with every secret value removed;
- the plugin record: for each installed plugin, its name, version, integrity
  hash and *source* — a registry name, a tarball path, or a directory — so
  restore can reinstall what it can and name what it cannot (a tarball that
  was on the old machine's disk is the owner's to supply again);
- the manifest described in §8.3.

### 8.2 In the dashboard

Settings gains a Backup page: the schedule as a switch and a time, the list of
archives with age, size and whether each verified, "Back up now", and
"Restore…". Restore in the dashboard has the same guard as the CLI: the
archive is verified first, the page shows what it holds and when it was taken,
and overwriting a live installation asks for the database name typed back. It
asks the supervisor (§6) to stop the gateway and keep the database, restores,
and starts the gateway; the browser waits on the health route and reloads.

**A restored installation starts in recovery mode.** The dump carries pending
jobs, missions, approvals in flight, granted permissions and paired surfaces,
none of which should act on a machine they were not granted on. Recovery mode
is a flag in `core` set by restore and cleared only by the owner:

- the scheduler does not tick, sources do not poll, the queue does not claim,
  Telegram does not connect, and no mission runs; chat works;
- the Backup page shows a checklist: secrets to paste again, by name, each a
  link; plugins to reinstall or supply, from the plugin record; approvals and
  jobs that were pending, with "drop" as the default; standing permission
  grants, listed, with "keep" as a choice the owner makes per grant;
- "Leave recovery mode" is one gated action at the end of the checklist. Until
  it is taken, doctor and the Home page say the installation is in recovery.

**Files after the database.** The database is restored first, then the
artifact files and private directories. If any file step fails, restore rolls
the database back to the snapshot it took of the *target* before starting
(a plain backup of the live installation into `backups/pre-restore-<time>`), so a
half-restore cannot exist; the pre-restore snapshot is kept and named in the
report. `--force` skips nothing here either.

### 8.3 Encryption

An archive that leaves the machine is encrypted; one that stays may be. The
scheme is `age` passphrase encryption, exactly as the age specification
defines it (scrypt recipient stanza), with no buddi-specific key derivation
in front of it, so `age -d` with the passphrase opens any archive without
buddi:

- At setup, buddi generates the passphrase (six words from a fixed list),
  shows it once for the owner to write down, and stores it in the vault so
  scheduled backups and same-machine restores never ask for it. A fresh
  machine asks for it once. The owner may replace it with their own; the page
  measures nothing and warns nothing, because the generated one is the
  recommended path.
- The whole tar is encrypted, manifest included. Filenames, agent names,
  hosts and row counts are private too. Beside the encrypted archive sits a
  minimal outer envelope, `<name>.json`: format version, creation time,
  buddi version, byte size and a hash of the ciphertext. That is all `list`
  shows without the passphrase, and it is treated as untrusted: after
  decryption the inner manifest is authoritative and the envelope is checked
  against it; a mismatch fails verification.
- "Encrypt local backups" is a switch, off by default for the local
  directory and forced on for every remote target. There is no way to send
  an unencrypted archive off the machine.
- Losing the passphrase loses encrypted backups. The Backup page says so
  where the passphrase is shown, and once more when a remote target is
  enabled.

### 8.4 A copy off the machine

Two tiers, the first covering most of the value at almost no cost.

**Tier one: a folder.** The owner points buddi at a directory that something
else syncs: the Google Drive, Dropbox, iCloud Drive or OneDrive desktop
client's folder, a Syncthing share, a mounted disk. After each scheduled
backup, the encrypted archive and its manifest are copied there and pruned
there by the same retention. No credentials, no API, no network code. The
Backup page validates that the folder exists and is writable, and shows the
last copy's age. Restore from a folder is "pick the file".

**Tier two: the provider's API.** Google Drive and Dropbox, through OAuth in
the browser: buddi opens the consent page, receives the redirect on loopback,
and keeps the refresh token in the vault. Scope is the narrowest each offers:
Drive's per-application folder (`drive.appdata` or `drive.file`), Dropbox's
app folder. After each backup the encrypted archive is uploaded; `list`,
`verify` and `restore` work against the remote listing; retention prunes
remotely. This is the tier that makes "restore on a brand-new machine from
the wizard" possible without a desktop client. It adds two hosts to the
network allowlist, both named on the Backup page, and a provider outage
degrades to "the copy is late", reported by doctor, never a failed backup.

The provider layer is one interface (`put`, `list`, `get`, `delete`) behind
both tiers; the folder is the first implementation and the reference for the
tests. Adding a third provider is one file.

### 8.5 Restore in the wizard

The welcome screen gains a second button: "I have a backup". It leads to a
step before "You": choose the source (a file, a folder, or sign in to Drive
or Dropbox), pick the archive, enter the passphrase, see what it holds, and
restore. The wizard then continues at the model step, since keys are never in
a backup, and the "You" step is skipped because the profile came back. This
is also how an owner moves from the developer checkout to the npm install,
and from one machine to the next.

### 8.6 What is never backed up

The vault, on purpose: secrets are the owner's to re-enter, and a backup that
holds them is a backup that can be used against the owner. The bundled
Postgres binaries and the installed plugin packages, which are reinstalled
from npm; the archive records their names and versions so restore can say
what to reinstall. Logs.

---

## 9. Platforms

The third browser mode, **Your browser**, is Chrome on every platform: the
tarball carries the unpacked extension at `<root>/extension`, the owner loads it
through `chrome://extensions` → Developer mode → Load unpacked, and pairs it
with a six-digit code in Computer & browser. Nothing about it is macOS-only.

- **macOS**: the reference platform. Everything above; computer control
  (browser plugin's computer mode) stays macOS-only as it is today.
- **Linux**: full support. systemd user unit, Secret Service or file vault,
  bundled Postgres. Browser automation through Playwright works, and so does
  "Your browser" — the Chrome extension in `<root>/extension`, loaded unpacked
  and paired from Settings; computer control does not, and says so.
- **Windows**: the core loop, the dashboard, the bundled Postgres, Telegram,
  email, memory and web plugins work. Host execution (`host.exec`) refuses on
  Windows today and stays refused until it is written against PowerShell
  with the same approval shape; browser automation via Playwright works, as
  does "Your browser" through the Chrome extension. The
  Task Scheduler service and Credential Manager vault are the new pieces.
  Windows is supported for the generic install; plugins declare their own
  platform support in the manifest, and the Plugins page shows it.

Anything platform-specific is behind one function with a stated fallback;
`generic-install.test.ts` gains a run per platform in CI (macOS, Ubuntu,
Windows runners) that installs the published package into a clean home,
runs first-run headless, and asserts the gateway answers.

---

## 10. Security

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
- Signing in through Tailscale is off until an owner turns it on in Settings
  → System and names the login that may sign in. It never trusts the proxy's
  headers on their own: the connection must arrive on loopback from a Serve
  running on this machine, the forwarded address must be a tailnet address,
  and the local `tailscaled` must confirm over its own socket that the address
  belongs to that login. The session it mints is a remote one — 12 hours,
  Secure cookies, CSRF and Origin checks — and the setting cannot be changed
  from a Tailscale session, so a stolen device cannot widen access.
- The version check and the plugin install are the only outbound calls the
  install path makes, both to the npm registry, both through the shared
  transport, both disclosed on the security screen. A cloud backup target
  adds its provider's hosts, named on the Backup page, and nothing leaves
  for them unencrypted.

---

## 11. Acceptance

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
8. A scheduled backup lands encrypted in a synced folder; on a clean machine
   the wizard's "I have a backup" restores it from that folder with the
   passphrase, and the first agent answers after the key is pasted once.
9. The same through Dropbox or Google Drive sign-in, with no desktop client
   installed; the archive on the provider is unreadable without the
   passphrase, and `age -d` plus `tar` open it without buddi.
10. A restored installation runs no mission, poll, queue claim or Telegram
    connection until the owner leaves recovery mode; a restore whose file
    step fails leaves the target database exactly as it was.
11. Installing a plugin whose package has an install script, or whose entry
    point throws on import, executes nothing before the owner has approved
    the staged summary; rejecting it leaves nothing on disk.
12. With the gateway stopped, the dashboard tab can start it; `buddi upgrade`
    interrupted after the backup and before the restart is completed or
    rolled back on the next start, and doctor says which.

---

## 12. Order of work

1. The published package: bundling, `bin`, CI that installs it clean.
2. Bundled Postgres under the supervisor, `buddi` first run, data directory
   layout, the maintenance path for upgrade and restore.
3. The wizard, reusing the settings pages; `init` ends in it.
4. Encrypted backup to a folder, restore in the wizard with recovery mode,
   the Backup page. Prove a fresh machine comes back whole before anything
   widens.
5. Plugins from npm: staging, approval before import, the loader for
   `<data>/plugins`, provenance and doctor checks. `@buddi/core` published.
6. Linux and Windows: vault backends, Task Scheduler unit, the three-platform
   CI job.
7. Version check and the upgrade action in the dashboard.
8. The provider APIs for backup (Drive, Dropbox), after the folder target
   has been used for real.

Three parts carry real risk and get the same care: the managed cluster,
plugin code executing in the process, and restore.

The app shell, if it comes, wraps the result of steps 1 to 3 and adds
signing, auto-update and a tray. It is not on this list.
