---
title: "Install: one command, then the dashboard"
status: reference
updated: 2026-09-27
---

# Install: one command, then the dashboard

You install buddi with npm, run `buddi` once, and the rest happens in your
browser: the key for a model, who you are, your first agent. There is nothing
to read in a terminal and nothing to answer there. From then on the dashboard
is where you set buddi up, upgrade it and add plugins. A source checkout is
for people working on buddi itself (§14). §13 lists what is not there yet.

buddi is not a desktop app. There is no DMG or MSI; it runs as a background
service on your machine and you reach it in the browser.

---

## 1. Install

```
npm install -g @withbuddi/buddi
buddi
```

The first `buddi`, when there is no data directory yet:

1. creates the data directory (§4),
2. sets up a private Postgres inside it (§3),
3. writes what the gateway needs to start: the database URL, a session secret
   and a loopback port,
4. installs the background service and starts it (§6),
5. opens your browser on `http://127.0.0.1:4317/#/welcome`.

Everything else — the provider and its key, who you are, the first agent,
Telegram, plugins — happens in the browser (§5). The terminal prints one line
per step and the link, and asks nothing. Every later `buddi` with no arguments
opens the dashboard.

On a machine without a screen, `buddi doctor`, `buddi service`, `buddi vault`
and `buddi upgrade` do the same work from a terminal. The dashboard calls the
same code through its API, so each step has one implementation.

---

## 2. What npm installs, and upgrades

`@withbuddi/buddi` is one npm package. It carries the command line, the
gateway, core, the runtime, the dashboard and the built-in tools.
`@buddi/core` is published beside it, on its own, because plugins import it
(§7).

What the machine needs: Node 22 or newer. Nothing else — no Docker, no git,
no pnpm, no build step. `buddi` has no install script. The Postgres binaries
come in a package whose upstream uses one to recreate symlinks inside its
binaries directory; buddi does not need it, because the first run copies that
directory into the data directory, checks the binaries run and makes those
links itself from the manifest the package ships (`prepareBinaries`). So every
install buddi runs, upgrades included, passes `--ignore-scripts`. The database
is set up on the first run, not during the install, so a failed install leaves
nothing half done.

The package version is buddi's version. The dashboard shows the version that
is running and says when a newer one is published: it asks the npm registry
once a day, and you can turn that off.

**Upgrading.** `buddi upgrade`, or Upgrade in Settings → System, runs one
sequence through the supervisor: `backup`, `stopping`, `installing`
(`npm install -g @withbuddi/buddi@<version>`, with `--ignore-scripts` like every
install here), then it hands over to the code it has just installed, which
migrates and records how it went. The Postgres symlinks are made when the new
version first starts. The install prefix is the install root that is running,
not npm's configuration, so an installation made with `--prefix` upgrades
itself and not another copy. An installation that sits inside somebody's
project is refused in one sentence rather than upgraded by rewriting that
project's `package.json`.

What can be installed is one exact version: `1.2.3`, or `1.2.3-rc.1`. A range,
a tag, a URL or an npm alias is refused by the dashboard, by the control socket
and by the supervisor alike. `latest` is turned into a version before npm is
told anything, and once npm returns, the installed `package.json` must say
`buddi` at exactly that version; otherwise the upgrade fails and the running
version keeps running. The backup taken first is encrypted the way your backup
schedule says, so an installation with encryption on and no vault is told so
before anything stops.

---

## 3. Postgres, without Docker

buddi keeps its data in Postgres. The work queue, the scheduler's locks, jsonb
throughout, core's migrations and every plugin's own schema all depend on it.

The package brings Postgres binaries for your platform through the
`embedded-postgres` npm packages: one optional dependency per platform,
roughly 30 MB each, and npm installs only the one that matches. On the first
run buddi:

- runs `initdb` into `<data>/postgres`, with a generated superuser password
  kept in the vault,
- picks a free loopback port and records it,
- starts the server, creates the `buddi` role and database, and migrates.

The service starts Postgres before the gateway and stops it after.
`buddi doctor` reports its state. A stopped or missing database is a doctor
finding with a repair, never a crash at the moment an agent needs it.

The server is always the supervisor's own child. If a supervisor was killed and
left a server running on the cluster, the next one stops it
(`pg_ctl stop -m fast`) and starts it again rather than adopting it.

**Your own Postgres.** Set `DATABASE_URL` in the data directory's `.env` and
buddi uses that database; no cluster is created. Docker plays no part in the
install; `docker compose` is only for a source checkout.

