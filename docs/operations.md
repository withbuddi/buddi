# Operations — backup, restore, and where your data actually lives

Status: reference, 2026-09-21

This installation holds your financial history, your mail, the memories your agents
have formed about you, and the personas you wrote. ARCHITECTURE.md promises that
"rotation, backup/restore, and log redaction are specified" before you rely on the
system daily. This document is the backup/restore half of that promise, and it
is the page that **owns** backup and restore: what an archive holds, the
passphrase, the schedule, restoring, the pre-restore snapshot and recovery mode
are all here. [install.md](install.md) §8 keeps only what the install spec
itself needs and points back here.

The short version:

In a packaged installation this all lives on one page: **Settings → Backup**.
Turn the schedule on, press *Back up now*, and the list underneath verifies and
restores. From a terminal, in either kind of installation:

```
buddi backup schedule install    # nightly at 03:30, prune included — do this once
buddi backup create --encrypt    # take one now, locked with the passphrase
buddi backup verify <archive>    # prove it is good, without a database
buddi backup list                # what you have
```

---

## Where your data actually lives

Four places, and only two of them are in a backup. There are **two kinds of
installation** and they keep their data in different places, so every row below
answers twice:

- a **developer checkout** — `git clone`, Docker Desktop, `buddi db up`;
- a **packaged install** — `npm install -g @withbuddi/buddi`, where the supervisor owns a
  bundled Postgres and everything sits under one data directory, `<data>`:
  `~/Library/Application Support/buddi` on macOS,
  `${XDG_DATA_HOME:-~/.local/share}/buddi` on Linux, `%LOCALAPPDATA%\buddi` on
  Windows, or wherever `BUDDI_DATA_DIR` points
  (`packages/install/src/environment.ts`).

| What | Developer checkout | Packaged install | In a backup? |
| --- | --- | --- | --- |
| The database | Docker **named volume** `buddi-pgdata`, mounted at `/var/lib/postgresql/data` in the `buddi-postgres` container | `<data>/postgres` — a cluster the supervisor runs with the bundled binaries it keeps in `<data>/runtime` (`packages/install/src/postgres.ts`, `packages/core/src/postgres/cluster.ts`) | Yes — as `COPY` text, one file per table, never as data-directory files |
| Artifact files | `<data dir>/artifacts/<yyyy>/<mm>/<sha256>.<ext>` — `data/` at the repo root unless `BUDDI_DATA_DIR` says otherwise | `<data>/artifacts/…`, same layout | Yes (skippable) |
| Your private agents and skills | `private/agents` + `private/skills` at the repo root, or `~/.buddi/agents` + `~/.buddi/skills`, or wherever `BUDDI_AGENTS_DIR` / `BUDDI_SKILLS_DIR` point. `buddi doctor` prints the resolved paths in the `config` row | `<data>/agents` + `<data>/skills` | Yes |
| Secrets | The **macOS keychain** (service `buddi`), or the encrypted file vault at `~/.buddi/vault.json`, or `.env` on a day-1 installation | The same keychain, or the file vault whose key is in `<data>/.env` | **No. Never.** |
| The backups themselves | `<data dir>/backups` | `<data>/backups` | They are the backup |

### Where the database listens, and what protects it

**In a developer checkout.** The `buddi-postgres` container publishes
**`127.0.0.1:${BUDDI_DB_PORT:-5432}`** and nothing else. Loopback: only this machine can open a connection at all.

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

**In a packaged install** there is no Docker and no compose file, so none of the
above applies and none of it is a risk you can create by hand. The supervisor
spawns the postmaster itself as `postgres -D <data>/postgres -p <port> -h
127.0.0.1 -k ''` — loopback TCP and, because of `-k ''`, **no Unix socket at
all**. The port is a free one chosen once at provisioning and recorded in
`<data>/installation.json` (and exported as `BUDDI_DB_PORT`); it is not 5432.
The application role `buddi` is `NOSUPERUSER NOCREATEDB NOCREATEROLE`, its
password is in the vault as `BUDDI_DB_PASSWORD` and is re-applied with `ALTER
ROLE` on every start, so a restored or rotated credential resyncs by itself.
Before starting, the cluster manager proves `SHOW data_directory` is its own and
refuses a foreign server on the same port rather than touching its roles.

Two things follow from the first row that are worth saying plainly:

