# Operations — backup, restore, and where your data actually lives

This installation holds your financial history, your mail, the memories your agents
have formed about you, and the personas you wrote. ARCHITECTURE.md promises that
"rotation, backup/restore, and log redaction are specified" before you rely on the
system daily. This document is the backup/restore half of that promise.

The short version:

```
buddi backup schedule install    # nightly at 03:30, prune included — do this once
buddi backup create              # take one now
buddi backup verify <archive>    # prove it is good, without a database
buddi backup list                # what you have
```

---

## Where your data actually lives

Four places, and only two of them are in a backup.

| What | Where | In a backup? |
| --- | --- | --- |
| The database | Docker **named volume** `buddi-pgdata`, mounted at `/var/lib/postgresql/data` in the `buddi-postgres` container | Yes — as a `pg_dump`, not as volume files |
| Artifact files | `<data dir>/artifacts/<yyyy>/<mm>/<sha256>.<ext>` — `data/` at the repo root unless `BUDDI_DATA_DIR` says otherwise | Yes (skippable) |
| Your private agents and skills | `private/agents` + `private/skills` at the repo root, or `~/.buddi/agents` + `~/.buddi/skills`, or wherever `BUDDI_AGENTS_DIR` / `BUDDI_SKILLS_DIR` point. `buddi doctor` prints the resolved paths in the `config` row | Yes |
| Secrets | The **macOS keychain** (service `buddi`), or the encrypted file vault at `~/.buddi/vault.json`, or `.env` on a day-1 installation | **No. Never.** |

### Where the database listens, and what protects it

The `buddi-postgres` container publishes **`127.0.0.1:${BUDDI_DB_PORT:-5432}`**
and nothing else. Loopback: only this machine can open a connection at all.

That is one line in `docker-compose.yml` and it is load-bearing. A published
port written as `"5432:5432"` — with no host — is bound by Docker to `0.0.0.0`,
which means every host on whatever network the laptop has joined can reach the
database directly, bypassing every approval gate buddi has, because those live
in the application and this is the storage underneath it.

The **one** legitimate reason to change the address is reaching this database
from another machine of your own over a *private* network — a Tailscale or
WireGuard interface. Name that interface's address explicitly:

```yaml
ports:
  - "100.x.y.z:${BUDDI_DB_PORT:-5432}:5432"   # a tailnet address, not 0.0.0.0
```

Never bind it to `0.0.0.0` on a network you do not control: a café, an office
LAN, a hotel, a conference. There is no configuration elsewhere in buddi that
makes that safe.

The **password** is 32 random URL-safe characters (192 bits), generated once by
`buddi init` — or by the first `buddi db up` — and kept in the OS keychain under
`BUDDI_DB_PASSWORD`. It is never written to a file. `DATABASE_URL` is assembled
from it in memory at startup, in this precedence:

1. an explicit `DATABASE_URL` in the environment or in `.env` — the escape hatch
   for running your own Postgres; buddi will not generate or rotate a credential
   it did not issue;
2. a whole `DATABASE_URL` you put in the vault yourself;
3. `BUDDI_DB_PASSWORD` from the vault, wrapped around `buddi@127.0.0.1:<port>/buddi`;
4. the day-1 default, password and all, so an installation that predates this
   keeps running — loudly: `buddi doctor` fails on it.

`buddi doctor` has a `database exposure` row, and it is **critical** — a failure
exits 1. It fails when the published port is bound to anything but a loopback
address, and when the password is the literal `buddi` or is missing from the
vault while compose expects it. The message names the fix.

### Migrating an installation that predates this

```sh
buddi db secure        # rotate, store, rewrite .env — idempotent
buddi db down && buddi db up   # re-create the container on 127.0.0.1
buddi service restart  # the running process is holding the old password
```

`buddi db secure` changes the password inside the running server with `ALTER
ROLE`, proves the new one connects, and only then writes it to the vault and
rewrites `.env` to `DATABASE_URL="<vault>"`. If any step fails it puts the old
password back and says so: the installation is left working on the old
credential rather than half-migrated. Run it twice and the second run rotates
nothing.

The `down`/`up` is separate because a published port is fixed at container
creation: your data is in the named volume and survives it.

Two things follow from the first row that are worth saying plainly:

- **The Docker volume is not yours to copy.** `docker compose down` leaves it alone,
  but `docker compose down -v` deletes it, and so does "Clean / Purge data" in Docker
  Desktop. A backup is a `pg_dump`, which survives all of that and can be restored
  into a different Postgres on a different machine.