Backups (§8) need no `pg_dump`, so the bundled Postgres is enough for them.

**"Postgres failed to start" with `dyld: Library not loaded` (or a missing
`.so` on Linux).** The platform package ships its libraries as real files and
lists the version links between them in `native/pg-symlinks.json`; its install
script makes those links, and npm with scripts off (or npm 11 holding scripts
back) never runs it. buddi now makes the missing links itself before every
Postgres start, keeps its runtime copy under `<data>/runtime` self-contained,
and an upgrade checks that the new version's Postgres starts before switching
to it. On 0.1.0-pre.26 or older, make the links by hand and restart:
`cd "$(npm root -g)/@withbuddi/buddi/node_modules/@embedded-postgres/<platform>" && node scripts/hydrate-symlinks.js`
(`<platform>` is e.g. `darwin-arm64` or `linux-x64`).

---

## 4. The data directory

One directory holds everything buddi keeps:

| Platform | Default |
|---|---|
| macOS | `~/Library/Application Support/buddi` |
| Linux | `$XDG_DATA_HOME/buddi`, else `~/.local/share/buddi` |
| Windows | `%LOCALAPPDATA%\buddi` |

Inside: `postgres/` (the database), `artifacts/` (your files), `plugins/`
(§7), `logs/`, `backups/`, `browser/engines/` (the agents' Chromium, when buddi
downloaded it), `.env` (the few settings that are not secrets) and, where there
is no OS keychain, the file vault. `BUDDI_DATA_DIR` moves it. Nothing is written
outside it except the service's unit file and the keychain entries.

**Secrets** go in the vault: the macOS keychain on a Mac, and an encrypted file
everywhere else (`<data>/vault.json`, opened with the key in `<data>/vault-key`,
mode `0600`, made on the first run). Linux uses the file vault on purpose: a
Secret Service backend would only help desktop Linux with a keyring running, and
a server has none. Windows has no Credential Manager vault yet (§13).

What the file vault protects, plainly — `buddi doctor` says the same: the file
at rest, and against another account on the machine. The key sits beside the
encrypted file in your `0700` data directory, so anyone who can read that
directory can open the vault, exactly as they could read the database beside
it. A backup is different: it is sealed with your passphrase, and the key never
leaves the machine. A key handed in by systemd (`LoadCredential=`, sealed by a
TPM where there is one) would be stronger on a server; it needs a system-wide
unit and is not there yet.

---

## 5. First run: you meet buddi

[onboarding.md](onboarding.md) describes the first run screen by screen. What
follows is only what the rest of this page relies on.

The dashboard sends you to `#/welcome` — replacing the page in your history,
not adding one — while first run is still `pending` *and* the installation has
no usable model account. Once it is `done`, `skipped` or `in-progress` (another
surface already started it), or once there is an account, you never see it
again. A finished first run cannot be reopened: everything it set has its own
place in Settings and on the agent's Setup tab.

It is one conversation, not a tour. buddi asks four things in message bubbles —
your name, your time zone, a brain for your assistant, and the assistant
itself — and you answer each inline, where a reply would go; each answer stays
above with a "change" link. Then your assistant speaks first, on its model, and
the screen stays where it is; only the speaker changes. Reloading replays what
you answered, from the record, your profile and your accounts, and asks the
first question nobody has answered.

Behind it are `GET /api/onboarding`, `POST /api/onboarding/step`, `/complete`,
`/skip`, `/agent` and `/agent/update` (you can change your assistant's name,
face and purpose, and once it exists that edits its file rather than making a
second agent), plus `GET /api/onboarding/ollama` (is Ollama running on *this*
machine; the page never calls `localhost:11434` itself), and
`POST /api/telegram/token` and `/api/telegram/pairing`, which set Telegram up
without a terminal: the token BotFather gave you goes into the vault, the bot
starts in the running gateway when it can, and the pairing link comes back for
the page to draw as a QR code. Settings → Notifications uses the same two, plus
`GET /api/telegram/bot`, `GET /api/telegram/devices` and
`DELETE /api/telegram/devices/:id` ([notifications.md](notifications.md),
"Telegram"). All of them sit behind the dashboard's session, Origin and CSRF
checks.

A step keeps what its name cannot — the account you chose, and the
conversation the handover opened — and `GET /api/onboarding` returns both
under `details`. A reload in the middle of the handover reads them: your
assistant is introduced by one turn sent on your behalf, claimed against the
record so it happens only once, marked as first run's, and left out of every
transcript you read.

