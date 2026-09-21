# Packaged install foundation

Experimental implementation on `feat/clean-install-foundation`. Nothing is
published to npm. The full contract remains [install.md](install.md).

## What this slice does

- Assembles built workspace packages, migrations, example agents/skills, native
  helper and dashboard into one npm tarball with bundled runtime dependencies.
  No private configuration, source checkout, developer dependencies or data are
  copied. Per-platform Postgres binaries are pinned optional dependencies.
- **Platform plugins only.** The staged package list is core, runtime, gateway,
  cli, install and the platform tools (artifacts, browser, host, email, memory,
  web). `finance` is not staged, is not compiled in anywhere, and no longer
  lives in this tree at all — it is its own repository, `buddi-plugins`:
  money is one owner's domain, not something every installation should claim a
  `finance.*` family for, so it is installed like any other plugin. A gateway
  that has not been given it — packaged or checkout — has no `finance.*`
  family, and an agent file granting one is refused with the same sentence core
  uses for any other tool no installed plugin provides — fail-closed, and for
  the whole catalog, which is what the note below is about.

  **Migrating a checkout whose agents grant `finance.*`.** Finance used to be
  registered by the composition root wherever the workspace had it, so in a
  checkout it was simply there. It is not any more, and the package is not in
  this repository either. Build it in the `buddi-plugins` checkout and, before
  the next restart, run `buddi plugins install <path>/buddi-plugins/finance` —
  a directory source, so
  it stages the package you already have, imports it once for the plan, and
  records it; nothing is fetched and no hash has to be typed back. The
  `finance` schema and everything in it are untouched by this: the plugin
  claims the schema it already owns. `buddi plugins install` builds no agent
  catalog, so it still works in a checkout that is already in the state below.

  Do it before the restart, because the catalog is fail-closed and it is closed
  for the whole catalog, not for one agent: a grant naming a tool nobody
  registered raises `agent "credit-coach" declares tool "finance.*", which
  matches no registered tool …`, and `loadAgentCatalog` refuses to produce a
  catalog at all. A gateway in that state does not start, and `buddi doctor`'s
  model-credential row fails with the same sentence, so "the rest of buddi
  keeps running" is not what happens — the whole installation waits until
  either the plugin is installed or the grant is taken off those agent files.
  Installing it and restarting brings them back unchanged.
- The packaged `buddi` launcher initializes a platform data directory, an
  installation-specific vault and a private SCRAM-authenticated Postgres cluster.
  The application database role is not a superuser; the administrator credential
  stays in the vault. An explicit `DATABASE_URL` selects an external database
  without provisioning or managing its server.
- On macOS the default command installs a per-data-directory LaunchAgent.
  `buddi --no-service --no-open` instead starts a detached supervisor without
  installing a login service or opening a browser. `buddi supervise` runs it
  in the foreground. Linux background-service installation and Windows managed
  startup are not implemented in this slice.
- The supervisor owns the gateway and database independently, serializes gateway
  controls, restarts a crashed gateway with bounded exponential backoff, and holds
  a per-install lock. Gateway IPC
  detects supervisor death. A postmaster left on the cluster by a killed
  supervisor is stopped and started again as the new supervisor's own child; it
  is never adopted, so a managed database is always a spawned child with an exit
  listener. A `postmaster.pid` is only believed when something outside it agrees
  — the port it records answers for this cluster, or the OS says that pid is a
  postgres — because after a reboot or a killed container the pid in it is
  likely a live stranger. A file with nothing behind it is reported and removed,
  not signalled. An authenticated liveness probe also monitors it; database failure
  shuts down the gateway and supervisor. External servers are not supervised.
- Startup records a phase before migrations. Restarting uses the **existing
  idempotent migration runner** to apply missing transactional migrations; the
  phase field is not a new rollback or recovery engine. Newer known schema
  migrations refuse older code.
  Interrupted `initdb` directories are preserved, never treated as complete.
- The supervisor's control surface is a Unix domain socket, `supervisor.sock`
  in the data directory, mode 0600 inside a 0700 directory. It serves four
  routes — `GET /status` and `POST /start|/stop|/restart` — with JSON in and
  out and **no credential**: only a process running as the owning user can open
  the socket, and that user could read the vault or signal the supervisor
  anyway. It is not a general host-command endpoint. Its two clients are the
  `buddi` CLI and the dashboard: `GET /api/service` and
  `POST /api/service/start|stop|restart` forward to it behind the dashboard's
  usual session, Origin and CSRF gate. There is no second web surface and no
  second login ticket.