- **`data/` and `private/` are gitignored.** They are not in your git history, and
  pushing the repo does not back them up.

### The file vault's key, on a machine with no keychain

macOS has a keychain and buddi uses it; there is nothing in this section for
you. Everywhere else — Linux, a container, CI — the vault is an encrypted file
at `~/.buddi/vault.json`, and **`BUDDI_VAULT_KEY` is the key that opens it**.
It is held outside the file it unlocks, which is the whole point: a stolen
`vault.json` on its own is ciphertext.

`buddi init` generates that key if there is none and writes it into `.env`, at
mode `600`, in the line `.env.example` already reserves for it. It is the
**only** command that ever mints one. Nothing else does — not `buddi db up`,
not the background service — because a key generated by a second process would
seal secrets the first one cannot open, and the result would look like a
corrupt vault rather than like a mistake. Every other command that finds the
vault locked says which file, which variable, and to run `buddi init`.

Two consequences worth reading once:

- **That line in `.env` is the only copy.** It is not in the database, it is
  not in a backup (it is scrubbed by shape — see below — precisely because it
  is the key to everything else), and it is not in git. Copy it somewhere you
  would keep a recovery code.
- **Losing it costs you the database, not just the secrets.** The generated
  Postgres password lives in that vault. Without the key it cannot be read, so
  `DATABASE_URL` cannot be assembled, and the data is intact and unreachable at
  the same time. Recovering from that means resetting the role's password
  inside the container by hand:

  ```sh
  docker compose exec -T postgres psql -U postgres -d buddi \
    -c "alter role buddi with password '<a new one>'"
  buddi vault delete BUDDI_DB_PASSWORD   # the unreadable one
  buddi vault set BUDDI_DB_PASSWORD      # the new one, with a key that works
  ```

  Every other secret — the model credential, the bot token, the app password —
  is rotated rather than recovered, exactly as after a restore.

`buddi doctor`'s `vault` row says which vault this machine has, and on a file
vault it repeats the "never in a backup, keep a copy off this machine" line
every time rather than once, at `init`, months ago.

### Getting into the dashboard, and what protects it

The dashboard is not a chart viewer. It approves actions — it is where a
proposed email is read and sent, and every plugin that arrives adds to that
list. An unauthenticated port that shows a balance is a privacy problem; an
unauthenticated port that can move money is a different kind of problem, and
that is the one this model is sized for.

**The chain, unchanged.** A long random token is generated on first run and
kept in the keychain (or `data/web-token`, mode `600`). It never appears in a
URL. `buddi dashboard` mints a **ticket** signed with it: single-use, five
minutes, and the server refuses a second presentation of the same one. The
browser swaps it, on a clean URL, for an `HttpOnly; SameSite=Strict` session
cookie. Every write additionally carries a double-submit CSRF header and an
`Origin` that is the bound address. There is no CORS, `OPTIONS` is refused, and
anything unauthenticated is `401` with an empty body.

**What changed is how long a session lasts, and only that.**

| Where the browser is | Idle lifetime | Why |
| --- | --- | --- |
| **Local** — the connection comes from `127.0.0.0/8` or `::1` | **30 days** | On loopback, the session is the only thing standing between the page and *another human with a login on this Mac*. The browser-borne attack is already dead (`SameSite=Strict`, the Origin check, no CORS), and a hostile process running as you can read `.env` and the keychain whatever this number says. Retyping a terminal command twice a day bought nothing. |
| **Remote** — anything else, a tailnet address included | **12 hours** | A session reachable from a network is reachable by things that are not you. This is what the dashboard has always had, and it keeps it. |

Both are *idle* lifetimes. A session in use never expires underneath you: every
authenticated request pushes the expiry out, and the cookie in the browser is
re-issued once it is halfway through its life — often enough that it can never
be the half that dies first, rarely enough that responses are not all carrying
`Set-Cookie`. Stop using it for the whole window and it lapses; the next visit
needs a fresh ticket.

**A remote TCP connection always counts as remote.** Forwarded headers never
elevate access. A loopback connection carrying proxy metadata (`Forwarded`,
`X-Forwarded-*`, `X-Real-IP`, `Tailscale-*`) or a non-loopback `Host` is also
classified remote. These strings can only *reduce* access: they prevent a local
reverse proxy from inheriting loopback auto-login or the month-long lifetime.
Local sessions are refused on remote/proxied requests, so their lifetime cannot
travel. Neither a proxy header nor a Tailscale identity header signs a user in.