`/complete` refuses while there is still no model account or no agent, so
"done" means done; `/skip` always works. `done` and `skipped` are final, so the
two cannot overwrite each other. Finishing or skipping here also ends the
Telegram nudges, which have nothing to add once you set up in the dashboard.

Everything else uses what Settings uses: your profile, the provider accounts
(saved, then tested with one small call), and `/onboarding/agent`, which exists
because you are acting from your own dashboard and an approval-gated tool call
is the wrong shape for that. It takes the id of the account you just tested,
so your assistant runs on the brain you chose.

A source checkout's setup ends on the same page (§14).

---

## 6. Running in the background

buddi runs as a launchd agent on macOS and a systemd user unit on Linux.
Windows has no service yet; the plan is a Task Scheduler entry at logon, with
no service host and no admin rights (§13).

The unit runs a small supervisor, `buddi supervise`, not the gateway itself.
The supervisor owns two children, Postgres and the gateway: it starts Postgres,
waits for it to answer, then starts the gateway; it restarts the gateway when it
exits; and it keeps Postgres up while the gateway is down. So maintenance never
needs the gateway:

- **The control socket.** The supervisor's only control surface is a Unix
  socket, `supervisor.sock` in the data directory, mode 0600 in a 0700
  directory. It answers `GET /status`, `POST /start|/stop|/restart`, the backup
  verbs, `GET /version`, `POST /version/check`, `PUT /version/check` and
  `POST /upgrade`, JSON in and out, with no token and no session: only your
  user can open the socket, and that is the credential. There is no second web
  page to sign in to.
- **Maintenance commands.** `buddi upgrade`, `buddi backup restore` and
  `buddi migrate` ask the supervisor over that socket to stop the gateway and
  keep the database, do their work, and start the gateway again. With no
  supervisor running (no service installed, or a source checkout) they start
  Postgres themselves for as long as they need it.
- **Start, Stop and Restart** are in Settings → System, and act through the
  supervisor, so a restart keeps the database up. They are there only while the
  gateway is up to serve the page: a stop or a restart closes the page you
  pressed it on, and the page says so before it asks. When the gateway is down,
  `buddi` in a terminal starts it again. A checkout with no supervisor shows no
  such section.
- **An interrupted upgrade recovers.** The backup comes first, each migration
  runs in its own transaction, and the supervisor writes down the step it is
  on; the next start reads it, finishes or rolls back, and `buddi doctor`
  reports it. The gateway refuses to start on a database newer than its code
  and says which version it needs.

What an upgrade writes down: `installation.json` holds `phase: upgrading`, the
two versions and the backup archive from the moment the new code is on disk
until the supervisor running that code has migrated. When it succeeds the phase
is `ready` again and `<data>/upgrade.json` gains a `done` entry. When it fails
the phase stays `upgrade-failed`, the gateway is not started, and doctor prints
one sentence naming the archive and the two commands that take you back.

How the new code takes over: under launchd the old supervisor simply exits.
The agent has `KeepAlive`, and its `ProgramArguments` name the launcher inside
the install root the upgrade has just replaced, so launchd starts the new code
from the same path. buddi knows it runs under its own launchd agent from
`XPC_SERVICE_NAME`, not from having pid 1 as a parent, which every detached
process has. Elsewhere the supervisor starts its successor itself and waits up
to a minute for it to answer `/status` with the new version — the readiness that
counts, since a successor can take the lock and then fail to bring the database
up. It tries twice; if nothing answers, it records the attempt as failed at
`starting`, with the recovery sentence, before it exits.

Which upgrade is half done is the marker in `installation.json`, not the phase:
a crash while migrating can leave any phase on disk, so a start finishes
whatever `state.upgrade` names and clears it only together with the outcome.
From the moment the new code is on disk, the old gateway never starts again;
what is down stays down until the new supervisor brings it up, rather than old
code running over a database the new code owns.

`buddi service` is the command-line side of the same manager, and
`buddi service status --json` is what the page reads. Logs are files in the
data directory, one per child; Activity shows them on request. There is no
menu-bar or tray icon.

---

## 7. Plugins

A plugin you install is an npm package. (A plugin compiled into the gateway and
installed from a built directory is the developer path.)

- **The contract.** A plugin package exports a `PluginManifest` from its entry
  point and depends on `@buddi/core` as a peer dependency. Its migrations,
  tools, sentinels, views and suggestions are as [plugins.md](plugins.md)
  describes.