- The dashboard requires a five-minute login ticket. Replay rejection is **per
  server process**, not durable across restarts: a previously spent, unexpired
  ticket may work again after its server restarts.
- Dashboard readiness requires an installation-secret challenge proof, not just
  an HTTP status. Failure to bind the required dashboard terminates the gateway.
- Every managed startup resynchronizes the application role password from the
  vault, using PostgreSQL's literal quoting. Native utilities and the computer
  helper receive an allowlisted OS environment, without vault/provider/database
  secrets. `initdb` receives its password through stdin, with no password file.
- Existing `.env` and `vault-key` must be owner-only regular files, owned by the
  current user; symlinks are refused. LaunchAgent replacement unloads the old job
  before loading new arguments, including when Node or package paths change.
- The existing dashboard starts without a model key or Telegram token. Full
  welcome/onboarding screens are the next slice, not implemented here.

Run `buddi` again to print a fresh dashboard URL.
`buddi service status|start|stop|restart` controls **the gateway** in a packaged
installation; stopping it leaves Postgres running. The same switches are in the
dashboard's Settings → System, for as long as the gateway is up to serve them.
`buddi doctor` reports this supervisor's state and log directory.

Developer checkout commands retain their existing behavior. No-argument startup
is provided by the release launcher, not by changing the checkout CLI parser.

## Where the code lives

The runtime of a packaged install is the workspace package `packages/install`
(`@buddi/install`): `src/environment.ts` (data directory, private files,
installation state, startup lock), `src/supervisor.ts` (process supervision and
the control socket), `src/upgrade.ts` (the version check, `<data>/upgrade.json`
and the upgrade itself) and `src/launcher.ts`, the `buddi` binary the tarball
installs (`packages/install/dist/launcher.js`). The dashboard's side of the
socket is `packages/gateway/src/web/service.ts`, one `node:http` client used by
the `/api/service` routes in `server.ts`; the page itself is the Service section
of `packages/web/src/views/Settings.tsx`. `scripts/release/build.mjs` and
`scripts/release/smoke.mjs` are release *tooling*, not runtime, and stay there.

The managed cluster itself is **not** install-specific and lives in
`packages/core/src/postgres` (`binaries.ts`, `cluster.ts`): the per-platform
binaries, `initdb`, the authenticated start, the liveness probe. Core gains no
dependency on `@embedded-postgres/*` — the binary package is resolved by name
from a root the caller supplies. `packages/install/src/postgres.ts` is only the
adapter that chooses between that cluster and an external `DATABASE_URL`, so
the checkout CLI can later share the same manager.

The backup engine is **not** install-specific either and lives in
`packages/core/src/backup` (`dump.ts`, `load.ts`, `create.ts`, `verify.ts`,
`restore.ts`, `manifest.ts`, `archive.ts`, `prune.ts`, `crypt.ts`): a
driver-based logical dump, so it needs no `pg_dump` and works the same against
the bundled cluster, a developer's Docker Postgres and a restore on another
machine. Nothing in it reads `process.env` or looks for a repository root —
every path arrives in an options object — so the CLI
(`packages/cli/src/backup`, thin wrappers plus the OS schedule), the supervisor
and the dashboard all drive the same engine. Its tests are
`packages/core/src/backup/*.test.ts` (pure: the manifest, the scrub, the dump
order, the sequence reset) and `backup.db.test.ts`, the restore drill, which
creates its own throwaway database, dumps, drops and recreates it, restores and
checks the rows, the sequences and the rollback:

```sh
pnpm --filter @buddi/core test -- src/backup
```