If you put the dashboard behind Tailscale (`BUDDI_WEB_HOST` on the tailnet
address), those requests are **remote** and get the 12 hours — deliberately.
Tailscale authenticates the device, not the person holding the laptop, and the
short lifetime is the cheap half of that answer.

**Private HTTPS with Tailscale Serve.** Keep `BUDDI_WEB_HOST=127.0.0.1` and set
`BUDDI_WEB_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net:9443` in `.env`.
Restart Buddi, then use `tailscale serve --bg --https=9443 http://127.0.0.1:4317`.
Inspect existing Serve mappings first and choose an unused port; do not reset
other services or use Funnel. This endpoint is tailnet-only and retains Buddi's
single-use sign-in ticket, remote 12-hour session, CSRF and exact Origin checks.
Remote cookies carry Secure; local loopback access still works without tickets.
The external origin is explicit configuration, never inferred from proxy headers.

For first sign-in, run `buddi dashboard --token` on the host and privately give the
owner `https://<machine>.<tailnet>.ts.net:9443/?t=<ticket>`. Tickets expire after
five minutes and are single-use; the signing token stays in the keychain/file.
Do not put a ticket in logs or persistent configuration. After sign-in, bookmark
the clean URL. A service restart or expired session requires a fresh ticket.
Disable only this mapping with `tailscale serve --https=9443 off`.

**Signing in through Tailscale.** With Serve in front of the dashboard, you can
skip the ticket entirely: Settings → System → *Sign in through Tailscale*, turn
it on and name the Tailscale login that may sign in (the field is prefilled with
the login this machine is signed in as). Anyone signed in to Tailscale as that
login, on any device in your tailnet, is then signed in to buddi; everyone else
still gets a 401.

The headers Serve adds (`Tailscale-User-Login` and friends) are *not* what
grants this. An identity is honoured only when the setting is on with an allowed
login, the connection to the gateway comes from loopback (Serve is a local
process), `X-Forwarded-For` is a tailnet address (`100.64.0.0/10` or
`fd7a:115c:a1e0::/48`), and the local `tailscaled` — asked over its own unix
socket — says that address belongs to that login. A mismatch, a missing daemon
or a failed whois is no identity at all: the request is unauthenticated and gets
the same 401 it would have got before, with one line in the log saying why (at
most once a minute). Answers are cached for a minute, so removing a device from
the tailnet takes effect while you are still looking at the screen.

The session it mints is an ordinary **remote** session: 12 hours idle, `Secure`
cookies, CSRF and Origin checks on every write. The setting itself can only be
changed from a local or ticket session — the panel is read-only when viewed
through Tailscale — so a device someone walked off with cannot widen access.
`buddi doctor`'s `tailscale` row says whether the daemon is there, who may sign
in, whether the public origin is a `.ts.net` one and whether `tailscale serve
status` forwards anything to the gateway's port.

**Opening it without a terminal.** Optional, and alongside `buddi service
install` rather than part of it:

```sh
buddi dashboard --install-app     # "Buddi Dashboard" in ~/Applications
buddi dashboard --uninstall-app   # gone again
```

That writes a small unsigned `.app` bundle whose entire program is `exec node
…/buddi dashboard`. Open it from Launchpad, Spotlight or the Dock and a browser
tab appears. **It holds no secret** — not the token, not a ticket, not a URL
with one in it; each open runs the same command and mints the same fresh
single-use ticket, so the click is a shortcut through the front door, not a key
left under the mat. Delete the bundle and nothing else changes.

**Turning it off.** `BUDDI_WEB=0` in `.env`, then `buddi service restart`. The
server is then not started at all — no port, no session, no ticket. To move it
instead, `BUDDI_WEB_HOST` / `BUDDI_WEB_PORT`; binding anywhere but loopback puts
an Approve button on your network, `buddi doctor` warns about it, and it should
have an authenticated transport in front of it.

## What a backup contains

One timestamped archive, `buddi-backup-YYYYMMDD-HHMMSS.tar.gz`, written to
`<data dir>/backups` (directory mode `0700`, archive mode `0600`):

```
manifest.json          what this backup is, and a sha256 of every file below
database.dump          pg_dump --format=custom of the whole database
env.scrubbed           your .env with every secret VALUE replaced by "<vault>"
private/agents/…       your private agents, as resolved by the search path
private/skills/…       your private skills
artifacts/…            the artifact store files (omitted with --no-artifacts)
```

`manifest.json` holds:

- **buddi version** — `git describe --tags --always --dirty`, or the package version
  when this is not a git checkout. Which code took the dump is part of whether it can
  be restored.
- **migrations** — every row of `core.migrations` (schema, filename, applied-at) with
  the **sha256 of each migration file** as it exists in this build, where the file is
  still present. This is how you tell "this dump predates the finance migration" from
  "this dump is fine".
- **row counts per table** — exact counts, not `reltuples` estimates, for every table
  outside the system schemas. These are what you compare against after a restore.
- **artifacts** — count and total bytes, or, with `--no-artifacts`, an explicit
  `skipped` sentence naming how many files and how many bytes are *not* here.
- **private directories** — where they were resolved from, and how many files.
- **secret names** — the names only, plus the exact `buddi vault set …` commands that
  put them back.
- **timezone**, **host**, **created-at**, and the database's name/host/port/user (never
  its password).
- **members** — every file in the archive with its size and sha256.

## What is deliberately NOT in a backup, and why

**Secrets. All of them.** No model credential, no bot token, no app password, no
database password, no `BUDDI_VAULT_KEY`. This is not an oversight and it is not
configurable. An archive is your **data** and never a way into it: it holds the
`pg_dump` of everything the agents know, and nothing that would let a finder
connect to the live database or speak as you to a provider.

- A backup is a file that gets copied to a USB stick, an external disk, a cloud sync
  folder, a second laptop. Every one of those copies is a place a credential would
  then live, forever, with no rotation and no revocation.
- ARCHITECTURE.md's rule is that "a secrets *table* would hand mail and model
  credentials to anyone with the database file". An archive containing secrets is the
  same mistake in a different wrapper.
- `BUDDI_VAULT_KEY` is the sharpest case: it is not one secret, it is the key that
  unlocks *every* secret in the file vault. It is scrubbed by shape, not by name, so a
  variable buddi has never heard of still gets scrubbed if it is called
  `…_KEY`, `…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_CREDENTIAL`, `…_COOKIE` or
  `…_SESSION`.

So `env.scrubbed` has every such line rewritten to `NAME="<vault>"` — the same marker
`buddi vault import-env` writes, which buddi reads as "ask the vault". `DATABASE_URL`
and `BUDDI_DB_PASSWORD` are on that list by name, so a connection string with a
password in it becomes the marker rather than a URL with a `***` in the middle; a
password embedded in some *other* non-secret URL is still replaced with `***`.
Before an archive is written at all, the scrubbed text is scanned for every value the
original file held under a secret-shaped name; if any survived, **no archive is
written**. That check is a test, not a comment.

Also not in a backup, for less dramatic reasons:

- **The examples** (`examples/agents`, `examples/skills`) — they are in git.
- **The code** — it is in git.
- **Logs** (`<data dir>/logs`) — they are large, they are not state, and they are the
  one place a redaction bug would show up in an archive.
- **Docker volume files** — a `pg_dump` is portable across machines and Postgres
  patch versions; a copied volume directory is neither.

## Taking a backup

```
buddi backup create                     # to <data dir>/backups
buddi backup create --out /Volumes/ext  # somewhere else
buddi backup create --no-artifacts      # metadata + database only, much smaller
buddi backup create --prune 14          # take one, then keep only the newest 14
```

`pg_dump` runs **inside the container** (`docker compose exec -T postgres pg_dump`),
so you never need a local Postgres client and you can never hit the
"pg_dump 15 cannot read a server 16 database" wall.

## Proving a backup is good

```
buddi backup verify <archive>
```

This needs **no database, no Docker and no network**. It:

1. reads the tar listing,
2. reads `manifest.json` and checks its shape and format version,
3. unpacks to a temp directory and recomputes the sha256 of **every** member,
   comparing each against the manifest — and complains about files in the archive
   that the manifest does not list,
4. checks that `database.dump` starts with `PGDMP`, i.e. that it really is a
   `pg_dump` custom-format archive and not a zero-byte file or an error message that
   got redirected into one.

It prints the manifest summary — row counts, migrations, artifact count, secret names
— and exits non-zero if anything is wrong. Run it after every backup you care about;
the nightly job's log is where you will see it if one starts failing.

## Restoring, step by step

A restore is four separate things, and only three of them are automatic. Follow this
in order.

### 1. Get Postgres running

```
buddi db up
```

### 2. Verify the archive before you commit to it

```
buddi backup verify ~/buddi-backups/buddi-backup-20260914-033000.tar.gz
```

`buddi backup restore` re-runs this itself and refuses to touch anything if it fails —
`--force` does not skip it — but knowing the archive is good before you start is
cheaper than finding out halfway.