- **Names.** Plugins carry the npm keyword `buddi-plugin` and a `buddi` field
  in `package.json` naming the manifest export and the lowest core version
  they need. Unscoped names, scoped names and private registries all work; the
  name is whatever npm resolves.
- **Installing happens in two halves, with your approval between them.**
  Importing a plugin's entry point runs its code, so nothing of the plugin runs
  before you approve it:
  1. *Stage.* buddi runs `npm pack` on the package into
     `<data>/plugins/staging` and installs its dependencies there with
     `--ignore-scripts`. Nothing is imported. It reads only what is static:
     `package.json` (name, version, the `buddi` field, dependencies, whether any
     dependency has lifecycle scripts, the peer range on `@buddi/core`), the
     registry's integrity hash and publisher, and the `buddi.md` the package
     ships, where a plugin says in prose what it does, which schema it owns and
     which hosts it reaches. The manifest cannot be checked yet, and the page
     says the summary is the package's own claim.
  2. *Approve.* You see the name, version, publisher, integrity hash, how many
     dependencies it has and which have install scripts, the schema and hosts
     it claims, and this sentence: **a plugin runs inside buddi's process with
     everything buddi can do; it is not sandboxed, and a plugin that wants to
     can bypass tool approvals and the network allowlist. Install only what
     you would run as yourself.** The approval is `gated` and recorded with the
     integrity hash.
  3. *Load and plan.* Only now is the entry point imported. The manifest is
     validated; a clash of names or schemas is refused; what `buddi.md` claimed
     is compared with the manifest's contributions and hosts, and any
     difference is shown to you and needs a second approval. Then the plugin
     is registered, its migrations run in its own schema, and the install is
     recorded with where it came from.
  A package you reject is deleted from staging.
- **Loading.** Installed plugins load when the gateway starts, from
  `<data>/plugins`, after the built-in ones. A plugin that fails to load is
  reported in doctor and on the Plugins page and skipped; it never stops the
  gateway.
- **Trust, plainly.** The approvals and the network allowlist protect you from
  what the *model* does through a well-behaved plugin. They do not protect you
  from the plugin's own code, which runs with the process's full rights and
  can reach the database, the vault and the network directly. There is no
  isolation. What you have is the approval above, the recorded hash, and doctor
  telling you when what is on disk no longer matches what you approved. There
  is no marketplace and no curation: a plugin comes from a name you typed, and
  the Plugins page repeats the sentence from step 2.
- **Update and remove.** `buddi plugins update <name>` stages the newer
  version and runs the plan again (migrations only go forward).
  `buddi plugins uninstall <name>` keeps the schema; `--purge` drops it.
- **Agents that need a plugin.** A suggested agent whose role no plugin covers
  stays a suggestion. The Plugins page shows which suggestions each plugin
  would unlock, so installing finance and accepting Ledger are two steps you
  see side by side.

Sharing a plugin with someone else is `npm publish` on one side and
`buddi plugins install <name>` on the other, or a tarball path for a plugin
that should never be public.

---

## 8. Backup and restore

[operations.md](operations.md) is the page for backup and restore: what an
archive holds, the passphrase, the schedule, the Backup page, restore, the
snapshot taken before a restore, and recovery mode. Read it first. This section
covers what is particular to an npm install.

### 8.1 No `pg_dump` needed

The bundled Postgres (`@embedded-postgres/*`, and the zonky jars behind it)
has `initdb`, `pg_ctl` and `postgres` and nothing else. So buddi's backup
reads and writes the database over its ordinary connection
(`packages/core/src/backup`), and the command line, the supervisor and the
dashboard all use that one engine. A restore rebuilds the schema from buddi's
own migrations rather than asking the server to. The result: buddi's *code*
knows the schema, so any Postgres this version runs on can read any archive
this version wrote, from a newer or an older server alike, and you never need
`pg_upgrade`. The archive's manifest records the `@buddi/core` version.
[operations.md](operations.md) has the archive layout and the manifest fields.