Installing a plugin from npm lives in `packages/gateway/src/plugins`, and it is
split at the one line that matters: `stage.ts` fetches, unpacks and reads a
package **without importing it**, and `approve.ts` is the two approvals, the
first of which is the first time that package's code runs in the process.
`spec.ts` decides what the owner typed (a directory, a `.tgz`, an npm spec),
`npm.ts` is the only place that shells out to npm and is an interface first so
that no test needs a registry, `claims.ts` compares the package's own `buddi.md`
with the manifest it turned out to have, `hash.ts` is what `buddi doctor`
recomputes to say a plugin's files are no longer the ones that were approved,
and `paths.ts` puts everything under `<data>/plugins` — beside the artifacts and
the logs, in the directory a backup already covers. The record itself stays in
core (`packages/core/src/plugins`), now at version 2 with provenance; a version
1 file still reads, as directory sources with none. Core imports no plugin, and
`scripts/check-boundaries.mjs` still says so.

Staged dependencies are installed with `--ignore-scripts`, always: a
`postinstall` is arbitrary code and at that point no approval exists. The
packages in the tree that *wanted* to run one are named on the approval screen.
The staged `node_modules/@buddi/core` is replaced by a symlink to the core the
gateway is running, because a plugin with its own copy would register tools into
a registry nobody reads. `@buddi/core` is therefore published
(`publishConfig.access: public`, `files: [dist, migrations]`) and declared as a
peer dependency by every plugin package.

The release tarball declares exactly one `bin`, `@buddi/install`'s `buddi`
launcher; `build.mjs` strips `bin` from every other staged workspace package so
nothing else claims `node_modules/.bin/buddi`.

`environment()` rewrites the environment before any `@buddi/*` package is
imported, because those packages compute their path constants at import time.
That is why it imports none of them and why the launcher, the supervisor and
the cluster reach for `@buddi/core`, `@buddi/gateway` and `@buddi/cli` through
dynamic imports.

## Build and verify

From a built checkout:

```sh
pnpm -r build
pnpm --filter @buddi/install test
node scripts/release/build.mjs
node scripts/release/smoke.mjs /absolute/path/printed/by/build/buddi-0.1.0.tgz
```

The assembler creates a new temporary staging directory and prints the tarball
path. It runs npm only inside staging, with install scripts disabled. The smoke
test installs that tarball into another temporary directory, disables installation
scripts, uses a private file vault, runs a real Postgres and dashboard, tests auth,
repeat startup, gateway stop/start/crash, supervisor death and migration restart,
password rotation, database death under its own supervisor, and dashboard port
conflicts, checks
that application data survives, then stops its own supervisor. By default
it does not install a LaunchAgent, touch an existing database/keychain, open a
browser, or make model calls. After supervisor death it asserts that the
database is running again with a *different* pid (restarted, not adopted) and
that the fixture row survived. The optional `--service` flag tests the actual macOS
LaunchAgent path using a uniquely named test service, then unloads and removes
that test unit. It also replaces a loaded job and verifies its new arguments.
Fixture data is retained for inspection. Tests should also run
on Node 22 before publishing a release.

## Try it in Docker

To meet the packaged install the way a stranger on a clean Linux machine would,
from the browser of the machine you are already sitting at:

```sh
pnpm release:trial             # everything below in one go: build, image, fresh volume, serve
pnpm release:docker            # build the tarball, then an image containing only it
scripts/release/docker/run.sh  # start it and print the dashboard link
```

`scripts/release/docker/Dockerfile` is `node:22-bookworm-slim` plus the tarball
installed with `npm install -g --ignore-scripts` — **optional dependencies stay
on**, which is how `@embedded-postgres/linux-<arch>` arrives, and the build
fails if the architecture the image will run as did not get its package. There
is no checkout in the image, no pnpm and no build tools. The one addition is
`socat`, and the install runs as the unprivileged `node` user in its own home.

`run.sh` starts `buddi --no-service --no-open`: Linux has no background-service
installation in this slice, so the detached supervisor is what runs, and the
launcher says as much for the default command. The gateway keeps binding
127.0.0.1 inside the container — `environment()` forces that and this harness
does not relax it — so `socat` forwards the container's own address to it, and
Docker publishes that to `127.0.0.1:4317` on the host. The link printed is the
launcher's own, ticket and all: readiness is proved at `/_buddi/ready` with the
installation secret, not by spending the ticket, so the first link is unused.
It still expires in five minutes; `docker exec buddi-trial buddi --no-service
--no-open` mints another.