### 3. Restore

```
buddi backup restore <archive>                     # into the database the archive names
buddi backup restore <archive> --into buddi_check  # into a scratch database instead
buddi backup restore <archive> --yes               # over a database that has rows in it
buddi backup restore <archive> --force             # overwrite non-empty private dirs
```

What it does:

- **The database.** `pg_restore --clean --if-exists --no-owner --single-transaction`,
  through the container. `--single-transaction` is what makes it all-or-nothing: a
  restore that fails halfway leaves the target exactly as it was, rather than
  half-populated. A database named by `--into` is created if it does not exist.
- **The private directories**, to their *resolved* locations — the same ones
  `buddi doctor`'s `config` row prints, not necessarily the ones on the machine that
  made the backup. If the destination already has files in it, the restore **refuses**
  and says so; `--force` overwrites.
- **The artifacts**, into `<data dir>/artifacts`.
- **Not `.env`.** The archive's `env.scrubbed` is left in the archive; your `.env` is
  never written over. Compare them by hand.
- **Not the vault.** See step 4.

The guard: restoring over a database that **has rows in it** requires `--yes` *and*
typing the database name back at the prompt. Both, because one confirmation is the
number a person clicks through without reading. An empty database — or a
migrated-but-rowless one — goes through with no ceremony, since that is the ordinary
new-machine case.

The command prints three lists, always: **did**, **did NOT**, and **now do this, in
order**. The "did NOT" list always includes the vault.

### 4. Put the secrets back by hand

The restore prints the exact commands. They look like:

```
buddi vault set CLAUDE_CODE_OAUTH_TOKEN
buddi vault set TELEGRAM_BOT_TOKEN
buddi vault set GMAIL_APP_PASSWORD
```

Each prompts with the terminal's echo off — a secret is never a command-line argument,
because that would put it in your shell history.

If you use the **file vault** rather than the macOS keychain, you also need
`BUDDI_VAULT_KEY` back in `.env` *before* any of the above will work: without it the
vault is locked, and buddi fails closed rather than falling back to anything.

If a secret is genuinely gone — the machine it lived on is in the sea — this is the
moment to **rotate** rather than recover: `claude setup-token` for a new subscription
token, @BotFather for a new bot token, Google's app-password page for a new mail
password. A backup that could have restored these for you is a backup that could have
leaked them for you.

### 5. Check and restart

```
buddi doctor            # every row should be ok or an understood warning
buddi service restart   # the service holds its credentials from startup
```

`buddi service restart` is required, not optional: the running service hydrated its
secrets at boot and is still holding a connection to the old database. Nothing you
restored reaches it until it restarts.

## Testing a restore safely

Do this once a quarter. It takes two minutes and it is the only thing that turns a
backup into a *known-good* backup.

```
# 1. restore into a scratch database — your live one is never touched
buddi backup restore <archive> --into buddi_drill

# 2. compare what came back against what the manifest claimed
docker compose exec -T postgres psql -U buddi -d buddi_drill -c \
  "select schemaname, relname, n_live_tup from pg_stat_user_tables order by 1,2"

# 3. throw it away
docker compose exec -T postgres psql -U buddi -d postgres -c \
  "drop database buddi_drill"
```

Two things make this safe: `--into` never touches the database the archive names, and
the restore's own guard refuses a target with rows in it unless you both pass `--yes`
and type the name.

The same drill runs in CI-shaped form in
`packages/cli/src/backup/restore.db.test.ts`: it builds a throwaway database with real
tables and rows, takes a real backup through the same code path, verifies the archive,
restores into a second throwaway database, and asserts the rows came back. It is
skipped unless `DATABASE_URL` is set.

## The nightly backup

```
buddi backup schedule install            # 03:30 local, keep 14
buddi backup schedule install --keep 30
buddi backup schedule status
buddi backup schedule uninstall          # archives are kept
```

This installs a **second** launchd agent, `com.buddi.backup`, separate from
`com.buddi.serve`. That separation is deliberate: a backup that only runs while the
thing being backed up is healthy is the one backup you cannot rely on — a
crash-looping service would quietly stop taking them, and the night you need one is
exactly the night it did not run.

- It fires on `StartCalendarInterval`, not `StartInterval`, so a laptop that was
  asleep at 03:30 takes its backup when it wakes rather than skipping the day.
- It runs `buddi backup create --prune <keep>`, so pruning is part of the same job and
  cannot drift out of sync with it.