The archive also holds **the plugin record**: each installed plugin's name,
version, integrity hash and *source* — a registry name, a tarball path or a
directory — so a restore reinstalls what it can and names what it cannot (a
tarball that was on the old machine's disk is yours to supply again). The
Postgres binaries and the plugin packages themselves are never in an archive;
they are reinstalled.

### 8.2 A copy off the machine

**A folder.** Point buddi at a folder something else syncs: the Google Drive,
Dropbox, iCloud Drive or OneDrive desktop app's folder, a Syncthing share, a
mounted disk. After each scheduled backup, the encrypted archive and its
envelope are copied there and pruned there by the same retention. No
credentials, no API, no network code. The Backup page checks that the folder
exists and can be written, and shows how old the last copy is. Restoring from
a folder is picking the file. Every copy that leaves the machine is encrypted;
there is no way to send an unencrypted archive off it.

Signing in to Google Drive or Dropbox directly, with no desktop app, is not
there yet (§13).

### 8.3 Restoring on first run

Before its first question, first run offers **I have a backup from another
buddi**: pick the backup file, give its passphrase if it was locked with one,
and press Restore. The thread says where the restore has got to, one line per
step. A backup never carries keys, so the model step asks for your key once
more; your name and profile come back with the backup, so buddi welcomes you
back instead of asking who you are. The restored installation starts in
recovery mode, as [operations.md](operations.md) describes. This is also how
you move from a source checkout to the npm install, and from one machine to the
next. Restoring straight from Google Drive or Dropbox needs the sign-in that is
not there yet (§13); a synced folder's file works today.

---

## 9. Platforms

**The agents' own browser** (the default mode) needs a browser, and the package
ships none: Playwright's Chromium arrives only through its installer. The first
run prints one line saying which browser it found — Google Chrome, or a
Chromium already installed — or "not installed yet — buddi browser install
(about 150 MB)", and repeats that line on later runs until there is one.
`buddi browser install`, or **Install Chromium** in Settings → Computer &
browser, runs Playwright's installer from the copy buddi ships;
`BUDDI_BROWSER_INSTALL=1 buddi` does it on the first run. Chromium lands in
`<data>/browser/engines`, so a container that keeps its data volume keeps the
browser too; `buddi browser` says where it is. An install that already had
Chromium in Playwright's own cache keeps using it until `buddi browser install`
runs again. On a Linux server with no display the browser runs headless (see
[browser.md](browser.md)).

**Your browser** is Chrome (or Edge, Brave, Arc) on every platform: install
the extension from the **[Chrome Web Store](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)** — **Add to
Chrome** in Computer & browser opens it — and pair it with a six-digit code
there. The package also carries the unpacked extension at `<root>/extension`
for a developer install (`chrome://extensions` → Developer mode → Load
unpacked). Nothing about it is macOS-only.

- **macOS** is the reference platform, and the one supported today.
  Everything on this page works there. Computer control (the browser plugin's
  Use my apps mode) is macOS-only.
- **Linux** is in trial, on a Pop!_OS home server. The npm install works: the
  file vault, the bundled Postgres, and a systemd *user* unit that `buddi`
  writes the way it writes the LaunchAgent on macOS (it survives logging out
  only after `loginctl enable-linger`). The agents' own browser and "Your
  browser" are untested there. Computer control does not work, and says so.
- **Windows** is not supported yet. What is aimed for is the core loop, the
  dashboard, the bundled Postgres, Telegram, email, memory and the web plugin.
  Running commands on the host (`host.exec`) is refused on Windows until it is
  written against PowerShell with the same approval. The agents' own browser
  and "Your browser" are expected to work. The Task Scheduler service and the
  Credential Manager vault do not exist yet, and plugins do not yet say which
  platforms they support.

---

## 10. Security

- The dashboard listens on loopback only, and first run never offers a network
  address.
- Keys never touch a terminal, a log or `.env`: they go from the form in your
  browser to the vault over the loopback session with the CSRF header, like
  every write.
- The bundled Postgres listens on loopback with a password only the vault
  holds; there is no trust authentication.
- You approve a plugin install with its contributions and hosts in front of
  you, and it is recorded with the package's integrity hash, so doctor can say
  whether what is on disk is what you approved.
- **Signing in through Tailscale** is off until you turn it on in Settings →
  System and name the login that may sign in. buddi never trusts the proxy's
  headers alone: the connection must arrive on loopback, `X-Forwarded-For` must
  name exactly one address (Serve overwrites that header; a second proxy
  appends to it, and a list is refused), that address must be on your tailnet,
  `X-Forwarded-Proto` must be `https`, and the local `tailscaled` must confirm
  over its own socket that the address belongs to that login and that the
  login the header claims is the one it names. The session is a remote one —
  12 hours idle, seven days at most, Secure cookies, CSRF and Origin checks —
  and it is checked against the daemon on every request, so turning the
  setting off or naming a different login ends every tailnet session at once.
  The setting itself can only be changed from a session on this machine.
- What that does **not** prove: the gateway cannot tell `tailscale serve` from
  another process on the same machine connecting to the same loopback port and
  sending the same headers. So this extends to your tailnet the trust the
  loopback dashboard already gives your machine, no more and no less. It is a
  small step, because a process that can reach the loopback port can already
  read the data directory, the `.env` and the keychain, and so already has
  everything a dashboard session could give it. If you do not accept that, do
  not publish the dashboard on your tailnet.

**What leaves the machine.** The install itself makes two outbound calls, both
to the npm registry, both through buddi's shared transport, both listed on the
security screen: the daily version check and a plugin install. Settings →
Plugins → Browse makes one more: the plugin and agent list from withbuddi.com,
when you open Browse or the agent catalogue (Agents → Add a teammate, or
`buddi agents catalogue`), and while your team is new when Home or first run's
handover suggests teammates (at most once a day: the list is kept a day), and
an agent's picture when it is shown or added. A folder copy of
your backups goes wherever that folder syncs, and only encrypted.

---

## 11. Uninstall

```sh
buddi uninstall
npm uninstall -g @withbuddi/buddi
```

`buddi uninstall` first prints everything it will remove, one line each, with
the real paths on this machine, and removes nothing until you type `yes`
(`--yes` skips the question):

- the background service: the launchd agent or systemd user unit, stopped,
  unloaded and its file deleted;
- the data directory: the bundled Postgres (stopped through the supervisor
  first), agents and skills, the files library, logs, backups and the fetched
  Chromium;
- the secrets: the keychain entries this installation keeps, listed by name,
  never by value; on Linux, the file vault and its key;
- the dashboard app in `~/Applications`, if `buddi dashboard --install-app`
  made it;
- the extension pairing record and the Telegram bot's command menu. The bot
  itself is yours and stays.

Before it removes anything it takes one last backup and moves it to
`~/buddi-backups`, where it stays. The backup is locked with your passphrase,
and the vault that keeps it is about to go, so the command prints the six
words once. `--no-backup` skips the backup.

`--keep-data` removes the service and the app and leaves the data directory
untouched, together with the secrets that open its database, so a later
`buddi` picks the same installation up again.

A data directory that is not an installation (no `installation.json`, no
`postgres` folder) is refused, not deleted: `BUDDI_DATA_DIR` pointed at the
wrong folder never becomes a deleted folder. The command exits 1 when something
it listed could not be removed, such as a locked keychain or a service that
would not unload, after it has removed the rest. Its last line is the one that
removes the package: `npm uninstall -g @withbuddi/buddi`.

In a source checkout the same command removes the service and the keychain
entries, stops the Docker Postgres (`docker compose down`, the volume stays),
and leaves the repository, `.env` and the data folder alone.

---

## 12. Checking an install

What a working install looks like, and how to see it:

1. On a clean macOS account with Node 22, `npm install -g @withbuddi/buddi && buddi`
   opens first run within a minute; a pasted key and a first agent give an
   answer without any other terminal command.
2. Reloading or restarting in the middle of first run comes back to the same
   question, with everything you already answered still there.
3. After `npm install -g @withbuddi/buddi@<next>`, `buddi upgrade` takes a
   backup, migrates and restarts; the dashboard shows the new version.
4. `buddi plugins install <published plugin>` shows what the plugin claims,
   waits for your approval, registers it, and its tools appear in the agents'
   tool lists; `buddi plugins uninstall` removes them and `--purge` drops the
   schema.
5. A source checkout with Docker keeps its own setup and ends on the same
   first-run page.
6. A scheduled backup lands encrypted in a synced folder; on a clean machine,
   first run's "I have a backup from another buddi" restores it with the
   passphrase, and the first agent answers once the key is pasted again. The
   archive is unreadable without the passphrase, and `age -d` plus `tar` open
   it without buddi.
7. A restored installation runs no mission, poll, queue claim or Telegram
   connection until you leave recovery mode; a restore whose file step fails
   leaves the database exactly as it was.
8. A plugin whose package has an install script, or whose entry point throws on
   import, runs nothing before you approve the staged summary; rejecting it
   leaves nothing on disk.
9. With the gateway stopped, `buddi` starts it again; an upgrade interrupted
   after the backup and before the restart is finished or rolled back on the
   next start, and `buddi doctor` says which.

---

## 13. What is not there yet

- **Windows.** The data directory knows where it goes
  (`packages/install/src/environment.ts`) and nothing else does: there is no
  Credential Manager vault and no Task Scheduler unit, and `host.exec` is
  refused.
- **Linux, fully.** The file vault, the bundled Postgres and the systemd user
  unit work (`packages/install/src/launcher.ts`); the browser modes are
  untested and computer control is macOS-only. A Secret Service vault is not
  planned while the file vault covers a headless machine.
- **Backups to Google Drive or Dropbox by sign-in.** The plan is OAuth in the
  browser (the consent page, the redirect received on loopback, the refresh
  token kept in the vault), each provider's narrowest scope (Drive's
  per-application folder, `drive.appdata` or `drive.file`; Dropbox's app
  folder), upload after each backup, `list`, `verify` and `restore` against the
  remote listing, and retention pruning there too. It would add two hosts to
  the network allowlist, both named on the Backup page, and a provider outage
  would make the copy late, reported by doctor, never fail the backup. The
  folder copy already sits behind the one interface this would use (`put`,
  `list`, `get`, `delete`). No code for either provider exists yet.