- **The Docker volume is not yours to copy.** `docker compose down` leaves it alone,
  but `docker compose down -v` deletes it, and so does "Clean / Purge data" in Docker
  Desktop. A backup is the database as text, which survives all of that and can be
  restored into a different Postgres on a different machine — a packaged install's
  bundled cluster included.
- **`data/` and `private/` are gitignored.** They are not in your git history, and
  pushing the repo does not back them up.

### The file vault's key, on a machine with no keychain

macOS has a keychain and buddi uses it; there is nothing in this section for
you. Everywhere else — Linux, a container, CI — the vault is an encrypted file
(`vault.json` in the data directory), and **`BUDDI_VAULT_KEY` is the key that
opens it**. It is held outside the file it unlocks, which is the whole point:
a stolen `vault.json` on its own is ciphertext. A packaged install keeps the
key in `<data>/vault-key` (mode `0600`) beside the data; a checkout keeps it in
`.env`. Either way the key and the ciphertext share the owner's `0700` data
directory, so what the vault protects is the file at rest and against another
account on the machine — not against someone who already has this account.

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

  In a **developer checkout**:

  ```sh
  docker compose exec -T postgres psql -U postgres -d buddi \
    -c "alter role buddi with password '<a new one>'"
  buddi vault delete BUDDI_DB_PASSWORD   # the unreadable one
  buddi vault set BUDDI_DB_PASSWORD      # the new one, with a key that works
  ```

  In a **packaged install** the same two `buddi vault` commands apply, but the
  `ALTER ROLE` needs a client of your own: the bundled distribution is
  server-only (`initdb`, `postgres`, `pg_ctl` — no `psql`, no `pg_dump`), and
  there is no socket to connect over. Use any Postgres client against
  `127.0.0.1:<the port in <data>/installation.json>`, database `buddi`, as the
  admin role `buddi_admin` whose password is in the vault under
  `BUDDI_DB_ADMIN_PASSWORD`. In practice the supervisor does this for you: it
  re-applies `BUDDI_DB_PASSWORD` on every start, so setting the vault entry and
  restarting is usually the whole fix.

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

**Previews on the move.** A developer agent's preview is served on a second
listener, the dashboard port plus one (4318 by default), and a preview link
minted on the tailnet would otherwise name `127.0.0.1`, which on a phone is
the phone. Publish that listener too and tell buddi where it landed:

```
tailscale serve --bg --https=9444 http://127.0.0.1:4318
BUDDI_PREVIEW_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net:9444
```

A remote session's "Open in a tab" and its framed preview then use that
origin; a local session keeps the loopback one. The preview keeps its own
single-use ticket and cookie, marked Secure behind Serve. The panel also
offers the process's own `localhost:<port>` link, for when you are at the
machine.

**Signing in through Tailscale.** With Serve in front of the dashboard, you can
skip the ticket entirely: Settings → System → *Sign in through Tailscale*, turn
it on and name the Tailscale login that may sign in (the field is prefilled with
the login this machine is signed in as). Anyone signed in to Tailscale as that
login, on any device in your tailnet, is then signed in to buddi; everyone else
still gets a 401.