**The port is the same on both sides, and that is not a detail.** The dashboard
refuses a write whose `Origin` is not its own, so the browser must reach it at
the port the gateway bound. Inside a fresh container nothing holds 4317, so the
gateway takes it; `run.sh` asserts that and tells you to `--reset` if a
persisted `installation.json` chose otherwise. On the host, `run.sh` refuses to
start when 4317 is already listening — most likely your own Buddi — rather than
handing you a dashboard whose wizard cannot save. `BUDDI_TRIAL_PORT=4318
scripts/release/docker/run.sh` is the read-only way around it: login and every
`GET` work, and writes answer 403 until both sides are 4317. Trying the wizard
for real means stopping the local installation first.

Data lives in the named volume `buddi-trial` between runs, so the container is
disposable and the installation is not. `--reset` removes that volume, which is
what makes the next start a true first run. Ctrl-C asks the supervisor to stop
and waits for it before removing the container, so Postgres shuts down the way
it would anywhere else; the volume survives. Pids left in the volume were
written in a previous container's pid namespace, where they meant something, so
`run.sh` removes the supervisor lock, the control socket and
`postgres/postmaster.pid` on start — nothing in a container it has just created
is supervising anything — which still matters for a container that was killed
outright. The log follower shows only what this run writes; earlier runs' lines
are in `logs/supervisor.log` in the volume.

This image is a trial harness, not a distribution: it exists to try an install,
not to run one.

## Explicit limitations / next slices

- The chosen `@embedded-postgres` binary package supplies `initdb`, `postgres`
  and `pg_ctl`, **not `pg_dump`, `pg_restore` or `psql`**. Backups, restores,
  upgrades, direct migrations, and checkout/Docker initialization commands are
  refused by the packaged launcher, except `buddi upgrade`, `buddi version` and
  the backup verbs, which are served by the supervisor and need none of those
  binaries. Supply pinned client binaries before enabling the rest. This
  foundation is not a production upgrade/restore solution.
  The npm distribution is pinned at **18.4.0-beta.17**; its bundled server reports
  **PostgreSQL 18.4**. The distribution's beta status remains a release risk to
  review before publication; passing these tests is not production certification.
- Postgres major upgrades fail closed and require a future explicit migration
  path. No automatic conversion or deletion of a cluster occurs.
- **Installing a plugin from a registry needs `npm` on the machine.** The npm
  beside the running node is preferred and PATH is the fallback; its absence is
  a plain error, never a hand-rolled tarball fetcher. A directory or a `.tgz`
  source needs no npm at all.
- **The recorded `installedHash` is an accounting control, not a sandbox.** It
  covers the plugin's own files, excluding `node_modules`, so it detects a
  plugin edited after it was approved and not a tampered dependency. It is not a
  signature and there is no marketplace and no curation: a plugin comes from a
  name the owner typed, and it runs with everything buddi can do.
- There is no automatic whole-install rollback here, and the upgrade does not
  add one: the way back from a migration that failed under new code is the
  backup taken before the upgrade started, named in `<data>/upgrade.json`, in
  `buddi doctor` and in the sentence it prints. A failed install, which is the
  reversible half, does start the old gateway again by itself.
- **The upgrade is the supervisor's, and it hands over to the code it
  installed.** `POST /upgrade` on the control socket runs `backup`, `stopping`,
  `installing` (`npm install` with scripts *enabled*, `--prefix` derived from
  the install root that is running, `--registry` always passed), writes
  `phase: upgrading` into `installation.json` and goes away; the supervisor that
  comes up on the new code migrates and writes the outcome. Under launchd
  "goes away" is exiting — the agent has `KeepAlive` and its `ProgramArguments`
  point into the install root that was just replaced — and off launchd it
  spawns its own successor and waits for it to take the lock. `BUDDI_UPGRADE_SOURCE`
  replaces the registry spec with a tarball on disk, which is how it is
  exercised offline. The `restarting` phase is set and the process is gone
  within the same tick, so a client polling the job may never observe it: what
  tells a client the upgrade worked is the socket coming back with a new
  `current` and a `done` entry in the history.