- **Continuous checks on every platform.** There is no CI workflow: nothing yet
  installs the published package into a clean home on macOS, Ubuntu and
  Windows runners, runs first run headless and checks the gateway answers.
- **An app.** No packaged desktop app (Electron or Tauri, DMG or MSI), no
  menu-bar or tray icon. If one comes, it wraps this install and adds signing,
  auto-update and a tray.

---

## 14. For developers: the package, built and tried

### A source checkout

A checkout of the repository is the developer path: `git clone`, Docker
Desktop for its Postgres container, then `buddi init`, which writes `.env`,
starts the database, migrates, installs the service and ends on the same
first-run page as a packaged install (`packages/cli/src/init.ts`). It is safe
to run again.

The published package is a bundling step, not a different layout: the
monorepo is built, then one package is assembled from `packages/*/dist` with
its runtime dependencies.

### Where the code lives

- **`packages/install`** (`@buddi/install`) is the runtime of a packaged
  install: `src/environment.ts` (data directory, private files, installation
  state, startup lock), `src/supervisor.ts` (process supervision and the
  control socket), `src/upgrade.ts` (the version check, `<data>/upgrade.json`
  and the upgrade itself) and `src/launcher.ts`, the `buddi` binary the
  tarball installs.
- **The managed cluster** is not install-specific and lives in
  `packages/core/src/postgres` (`binaries.ts`, `cluster.ts`): the per-platform
  binaries, `initdb`, the authenticated start, the liveness probe. Core has no
  dependency on `@embedded-postgres/*`; the binary package is resolved by name
  from a root the caller supplies. `packages/install/src/postgres.ts` only
  chooses between that cluster and an external `DATABASE_URL`.