The headers Serve adds (`Tailscale-User-Login` and friends) are *not* what
grants this. An identity is honoured only when the setting is on with an allowed
login, the connection to the gateway comes from loopback (Serve is a local
process), `X-Forwarded-For` names exactly one address — Serve overwrites that
header, so a list means a second proxy is in the path and is refused — that
address is a tailnet address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`),
`X-Forwarded-Proto` is `https`, and the local `tailscaled` — asked over its own
unix socket — says that address belongs to that login and names the very login
the header claimed. A mismatch, a missing daemon
or a failed whois is no identity at all: the request is unauthenticated and gets
the same 401 it would have got before, with one line in the log saying why (at
most once a minute). Answers are cached for a minute, so removing a device from
the tailnet takes effect while you are still looking at the screen.

The session it mints is an ordinary **remote** session: 12 hours idle, `Secure`
cookies, CSRF and Origin checks on every write — and seven days at the outside,
however much it is used. It is not a bearer token: the daemon is asked again on
every request and must still name the login the session was minted for, so
turning the setting off or naming a different login signs every tailnet browser
out at once. The setting itself can only be changed from a session established
on this machine — the panel is read-only when viewed through Tailscale — so a
device someone walked off with cannot widen access.

What this does not prove is worth saying plainly: buddi cannot distinguish
`tailscale serve` from any other process on the same machine that connects to
the same loopback port and spells the same headers. Turning this on extends to
your tailnet the trust the loopback dashboard already gives this machine, and no
more — a process that can reach that port could already read the data
directory.
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

One timestamped archive per backup, `buddi-backup-YYYYMMDD-HHMMSS.tar.gz`
(local time, so a listing reads the way you remember it), written to
`<data>/backups` — directory mode `0700`, archive mode `0600`. Encrypted, which
is the default in a packaged install and the recommendation everywhere, it is
`buddi-backup-YYYYMMDD-HHMMSS.tar.gz.age` with a small clear-text envelope
beside it, `….tar.gz.json`.

Inside, one gzipped tar written with the system `tar` — deliberately, so that an
owner with this archive, a shell and nothing else can get their data out:

```
manifest.json               what this backup is, and a sha256 of every file below
db/tables.json              every table dumped: schema, name, column order, row count
db/sequences.json           every sequence and its last value
db/migrations.json          the migration level the dump was taken at, per schema
db/<schema>.<table>.copy    the rows, one Postgres COPY text file per table
env.txt                     your .env with every secret VALUE replaced by "<vault>"
plugins.json                every installed plugin: name, version, integrity hash, source
private/agents/…            your private agents, as resolved by the search path
private/skills/…            your private skills
artifacts/…                 the artifact store files (omitted with --no-artifacts)
```

**There is no `pg_dump` and no `pg_restore` anywhere in this.** The bundled
Postgres a packaged install runs on ships `initdb`, `pg_ctl` and `postgres` and
nothing else, so an engine that shelled out to `pg_dump` would have worked only
on a developer machine with Homebrew Postgres on it. Instead
`packages/core/src/backup/dump.ts` reads the database over the ordinary
connection:

- the schemas it dumps are buddi's own — `core`, plus every schema with rows in
  `core.migrations`;
- everything happens on **one** client inside one `begin isolation level
  repeatable read read only` transaction, so the whole archive is a single
  snapshot of a live installation. The gateway keeps running during a scheduled
  backup, and per-table snapshots would archive a child row whose parent is
  missing;
- each table is streamed out with `copy (select <columns> from …) to stdout`,
  with the columns named explicitly, so a target whose table has since gained a
  column can still read the file. Generated columns are left out; identity
  columns are kept, because `COPY … FROM` may supply their values;
- tables are ordered parents before children.

`manifest.json` is written last, after every member has been hashed, and holds:

- **`format`** — `2`, the driver-based dump. This is the marker that a verify
  checks, and it is what a format-1 archive (the old `pg_dump` engine) fails on:
  those cannot be restored by this build at all.
- **`buddiVersion`** — the `@buddi/core` version that wrote the archive. Never a
  description of a git checkout, which says nothing on a packaged install.
- **`postgresMajor`** — the major version of the server the rows came out of.
  Informational: the restore does not need it to match, because the code, not
  the server, knows the schema.
- **`migrations`** — every row of `core.migrations` (schema, filename,
  applied-at) with the **sha256 of each migration file** as this build ships it.
  This is how you tell "this dump predates the finance migration" from "this
  dump is fine".
- **`tables`** — exact row counts, per table. These are what a verify compares
  the COPY files against, and what you compare against after a restore.
- **`plugins`** — for each installed plugin its name, version, schema and
  *source* (a registry name, a tarball path, or a directory), so a restore can
  say what to reinstall and name what only you can supply.
- **`artifacts`** — count and total bytes, or, with `--no-artifacts`, an explicit
  `skipped` sentence naming how many files and how many bytes are *not* here.
- **`private`** — where the agents and skills directories were resolved from, and
  how many files.
- **`secrets`** — the names only, plus the exact `buddi vault set …` commands that
  put them back, and the note that says the vault is not in here.
- **`timezone`**, **`host`**, **`createdAt`**, and the database's
  name/host/port/user (never its password).
- **`members`** — every file in the archive with its size and sha256.

## What is deliberately NOT in a backup, and why

**Secrets. All of them.** No model credential, no bot token, no app password, no
database password, no `BUDDI_VAULT_KEY`, and not the backup passphrase either.
This is not an oversight and it is not configurable. An archive is your **data**
and never a way into it.

- A backup is a file that gets copied to a USB stick, an external disk, a cloud sync
  folder, a second laptop. Every one of those copies is a place a credential would
  then live, forever, with no rotation and no revocation.
- ARCHITECTURE.md's rule is that "a secrets *table* would hand mail and model
  credentials to anyone with the database file". An archive containing secrets is the
  same mistake in a different wrapper.
- `BUDDI_VAULT_KEY` is the sharpest case: it is not one secret, it is the key that
  unlocks *every* secret in the file vault. It is scrubbed by shape, not by name, so a
  variable buddi has never heard of still gets scrubbed if it is called
  `…_KEY`, `…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_PASSWD`, `…_APIKEY`,
  `…_CREDENTIAL(S)`, `…_COOKIE` or `…_SESSION`.

So `env.txt` has every such line rewritten to `NAME="<vault>"` — the same marker
`buddi vault import-env` writes, which buddi reads as "ask the vault". A multi-line
quoted value (a private key) is scrubbed as one unit, and so is a commented-out
secret line. `DATABASE_URL` and `BUDDI_DB_PASSWORD` are on the list by name, so a
connection string with a password in it becomes the marker rather than a URL with a
`***` in the middle; a password embedded in some *other* non-secret URL is still
replaced with `***`, and that key is listed in the manifest under
`secrets.redacted`.
Before an archive is written at all, the scrubbed text is scanned for every value the
original file held under a secret-shaped name; if any survived, **no archive is
written**. That check is a test, not a comment.

Also not in a backup, for less dramatic reasons:

- **The examples** (`examples/agents`, `examples/skills`) — they are in git.
- **The code** — it is in git.
- **Logs** (`<data>/logs`) — they are large, they are not state, and they are the
  one place a redaction bug would show up in an archive.
- **The bundled Postgres binaries and the plugin packages themselves** — they are
  reinstalled. The archive records what they were.
- **Postgres data-directory files** — the database as text is portable across
  machines and Postgres major versions; a copied data directory is neither.

## The passphrase: six words, and the only copy is yours

An archive that leaves the machine is encrypted; one that stays may be. The
scheme is **`age` passphrase encryption**, exactly as the age specification
defines it (the scrypt recipient stanza), with no buddi-specific key derivation
in front of it, so `age -d` opens any archive buddi wrote, on any machine, with
no buddi installed. The file extension is `.age`; the plaintext `.tar.gz` is
deleted once the ciphertext exists, because leaving it beside the ciphertext
would make the encryption a decoration.

The passphrase is **six words** drawn with a cryptographic RNG from a fixed
512-word list — 54 bits, the number age's own documentation asks for. buddi
generates it the first time it needs one, **prints it once**, and keeps it in the
vault under `BACKUP_PASSPHRASE` so scheduled backups and same-machine restores
never ask for it. Settings → Backup can show it again and can replace it with
one of your own; older archives keep the passphrase they were made with.

> Write the six words down on paper and keep them away from this machine. They
> are the only thing that opens the archive. buddi cannot recover it, and a copy
> that lives only in this keychain dies with this machine.

Sloppy spacing off paper is fine: the words are trimmed and runs of whitespace
collapsed on both sides of every comparison. When buddi needs a passphrase it
looks in three places, in order: a `--passphrase` flag, the vault, then a
terminal prompt — and only when there *is* a terminal, so a scheduled job fails
with a sentence instead of hanging.

Beside each encrypted archive sits the envelope, `<name>.tar.gz.json`: format
version, creation time, buddi version, byte size and a sha256 of the
ciphertext, in the clear. It catches a truncated copy before anyone types a
passphrase. It is **unsigned and treated as untrusted** — after decryption the
inner manifest is authoritative, the envelope is checked against it, and a
mismatch fails verification. A missing envelope is not a failure; age's own
authentication and the manifest are checked instead.

## Taking a backup

```
buddi backup create                     # to <data>/backups
buddi backup create --encrypt           # locked with the passphrase
buddi backup create --out /Volumes/ext  # somewhere else
buddi backup create --no-artifacts      # metadata + database only, much smaller
buddi backup create --prune 14          # take one, then keep only the newest 14
```

No local Postgres client is needed and no Docker exec happens: the dump goes
through the same connection everything else uses, which is why one build can
read any archive another build of itself wrote, newer or older cluster alike.
In a packaged install, *Back up now* on Settings → Backup is the same code path,
asked for over the supervisor's socket.

## Proving a backup is good

```
buddi backup verify <archive> [--passphrase "<six words>"]
```

This needs **no database, no Docker and no network**, and it never restores
anything. It prints one row per check:

| Check | What it proves |
| --- | --- |
| `encryption` | the passphrase opens the archive — reported here, before anything is unpacked |
| `envelope` | the sidecar `.json` matches the ciphertext's size and hash, was not written before the archive or a day after it, and names the same buddi version. Absent is a pass, with a note |
| `archive` / `members` | the tar listing is readable and safe — no absolute paths, no `..`, no symlinks or hard links. A buddi archive holds regular files only |
| `manifest` | it parses, `format` is 2, and every required field is the right shape, each member carrying a 64-hex sha256 |
| `checksums` | every member is unpacked and re-hashed against the manifest, reporting `missing:`, `corrupt:`, `size:` — and `unlisted:`, files in the archive the manifest does not name |
| `database` | there is a COPY file for every table in `db/tables.json`; each file's line count equals the manifest's row count and every line has exactly as many tab-separated fields as the table has columns; `db/sequences.json` and `db/migrations.json` parse |

That last row is what replaced the old engine's "does this file start with
`PGDMP`" check, and it is a great deal stronger: it is not a magic number, it is
every row counted.

It exits non-zero if anything is wrong, and says either *this archive is intact
and restorable* or *this archive is NOT good — do not rely on it*. Run it after
every backup you care about; the nightly job's log is where you will see it if
one starts failing, and Settings → Backup has a **Verify** button per row.

## Restoring, step by step

A restore is four separate things, and only three of them are automatic. Follow this
in order. In a packaged install all of steps 1 to 3 are the *Restore…* button on
Settings → Backup; the terminal path below is the same engine.

### 1. Get Postgres running

```
buddi db up          # a developer checkout; a packaged install's supervisor owns it
```

### 2. Verify the archive before you commit to it

```
buddi backup verify ~/buddi-backups/buddi-backup-20260914-033000.tar.gz.age
```

`buddi backup restore` re-runs this itself and refuses to touch anything if it fails —
`--force` does not skip the checksums — but knowing the archive is good before you
start is cheaper than finding out halfway.

### 3. Restore

```
buddi backup restore <archive>                     # into the database the archive names
buddi backup restore <archive> --into buddi_check  # into a scratch database instead
buddi backup restore <archive> --yes               # over a database that has rows in it
buddi backup restore <archive> --force             # overwrite non-empty private dirs
buddi backup restore <archive> --files             # with --into, bring the files too
```

What it does, in this order:

- **Everything that can refuse, before anything is dropped.** A restore that
  fails in the middle is a restore that destroyed a working installation, so the
  archive's format, the schemas it wants dropped, and the migration level of
  every schema are all checked first, and each refusal ends with *nothing was
  changed*. A schema that is not buddi's — `public`, `information_schema`,
  anything `pg_…` — is never dropped. An archive whose last migration for a
  schema is one this build does not ship was taken by a **newer** buddi: upgrade
  before restoring it.
- **A snapshot of what is there now.** See below.
- **The database.** buddi's own schemas are dropped, rebuilt from **our own
  migrations up to the level the dump recorded**, and the rows loaded back with
  `COPY … FROM` — all in one transaction, with triggers off
  (`session_replication_role = replica`) where the role is allowed to do that and
  a note in the report where it is not. Sequences are set last, inside the same
  transaction, because `setval` is not transactional. Then the migrations the
  dump did *not* have are applied on top of the restored data. That is why the
  *code* has to know the schema and the server does not: any Postgres this build
  runs on can read any archive this build wrote, and `pg_upgrade` is never
  needed. A table no migration in this build creates is reported as not loaded
  rather than failing the restore.
- **The private directories**, to their *resolved* locations — the same ones
  `buddi doctor`'s `config` row prints, not necessarily the ones on the machine that
  made the backup. They go in by swap, not merge: the new directory is written
  beside the old one, the old one is renamed away, the new one is renamed into
  place, and the old one is deleted only once the whole restore has succeeded. If
  the destination already has files in it, the restore **refuses** and says so;
  `--force` overwrites. An archive that claims its agents live anywhere but
  `private/agents` is refused rather than followed.
- **The artifacts**, into `<data>/artifacts`.
- **Not the plugins.** `plugins.json` is *recorded*, not acted on — installing a
  plugin runs migrations and fetches packages. It is written to
  `<data>/restored-plugins.json`, and the recovery checklist reads it.
- **Not `.env`.** The archive's `env.txt` is left in the archive; your `.env` is
  never written over. Compare them by hand.
- **Not the vault.** See step 4.

The guard: restoring over a database that **has rows in it** requires `--yes` *and*
typing the database name back at the prompt. Both, because one confirmation is the
number a person clicks through without reading. An empty database — or a
migrated-but-rowless one — goes through with no ceremony, since that is the ordinary
new-machine case. The dashboard asks for the same typed name.

The command prints three lists, always: **did**, **did NOT**, and **now do this, in
order**. The "did NOT" list always includes the vault.

### 4. Put the secrets back by hand

The restore prints the exact commands, one per secret name the archive recorded:

```
buddi vault set CLAUDE_CODE_OAUTH_TOKEN
buddi vault set TELEGRAM_BOT_TOKEN
buddi vault set GMAIL_APP_PASSWORD
```

Each prompts with the terminal's echo off — a secret is never a command-line argument,
because that would put it in your shell history. In a packaged install the recovery
checklist lists the same names, each a link to the page that takes it.

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
restored reaches it until it restarts. In a packaged install the supervisor does the
stopping and starting around the restore itself — the contract is *stop the gateway,
snapshot, database, files, write the recovery row, start the gateway* — and the
browser waits for the health route and reloads.

## The pre-restore snapshot, and what happens when a restore fails

Before it changes anything, a restore takes **a full backup of the installation
it is about to overwrite**, into the same backups directory, named
`pre-restore-YYYYMMDD-HHMMSS.tar.gz`. It does this whenever the target has any
tables, or any file under the agents, skills or artifacts directories — so a
genuinely empty new machine skips it, and nothing else does. The path is named in
the report, and these snapshots are **never pruned** by any retention: the one
moment they matter is the one where the restore went wrong and nobody is
counting how many backups they have.

If any step after the snapshot fails — a COPY, a file swap, writing the recovery
row — the restore **rolls back**: the swapped directories are put back in reverse
order and the pre-restore snapshot is loaded into the database. The report comes
back `ok: false`, `rolledBack: true`, and says which snapshot it used. A
half-restore cannot exist. Two honest caveats:

- sequences stay advanced, because `setval` is not transactional. The next id is
  simply higher than it needed to be;
- if the target was empty there was no snapshot to put back, so the database is
  left at a clean, freshly migrated schema, and the report says *nothing was
  lost — the target was empty; try another archive*;
- if the rollback itself fails, the report says so plainly and tells you to
  restore the pre-restore archive by hand. It is the copy taken before the run.

## Recovery mode: a restored buddi does nothing until you say so

**A restored installation starts in recovery mode.** The dump carries pending
jobs, missions, approvals in flight, granted permissions and paired surfaces,
none of which should act on a machine they were not granted on. Recovery is a
single row in `core.recovery`, written by the restore inside the same guarded
step as the database — so an installation whose recovery row could not be
written is one whose restore rolled back, rather than one that wakes up and acts
on a week-old queue.

While it is set, the gateway starts stand-ins instead of the real loops: **the
scheduler does not tick, sources do not poll, the queue does not claim, Telegram
does not connect, and no mission runs. Chat and the dashboard work.** Every page
carries a banner — *This buddi was restored from a backup. Nothing runs on its
own until you finish the checklist* — and `buddi doctor` says the same.

The checklist is at the top of **Settings → Backup**:

- **Keys to paste again**, by name, each a link to where it goes;
- **Add-ons to install again**, from the plugin record the archive carried;
- **Work that was waiting** — the jobs, missions, approvals and paired phones
  that were in flight, with *drop it* as the default: it was queued somewhere
  else, days ago;
- **Standing permissions**, listed one by one, with *keep* as a choice you make
  per grant rather than a box that is already ticked.

**"Leave recovery mode"** is one gated action at the end of it. It cancels the
pending jobs and expires the pending approvals unless you kept them, revokes
every standing grant you did not tick, clears the recovery row — and restarts
the service, because the loops are decided once at startup. If the supervisor
cannot be reached it drops nothing and says so instead. In a developer checkout
there is nothing to restart: the loops start the next time `buddi serve` runs.

## In the dashboard: Settings → Backup

Everything above has a page, and in a packaged install it is the page an owner
should use.

- **Every night** — the schedule as a switch and a time, how many to keep
  (1–365), *Lock each one with the passphrase*, and *Also copy to a folder* with
  the path validated before it is saved. A developer checkout sees a notice here
  instead: a checkout schedules its backups with `buddi backup schedule install`.
- **Backups** — the directory, *Back up now*, and the list: name, when it was
  taken, size, a `locked`/`plain` pill, a `damaged` pill when the envelope does
  not match, and **Verify** and **Restore…** per row. Restore asks for the
  passphrase if the archive is locked and for the database name typed back,
  exactly as the CLI does. A checkout is told to run `buddi backup restore
  <file>` instead: restoring needs the supervisor.
- **The passphrase** — *Show it*, and *Use my own*.
- **Restore from a file** — upload an archive taken somewhere else. It streams to
  `<data>/incoming/` under a name the server chooses (the browser's filename is
  never used as a path), and the passphrase and confirmation travel as headers
  rather than in the URL, so they cannot land in a log line. Uploads older than
  a day are swept away at startup.

## Testing a restore safely

Do this once a quarter. It takes two minutes and it is the only thing that turns a
backup into a *known-good* backup.

```
# 1. restore into a scratch database — your live one is never touched
buddi backup restore <archive> --into buddi_drill

