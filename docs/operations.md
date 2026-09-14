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

Two things follow from the first row that are worth saying plainly:

- **The Docker volume is not yours to copy.** `docker compose down` leaves it alone,
  but `docker compose down -v` deletes it, and so does "Clean / Purge data" in Docker
  Desktop. A backup is a `pg_dump`, which survives all of that and can be restored
  into a different Postgres on a different machine.
- **`data/` and `private/` are gitignored.** They are not in your git history, and
  pushing the repo does not back them up.

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
`BUDDI_VAULT_KEY`. This is not an oversight and it is not configurable.

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
`buddi vault import-env` writes, which buddi reads as "ask the vault". A password
embedded in a non-secret URL (the one in `DATABASE_URL`) is replaced with `***`.
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