- **The backup engine** is `packages/core/src/backup`, a driver-based logical
  dump that needs no `pg_dump`. Nothing in it reads `process.env`; every path
  arrives in an options object, so the CLI, the supervisor and the dashboard
  drive the same engine (§8).
- **Plugin install** is `packages/gateway/src/plugins`: `stage.ts` fetches,
  unpacks and reads a package **without importing it**, `approve.ts` is the two
  approvals, `npm.ts` is the only place that shells out to npm, `hash.ts` is
  what `buddi doctor` recomputes, `install.ts` is the plan (validate, refuse a
  clash, compare the claims, register, migrate, record), and `paths.ts` puts
  everything under `<data>/plugins` (§7). The Plugins page is
  `packages/web/src/views/Plugins.tsx`.
- **Backup and recovery pages** are `packages/web/src/views/{Backup,Recovery}.tsx`;
  the version check and Upgrade are in `packages/web/src/views/Settings.tsx`
  and `packages/install/src/upgrade.ts`.
- **The dashboard's side of the control socket** is
  `packages/gateway/src/web/service.ts`, used by the `/api/service` routes; the
  page is the Service section of `packages/web/src/views/Settings.tsx`.
- `scripts/release/build.mjs` and `scripts/release/smoke.mjs` are release
  tooling, not runtime.

`environment()` rewrites the environment before any `@buddi/*` package is
imported, because those packages compute their path constants at import time.
That is why it imports none of them, and why the launcher, the supervisor and
the cluster reach `@buddi/core`, `@buddi/gateway` and `@buddi/cli` through
dynamic imports. The tarball declares exactly one `bin`, the launcher's
`buddi`; `build.mjs` strips `bin` from every other staged package.