# 2. compare what came back against what the manifest claimed
#    (the archive's own row counts are in `buddi backup verify`'s output)
```

Then look at the scratch database with whatever client you have, and drop it. In
a **developer checkout** that is the container's own `psql`:

```sh
docker compose exec -T postgres psql -U buddi -d buddi_drill -c \
  "select schemaname, relname, n_live_tup from pg_stat_user_tables order by 1,2"
docker compose exec -T postgres psql -U buddi -d postgres -c "drop database buddi_drill"
```

In a **packaged install** there is no container and no bundled `psql` — the
distribution is server-only — so use any Postgres client of your own against
`127.0.0.1:<the port in <data>/installation.json>`, user `buddi`, whose password
is in the vault under `BUDDI_DB_PASSWORD`. There is no Unix socket to connect
over.

Two things make this safe: `--into` never touches the database the archive names, and
the restore's own guard refuses a target with rows in it unless you both pass `--yes`
and type the name. `--into` restores the database only; add `--files` if you want the
directories too.

The same drill runs in CI-shaped form in
`packages/core/src/backup/backup.db.test.ts`: it builds throwaway databases with
real tables, rows, foreign keys and sequences, takes a real backup through the
same code path, verifies the archive, drops and recreates the database, restores,
and asserts the rows, the keys and the sequences came back — plus the refusals,
the encrypted-with-no-envelope case, and a file step that fails leaving the
target exactly at the pre-restore snapshot.
`packages/core/src/backup/rollback.db.test.ts` is the rollback half: a failed
restore must put an installed plugin's schema and its ledger row back, and a
schema this build owns that the archive never heard of must come back
empty-and-migrated rather than dropped. Both are skipped unless `DATABASE_URL`
is set.

## The nightly backup

**In a packaged install** the supervisor owns the schedule; there is no cron and
no launchd agent for it. The schedule lives in `<data>/backup.json` (mode `0600`)
as an enabled flag, a local `HH:MM`, how many to keep, whether to encrypt, and an
optional folder to copy to. The supervisor ticks once a minute, and the test is a
**calendar** one rather than an interval: a backup is due once the local clock has
crossed today's time and the last run was before it, so a laptop that was asleep
at 03:30 takes its backup the moment it wakes. The run is: take the archive with
the gateway still running, encrypt it, prune to `keep`, then copy it and its
envelope to the folder if one is set. A folder that cannot be written is *the copy
is late*, reported by doctor — never a failed backup. The last-run time is written
before the run, so a backup that crashes is not retried every minute, and a
backup is skipped entirely while a restore is in progress.

**In a developer checkout** it is an OS unit you install once:

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
large the newest is, and whether the schedule is installed. It reads only the
directory listing, so it still answers with the database down. It warns when there
is no backup at all, when the newest is older than 48 hours, or when backups exist
but nothing is scheduled to take the next one. It is never `fail` — an installation
with no backup works perfectly today, which is exactly why the warning must not be
one you learn to ignore.

## Keeping it up to date

New code is four separate things — install, build, migrate, restart — and
**a start migrates**. Whatever brings the gateway up runs core's migrations and
every installed plugin's first, and refuses to serve over a schema it could not
move: `migrateAtStart` in `packages/gateway/src/plugins/migrate.ts`, called by
`buddi serve` (`packages/gateway/src/serve.ts`) and by the packaged supervisor
(`packages/install/src/supervisor.ts`). `buddi migrate` is still there for the
owner who wants to migrate *without* starting.

So the migration is no longer the step you can silently skip. Two are:

| Skip | What you get |
| --- | --- |
| the build | the service keeps executing last month's code, and starts by migrating the schema to this month's |
| the restart | everything looks upgraded until the next reboot disagrees |

The order is a command rather than a paragraph:

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
   reads it. A plugin that fails to migrate is named by its schema. This is the
   same function a start runs, in the same order, so an upgrade that skipped it
   would be caught by step 5 anyway — it is explicit here so that a failure
   stops the upgrade rather than a restart.
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
| migrate | new code is built, the schema is partly migrated, **and the service is deliberately left down** | fix what the named migration is complaining about, then `buddi service start` — a start migrates, so it finishes the job and refuses to serve if it still cannot. `buddi migrate` first if you would rather see it separately |
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

### Mail search (migration 012)

The email plugin's `012_search.sql` is the one migration in this repo that
needs more than the schema it owns, so it is worth knowing about before an
upgrade rather than during one.

**It creates the `pg_trgm` extension.** That needs the CREATE privilege *on
the database*, not just on a schema. pg_trgm is a trusted extension
(PostgreSQL 13 and later), so superuser is not required — the role buddi
connects as is enough, provided it may create on the database. If the
migration stops with a privilege error, you have two ways out:

```
-- either, as a superuser or the database owner, once:
grant create on database buddi to buddi;