- It logs to `<data dir>/logs/backup.log` and `backup.err`.
- On Linux it is a systemd **user timer** with `Persistent=true`. That path is written
  to the same spec but untested, and says so when it installs.

`buddi doctor` grows a `backups` row: how many archives there are, how old and how
large the newest is, and whether the schedule is installed. It warns when there is no
backup at all, when the newest is older than 48 hours, or when backups exist but
nothing is scheduled to take the next one. It is never `fail` — an installation with
no backup works perfectly today, which is exactly why the warning must not be one you
learn to ignore.

## Keeping it up to date

New code is four separate things — install, build, migrate, restart — and
**migrations do not run themselves**. Three of the four ways to get that wrong
are silent:

| Skip | What you get |
| --- | --- |
| the build | the service keeps executing last month's code against this month's schema |
| the migration | a tool fails hours later, at the moment an agent calls it, as a Postgres error in a log |
| the restart | everything looks upgraded until the next reboot disagrees |

So the order is a command rather than a paragraph:

```sh
git pull          # you do this
buddi upgrade     # buddi does the rest
```

`buddi upgrade` **does not fetch.** The checkout is yours: it may be a fork, it
may be on a branch, it may carry your own edits. A command that pulled could
leave a merge conflict inside a working installation, and resolving that is not
something a wizard gets to attempt on your behalf. It upgrades the code already
on disk and prints the commit it is about to install, so you can tell whether
your pull landed.

What it does, in this order:

1. **`buddi backup create`.** Before anything, because the migration is the one
   step that cannot be repeated away. If the backup fails, nothing else runs.
   `buddi upgrade --no-backup` if you took one five minutes ago.
2. **Stops the background service**, if one is running. Old code must not be
   executing while the schema moves underneath it. Whether it *was* running is
   remembered, so an installation with no service does not acquire one.
3. **`pnpm install` then `pnpm -r build`**, in that order — a build over stale
   dependencies is worse than one that fails, because it succeeds.
4. **`buddi migrate`**, which is core's migrations *and every installed
   plugin's*. A plugin's schema is never left a version behind the code that
   reads it. A plugin that fails to migrate is named by its schema.
5. **Starts the service again**, if it was running when the command arrived.
6. **`buddi doctor`**, because the last word on whether an upgrade worked
   belongs to the thing that checks every moving part.

### When it fails halfway

Migrations in this project only go forward, so the answer is the archive taken
in step 1, not an undo. Every failure stops the run and says what did and did
not happen:

| Fails at | Where you are | What to do |
| --- | --- | --- |
| backup | nothing was touched | `buddi doctor`, `buddi db up`, then run it again |
| install / build | the database is untouched, the service is running again on the code it had | fix the build, run it again |
| migrate | new code is built, the schema is partly migrated, **and the service is deliberately left down** | run `buddi migrate` until it succeeds, then `buddi service start`. That combination is the one to never leave running |
| doctor | the upgrade finished; a row wants attention | read the row. This is a configuration question, not a failed upgrade |

By hand, if you would rather see each step:

```sh
buddi backup create
buddi service stop
pnpm install && pnpm -r build
buddi migrate
buddi service start
buddi doctor
```

### Upgrading a plugin

Somebody else's plugin has its own lifecycle and its own schema, and
[docs/plugins.md](./plugins.md) covers it. The short version: `buddi upgrade`
migrates every plugin that is *installed*, so a plugin whose code you replaced
in place is migrated with everything else. Installing a newer version of one is
`buddi plugins install <dir>`, which reads what it contributes before it
changes anything.

## Retention

```
buddi backup prune            # keep the newest 14
buddi backup prune --keep 30
```

`--keep 0` is refused, not clamped: it reads like "delete every backup I have", and a
prune that does that on a typo is not a feature. Prune only ever deletes files whose
names match `buddi-backup-YYYYMMDD-HHMMSS.tar.gz`; anything else in the directory is
left alone.

## Off-machine copies

`<data dir>/backups` is on the same disk as the thing it is backing up, which protects
you from `docker compose down -v` and from a bad migration, but not from a dead disk or
a stolen laptop. Copy archives somewhere else — an external disk, a sync folder, another
machine:

```
buddi backup create --out /Volumes/backup/buddi
rsync -a ~/…/data/backups/ backup-host:buddi-backups/
```

This is safe to do with any cloud sync you like, for one reason: there is no secret in
the archive. Your financial history and your mail *are* in it, so pick somewhere you
would be comfortable keeping those — but no credential travels with them.