Anything platform-specific sits behind one function with a stated fallback.
Three parts carry real risk and get the most care: the managed cluster, plugin
code running in the process, and restore.

### Build and verify

From a built checkout:

```sh
pnpm -r build
pnpm --filter @buddi/install test
node scripts/release/build.mjs
node scripts/release/smoke.mjs /absolute/path/printed/by/build/buddi-0.1.0.tgz
```

The assembler stages into a new temporary directory, runs npm only there with
install scripts disabled, and prints the tarball path. The smoke test installs
that tarball into another temporary directory with a private file vault, a real
Postgres and the dashboard, and exercises auth, repeat startup, gateway
stop/start/crash, supervisor death (the database comes back with a *different*
pid: restarted, not adopted), migration restart, password rotation, database
death, and dashboard port conflicts, checking that a fixture row survives. By
default it installs no LaunchAgent, touches no existing database or keychain,
opens no browser and makes no model call. `--service` also tests the real
macOS LaunchAgent path under a uniquely named test unit, then removes it.

### Try it in Docker

To meet the packaged install the way a stranger on a clean Linux machine would:

```sh
pnpm release:trial             # build, image, fresh volume, serve — in one go
pnpm release:docker            # build the tarball, then an image containing only it
scripts/release/docker/run.sh  # start it and print the dashboard link
```

The image is `node:22-bookworm-slim` plus the tarball installed with
`npm install -g --ignore-scripts`. Optional dependencies stay on, which is how
`@embedded-postgres/linux-<arch>` arrives, and the build fails if the image's
architecture did not get its package. There is no checkout, no pnpm and no
build tools in it; the one addition is `socat`, and buddi runs as the
unprivileged `node` user.

`run.sh` starts `buddi --no-service --no-open`, so the detached supervisor is
what runs. The gateway binds 127.0.0.1 inside the container; `socat` forwards
the container's address to it, and Docker publishes that on `127.0.0.1:4317`.
The link printed is the launcher's own, good for five minutes;
`docker exec buddi-trial buddi --no-service --no-open` mints another.

**The port must be the same on both sides.** The dashboard refuses a write
whose `Origin` is not its own, so the browser must reach it at the port the
gateway bound. `run.sh` refuses to start when 4317 is already listening on the
host — most likely your own buddi. `BUDDI_TRIAL_PORT=4318` works around it
read-only: login and every `GET` work, and writes answer 403. To try first run
for real, stop the local installation first.

Data lives in the named volume `buddi-trial`, so the container is disposable
and the installation is not; `--reset` removes the volume for a true first run.
Ctrl-C asks the supervisor to stop and waits for it, so Postgres shuts down
cleanly. On start, `run.sh` removes the supervisor lock, the control socket and
`postgres/postmaster.pid` left from a previous container's pid namespace. This
image is a trial harness, not a distribution.

### Limits worth knowing

- The `@embedded-postgres` package supplies `initdb`, `postgres` and `pg_ctl`,
  **not** `pg_dump`, `pg_restore` or `psql`. The packaged launcher refuses the
  checkout's direct-migration and Docker commands; `buddi upgrade`,
  `buddi version` and the backup verbs work, because the supervisor serves them
  without those binaries. The pinned distribution is 18.4.0-beta.17, a
  PostgreSQL 18.4 server; its beta status is a release risk.
- Postgres major upgrades fail closed. No cluster is converted or deleted
  automatically.
- Installing a plugin from a registry needs `npm` on the machine (the one
  beside the running node, then `PATH`). A directory or a `.tgz` needs none.
- The recorded `installedHash` covers a plugin's own files, not
  `node_modules`: it detects a plugin edited after approval, not a tampered
  dependency. It is not a signature.
- There is no automatic whole-install rollback. The way back from a migration
  that failed under new code is the backup taken before the upgrade, named in
  `<data>/upgrade.json`, in `buddi doctor` and in the sentence the upgrade
  prints.
- The session cookie is `SameSite=Strict`, so a dashboard link opened from
  outside the browser (a terminal, a chat message) without a ticket answers
  401. The ticket in the link `buddi` prints is what gets in.
- A stopped gateway is started from a terminal: the Settings switches are
  served by the gateway itself, so a stop takes the page down with it.
- A corrupted installation file, an ambiguous active lock, an inaccessible
  vault or an occupied persisted port fails with diagnostics rather than
  overwriting data. A process killed during stale-lock recovery can leave
  `supervisor.lock.recovery`; check the lock and process state before removing
  it by hand.