-- or, as a superuser, once — any schema will do, the migration finds it:
create extension pg_trgm;
```

then run `buddi migrate` again. The migration does **not** skip the extension
and carry on: a mail search that silently falls back to a full table scan on
one installation and not another is a worse thing to own than a migration that
refuses and says why.

**The two trigram indexes build under an exclusive lock on `email.messages`.**
Migrations run inside a transaction, so `create index concurrently` is not
available. On a new install this is instantaneous. On a mailbox with several
years of history it is seconds to a minute, and for that time the mail poller's
inserts wait. So on a large mailbox, stop the service first:

```
buddi service stop
buddi migrate
buddi service start
```

rather than meeting it as an ingest that appears to have hung.

## Retention

```
buddi backup prune            # keep the newest 14
buddi backup prune --keep 30
```

`--keep 0` is refused, not clamped: it reads like "delete every backup I have", and a
prune that does that on a typo is not a feature. Prune only ever deletes files whose
names match `buddi-backup-YYYYMMDD-HHMMSS.tar.gz` (with or without `.age`), together
with their envelopes; anything else in the directory is left alone, and a
`pre-restore-…` archive is never pruned at all.

## Off-machine copies

`<data>/backups` is on the same disk as the thing it is backing up, which protects
you from `docker compose down -v` and from a bad migration, but not from a dead disk or
a stolen laptop. Copy archives somewhere else — an external disk, a sync folder, another
machine. Settings → Backup will do it for you after every scheduled backup if you
give it a folder something else syncs (a Drive, Dropbox, iCloud or OneDrive client's
folder, a Syncthing share, a mounted disk); the same retention prunes there too.
By hand:

```
buddi backup create --encrypt --out /Volumes/backup/buddi
rsync -a ~/…/backups/ backup-host:buddi-backups/
```

**Encrypt anything that leaves the machine**, and the dashboard's folder target
does it for you: there is no way to send an unencrypted archive off the machine.
No credential travels with an archive either way — but your financial history
and your mail *are* in it, which is exactly what the passphrase is for. The
provider APIs (Google Drive, Dropbox) that would remove the desktop client from
this picture are not built; see [the roadmap](ROADMAP.md).
