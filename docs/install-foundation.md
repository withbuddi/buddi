# Packaged install foundation

Experimental implementation on `feat/clean-install-foundation`. Nothing is
published to npm. The full contract remains [install.md](install.md).

## What this slice does

- Assembles built workspace packages, migrations, example agents/skills, native
  helper and dashboard into one npm tarball with bundled runtime dependencies.
  No private configuration, source checkout, developer dependencies or data are
  copied. Per-platform Postgres binaries are pinned optional dependencies.
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
  detects supervisor death. A subsequent supervisor can authenticate and adopt
  the exact managed cluster left by a killed supervisor. Authenticated liveness
  probes monitor both spawned and adopted managed databases; database failure
  shuts down the gateway and supervisor. External servers are not supervised.
- Startup records a phase before migrations. Restarting uses the **existing
  idempotent migration runner** to apply missing transactional migrations; the
  phase field is not a new rollback or recovery engine. Newer known schema
  migrations refuse older code.
  Interrupted `initdb` directories are preserved, never treated as complete.
- Both dashboard and service-control page require five-minute login tickets.
  Replay rejection is **per server process**, not durable across restarts: a
  previously spent, unexpired ticket may work again after its server restarts.
  The control page keeps working with the gateway stopped. Browser writes need
  its session, exact Origin and CSRF token. CLI controls use a distinct derived
  bearer credential. Neither is a general host-command endpoint.
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

Run `buddi` again to print full fresh dashboard and service-control URLs.
`buddi service status|start|stop|restart` controls **the gateway** in a packaged
installation; stopping it leaves Postgres and the control page available.
`buddi doctor` reports this supervisor's state and log directory.

Developer checkout commands retain their existing behavior. No-argument startup
is provided by the release launcher, not by changing the checkout CLI parser.

## Build and verify

From a built checkout:

```sh
pnpm -r build
node --test scripts/release/foundation.test.mjs
node scripts/release/build.mjs
node scripts/release/smoke.mjs /absolute/path/printed/by/build/buddi-0.1.0.tgz
```

The assembler creates a new temporary staging directory and prints the tarball
path. It runs npm only inside staging, with install scripts disabled. The smoke
test installs that tarball into another temporary directory, disables installation
scripts, uses a private file vault, runs a real Postgres and dashboard, tests auth,
repeat startup, gateway stop/start/crash, supervisor death and migration restart,
password rotation, adopted database death, and dashboard port conflicts, checks
that application data survives, then stops its own supervisor. By default
it does not install a LaunchAgent, touch an existing database/keychain, open a
browser, or make model calls. The optional `--service` flag tests the actual macOS
LaunchAgent path using a uniquely named test service, then unloads and removes
that test unit. It also replaces a loaded job and verifies its new arguments.
Fixture data is retained for inspection. Tests should also run
on Node 22 before publishing a release.

## Explicit limitations / next slices

- The chosen `@embedded-postgres` binary package supplies `initdb`, `postgres`
  and `pg_ctl`, **not `pg_dump`, `pg_restore` or `psql`**. Backups, restores,
  upgrades, direct migrations, and checkout/Docker initialization commands are
  refused by the packaged launcher. Supply pinned client binaries before
  enabling them. This foundation is not a production upgrade/restore solution.
  The npm distribution is pinned at **18.4.0-beta.17**; its bundled server reports
  **PostgreSQL 18.4**. The distribution's beta status remains a release risk to
  review before publication; passing these tests is not production certification.
- Postgres major upgrades fail closed and require a future explicit migration
  path. No automatic conversion or deletion of a cluster occurs.
- There is no automatic whole-install rollback here. The phase marker and
  idempotent forward migrations do not implement upgrade/restore recovery.
- Plugin npm installation, the full wizard, Backup UI, cross-platform service
  managers, and supervisor controls embedded in Settings remain separate work.
- The file-vault key is stored at `vault-key` beside its ciphertext with owner-only
  permissions: the data directory is its trust boundary. macOS normally uses a
  separate Keychain namespace derived from the data directory instead.
- A corrupted installation file, an ambiguous active lock, inaccessible vault,
  or occupied persisted port fails with diagnostics rather than overwriting data.
  A process killed during stale-lock recovery can leave `supervisor.lock.recovery`;
  inspect the lock/process state before manually removing that recovery marker.

Before publication, verify on a clean macOS user with Node 22, exercise login after
reboot, and choose a distribution that includes the backup tools.

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
  in-process ticket replay and writes without CSRF. Intentional gateway stops
  leave Postgres running. Detached mode verifies failure of an adopted database
  terminates its supervisor and gateway. A conflicting dashboard listener cannot
  pass readiness, and the gateway exits when its required bind fails.
- Test LaunchAgents are unloaded and removed; fixture directories are retained.
  The live Buddi installation was not restarted or reconfigured.