- **A required-auth dashboard refuses a link opened from outside the browser's
  own site.** The session cookie is `SameSite=Strict`, so a top-level navigation
  started elsewhere (a terminal's opener, a chat message) does not carry it: the
  document request answers 401, and repeated attempts count against that
  address's rate limit. The ticket in the URL the launcher prints is what gets
  in; an already-authenticated tab is unaffected.
- **A stopped gateway is started from a terminal, not from a browser tab.** The
  Settings switches are served by the gateway itself, so a stop or a restart
  takes the page down with it: the request is *accepted* and then performed,
  the reply never reports the outcome, and if the page does not come back,
  `buddi` is what brings it back. The acceptance is not durable: a gateway
  that dies in the instant between answering and asking the supervisor loses
  the action, and the page's next status read shows it did not happen. The supervisor's Windows named-pipe
  equivalent is not implemented; Windows managed startup still raises its
  existing "not implemented" error.
- Plugin npm installation, the full wizard, Backup UI and cross-platform
  service managers remain separate work.
- The file-vault key is stored at `vault-key` beside its ciphertext with owner-only
  permissions: the data directory is its trust boundary. macOS normally uses a
  separate Keychain namespace derived from the data directory instead.
- A corrupted installation file, an ambiguous active lock, inaccessible vault,
  or occupied persisted port fails with diagnostics rather than overwriting data.
  A process killed during stale-lock recovery can leave `supervisor.lock.recovery`;
  inspect the lock/process state before manually removing that recovery marker.

Before publication, verify on a clean macOS user with Node 22, exercise login after
reboot. No distribution choice is needed for backups: they use the driver, not
`pg_dump`.

## Verification on 2026-09-20

- TypeScript build and dashboard production build pass.
- The initial 131-test report comprised 123 existing tests, six new foundation
  tests and two new CLI unit tests; it did not mean 131 new tests.
- After hardening, 151 targeted tests pass: CLI 47, gateway 42, core 36, native
  computer driver 11, release foundation 15. Of these, 133 are pre-existing and
  18 are new tests. The package-boundary check also passes.
- Real tarball install with `--ignore-scripts` passes on this macOS host (Node
  26), both with a detached supervisor and through an actual isolated LaunchAgent.
- The service test verifies a non-superuser application role and a fixture row
  surviving gateway crashes, supervisor death, password rotation, and restart
  with the migration phase marker set. Auth tests reject missing credentials,
  in-process ticket replay and writes without CSRF. The control socket is checked
  for mode 0600, and the dashboard's service view is checked against the pids
  `buddi service status` reports. Intentional gateway stops
  leave Postgres running. Detached mode verifies that failure of the managed
  database terminates its supervisor and gateway, and that a leftover postmaster
  is stopped and replaced rather than adopted. A conflicting dashboard listener cannot
  pass readiness, and the gateway exits when its required bind fails.
- Test LaunchAgents are unloaded and removed; fixture directories are retained.
  The live Buddi installation was not restarted or reconfigured.
- The upgrade path was verified on this host without a registry: 0.1.0 installed
  into a throwaway `--prefix`, its supervisor started in the foreground, then
  `POST /upgrade` with `BUDDI_UPGRADE_SOURCE` pointing at a 0.1.1 tarball packed
  from the same tree. The socket went away after `installing` and came back on
  0.1.1 with `phase: ready`, a `done` history entry naming the backup, and the
  check switch the owner had turned off still off.

## Wizard

The first run of [install.md §5](install.md#5-first-run-you-meet-buddi) is built
on this foundation, and what the owner sees is the screen script in
[onboarding.md](onboarding.md): one thread, four questions, then the assistant
speaking for itself. The dashboard route is `#/welcome` and it renders without
the rail. Everything below is about the *record*, which the shape of the screen
does not change.

- **The record is the server's.** `core.onboarding` already holds it, and the
  thread reads and writes it through `GET /api/onboarding` and `POST
  /api/onboarding/step|complete|skip|agent`
  (`packages/gateway/src/web/onboarding.ts`). `GET` also answers what is still
  missing — a name, a usable model account, an agent of the owner's own — and
  that, not anything the page believes, is what opens each Next button.
- **One first run, two surfaces.** Completing or skipping here closes the same
  state machine the Telegram interview claims, so an owner who set up on the
  dashboard is never interviewed again: it speaks only while the state is
  `pending`. The two-week nudge arc is shut for a record whose surface is `web`
  whatever its state — the arc exists to carry someone who met buddi in a chat,
  and the dashboard is the thing it would be pointing at. `done` and `skipped`
  are terminal in `core.onboarding`: each transitions only from `pending` or
  `in-progress`, so a late skip cannot unfinish a completion or the reverse.
  `buddi init` therefore stops offering its own interview once it has opened the
  wizard; two offers are not two chances, because whichever one is answered
  claims the record.
- **The redirect is conservative.** The dashboard replaces the location with
  `#/welcome` only when the record is `pending` *and* there is no enabled,
  credentialed provider account. `in-progress` is deliberately excluded: it
  belongs to an interview another surface claimed, which a redirect would talk
  over. The wizard still resumes an in-progress record when it is opened by
  link. A finished record, a skipped one,
  or any installation that already has an account is left where it is — which
  is what keeps a developer's live dashboard out of it. Settings → System has
  "Run setup again" for everyone else.
- **Finishing means finished.** `POST /api/onboarding/complete` answers 409 while
  the installation still needs a model account or an agent, and the Done screen
  says which and links back to that step; `/skip` is the one way past it, and it
  records that the owner declined. Skip and Finish leave the wizard only when
  the server has recorded the ending — a failed write keeps the owner on the
  screen with the reason, rather than dropping them on a dashboard that will
  send them straight back.
- **The agent step writes a file, not a tool call.** It reuses
  `composeAgentFile` and `createAgentDirAtomic`, so an agent made here is the
  same artifact `platform.create_agent` makes: the generic template, no roles,
  no plugin tools, `language: mirror`, `default: true` for the first private
  agent, and the tool grant named once in the gateway. It is written under the
  shipped Concierge's id, so the catalog's replacement rule makes it *the*
  assistant rather than a second agent standing next to an example: the owner's
  handle, name, face and words, and no Concierge on the roster afterwards. It
  writes the *first* agent only — a second one is the maker agent's job, where a grant is proposed
  and approved — and creations are serialised in-process, so two requests racing
  cannot both claim `default`. The examples tree is guarded by resolving the
  nearest existing ancestor of both paths through `realpath` before comparing,
  so a private agents directory symlinked into `examples/` is refused rather
  than written to. Where exactly one usable
  model account exists it is assigned to the new agent, because the next screen
  is the owner talking to it; the wizard may also name the account it just
  tested (`accountId`), and an account the installation cannot run on is
  refused before anything is written. The write is behind the ordinary session, Origin
  and CSRF gate — the owner acting on their own installation — and not behind an
  approval.
- **`buddi init` ends there.** The checkout CLI opens the dashboard at
  `#/welcome?step=model`, since it has already asked for a name and a zone. The
  ticket redirect answers with a `Location` carrying no fragment, so the
  browser keeps the one the CLI put on the URL.
- **The release smoke covers it** as far as it can without a model call: what
  the fresh install still needs, CSRF refusal, a recorded step, the first agent
  written, reloaded and listed by `/api/agents`, and the record skipped and read
  back. It also asserts the three rules below: zero accounts, one assistant
  where the example was, and no Agent Father on the roster yet.
- **No ghost accounts.** The accounts named after `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `OPENAI_API_KEY` are seeded by the one-shot
  legacy migration only where the variable is set and non-empty. A fresh
  install has zero accounts until the owner adds one; a checkout that exports
  them is migrated as before.
- **Examples do not pretend.** Agent Father is held back from the roster —
  `/api/agents`, the rail and Home — until the owner has an agent of their own
  that can actually run (`EXAMPLES_HELD_BACK` in
  `packages/gateway/src/agents/catalog.ts`). It is held back, not removed:
  `get`, `byHandle` and `resolve` still answer, so `/new` and a handle typed by
  hand keep working, and the wizard still refuses a handle it holds.
- **No brain, no composer.** An agent whose account is missing, disabled or
  unconfigured is greyed wherever it is listed, with the server's own one-line
  reason; its page and its card link to Settings → Model accounts; its composer
  is replaced by that sentence and that link; and `POST
  /api/chat/:agent/messages` refuses the turn with 409 and the same words
  before a row is written. This holds in a developer's checkout too.

Deferred here, and named in install.md: Ollama detection, restore from the
dashboard, and the plugins and backup cards of the extras step.
