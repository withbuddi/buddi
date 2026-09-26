---
title: "The buddi command line"
status: reference
updated: 2026-09-25
---

# The buddi command line

Every command, grouped the way `buddi help` groups them. The same words work in a
packaged install and in a source checkout; what does not apply where you run it is
left out of `buddi help`, and says what to do instead when typed. `buddi help <command>`
and `buddi <command> --help` print one command with an example and its exit codes.

This page is generated from the command table (`packages/cli/src/commands.ts`) by
`pnpm docs:cli`; a test fails when the two differ.

## Exit codes and output

- `0` done, `1` failed, `2` the command was not typed right, `3` it needs something
  first: the database is not reachable, the agent does not exist, an approval is
  waiting.
- Answers go to stdout and diagnostics to stderr. Colour only on a terminal, and
  never with `NO_COLOR` set.
- `--json` on the commands that read prints one object or one array with the
  fields listed below. `BUDDI_JSON=1` does the same, for a cron line; commands that
  change something ignore it.

## Everyday

What you type most days.

- `buddi`: Open the dashboard. In a packaged install the first run sets everything up.
- `buddi status [--json]`: One screen: version, service, database, agents, what needs you, and whether a newer buddi is out.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: { version, install, service: { state, detail }, database: { reachable, error? }, agents: { ready: [{ handle, id }], unavailable: [{ handle, id, reason }] }, needsYou: { approvals, questions } | null, lastRecapAt | null, update: { available, latest? } }. service.state is running, stopped, not-installed or unknown.
- `buddi ask "<question>" [--agent <handle>] [--resume <id> | --last] [--file <path>] [--wait <seconds>] [--json]`: Ask one question, print the answer, and exit. Made for scripts.
  - `--agent <handle>`: Ask this agent, by handle or id, instead of the default one.
  - `--resume <id>`: Continue that conversation. With no question, it finishes a run that stopped for an approval you have since given.
  - `--last`: Continue the most recent conversation with that agent.
  - `--file <path>`: Attach a file. It is kept in the library like a file dropped on the dashboard.
  - `--wait <seconds>`: When the run stops for an approval, wait this long for you to give it elsewhere, then finish.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: { text, runId, conversationId, artifacts: [{ id, filename }] }, plus pendingActionId when the run stopped for an approval. With no question as an argument and stdin not a terminal, stdin is the question.
- `buddi chat [--agent <handle>] [--resume <id> | --last] [--quiet]`: Talk with an agent in the terminal. /help inside lists what you can type.
  - `--agent <handle>`: Talk to this agent, by handle or id.
  - `--resume <id>`: Continue that conversation.
  - `--last`: Continue the most recent conversation with that agent.
  - `--quiet`: No footer after each answer.
- `buddi dashboard [--token | --off | --install-app | --uninstall-app]`: Open the dashboard with a sign-in link that is good for five minutes.
  - `--token`: Print only the five-minute ticket.
  - `--off`: Say how to turn the dashboard off.
  - `--install-app`: Put a double-clickable Buddi Dashboard in ~/Applications.
  - `--uninstall-app`: Remove it.

## Agents

Your agents, what they have scheduled, and the plugins they use.

- `buddi agents [list] [--json]`: List every agent, its engine, and whether it can run.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ handle, id, isDefault, provider, model, credential, available, unavailableReason?, roles, source }]
- `buddi agents show <handle> [--json]`: Show one agent in full: engine, tools, skills and its last run.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: { handle, id, name, description, isDefault, source, file, provider, model, accountId?, credential: { kind, env }, available, unavailableReason?, maxTurns, language, roles, tools, skills: [{ name, provenance }], capabilities, lastRun: { at, provider, model, servedModel?, turns, stopped, input, output } | null }
- `buddi agents set <handle> [--account <id>] [--model <id>] [--max-turns <n>] [--language mirror|en|fr]`: Change an agent's account, model, turn budget or language.
  - `--account <id>`: Run it on this provider account, from the dashboard's Providers page.
  - `--provider anthropic|openai`: Where its conversations go, on an agent without an account.
  - `--model <id>`: Checked against that provider's models.
  - `--max-turns <n>`: How many steps one run may take.
  - `--language mirror|en|fr`: Which language it answers in.
- `buddi agents models [--provider anthropic|openai] [--json]`: List the models this build knows, and which of them this machine can reach.
  - `--provider anthropic|openai`: Only that provider.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ kind, credentialEnv, credentialKind, usable, problem?, defaultModel, defaultFrom, defaultEnv, prefixes, models: [{ id, note }] }]
- `buddi agents test <handle> [--prompt "<text>"]`: Run one cheap live turn on an agent's provider, to prove it answers.
  - `--prompt "<text>"`: Ask this instead of the one-word default.
- `buddi agents migrate [--dry-run]`: Move agents/ and skills/ out of the checkout and into your private directory. Source checkout only.
  - `--dry-run`: Say what would move, and move nothing.
- `buddi missions list [--json]`: List every scheduled mission, its schedule, its next run and its last one.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ id, name, agentId, enabled, alwaysDeliver, proposedBy, schedule: { cron, timezone, revision, misfirePolicy } | null, nextRunAt | null, lastOccurrence: { scheduledAt, state, error } | null, lastNotification: { kind, at, reason?, chars? } | null }]
- `buddi missions add-defaults`: Register every mission the installed plugins suggest.
- `buddi missions add-recap`: Register the recap mission, or refresh it.
- `buddi missions add-friday-recap`: The same as buddi missions add-recap, under its older name.
- `buddi missions run-now <id> [--inline]`: Queue a run of a mission for now, or run it here with --inline.
  - `--inline`: Run it in this terminal and print what it would deliver.
- `buddi missions enable <id>`: Turn a mission back on.
- `buddi missions disable <id>`: Turn a mission off. Its schedule is kept.
- `buddi reminders [--agent <id>] [--all] [--json]`: List the one-off reminders the agents have set, soonest first.
  - `--agent <id>`: Only that agent's.
  - `--all`: Include the ones that fired, were cancelled or expired.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ id, state, dueAt, agentId, text, cancelReason? }]
- `buddi reminders cancel <id>`: Cancel a pending reminder.
- `buddi nudges [status]`: Say what the first-run arc has sent, and whether it is still running.
- `buddi nudges stop`: Stop the first-run arc until you ask for it back.
- `buddi nudges resume`: Start the first-run arc again.
- `buddi plugins list [--json]`: List what is installed, its version, and whether it is healthy.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ name, version, origin, health, detail }]. origin is built-in or installed; health is ok, warn or fail.
- `buddi plugins info <name>`: Show what a plugin is, what it brought, and what it proposes.
- `buddi plugins install <spec> [--yes --integrity <hash>] [--registry <url>]`: Stage a plugin and read what it claims, then approve it with --yes.
  - `--yes`: Approve it: import it, plan it, install it.
  - `--integrity <hash>`: The hash the staged card printed. A package from npm or a .tgz is never approved without it.
  - `--registry <url>`: Fetch from this npm registry.
- `buddi plugins update <name> [--version <v>] [--yes --integrity <hash>]`: Stage the next version of a plugin; --yes --integrity approves it.
  - `--version <v>`: This version instead of the newest.
  - `--yes`: Approve it.
  - `--integrity <hash>`: The hash the staged card printed.
- `buddi plugins staged`: List what is staged and waiting for you.
- `buddi plugins approve <id> [--integrity <hash>] [--acknowledge-drift]`: Approve a staged plugin by its staging id.
  - `--integrity <hash>`: The hash the staged card printed.
  - `--acknowledge-drift`: Approve it although what is on disk changed since it was staged.
- `buddi plugins reject <id>`: Delete a stage and everything it fetched.
- `buddi plugins uninstall <name> [--yes] [--detach-agents] [--purge --confirm <name>]`: Say what removing a plugin would do; --yes removes it and keeps its data.
  - `--yes`: Remove it. Its database schema is kept.
  - `--detach-agents`: Also take its tools out of the agents that were given them.
  - `--purge --confirm <name>`: Also drop its schema and everything in it. This cannot be undone.
- `buddi plugins init <name> [--dir <path>]`: Write a new plugin you can build and install.
  - `--dir <path>`: Write it here instead of ./<name>.
- `buddi plugins dev <dir>`: Watch a plugin's dist/ and restart buddi when it changes.

## Reach

The ways your agents reach you, and the ways you reach them.

- `buddi telegram pair`: Show a QR code and a link that pair a phone with your agents.
- `buddi telegram devices [--json]`: List every paired device.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: [{ id, surface, label, externalUserId, externalChatId, pairedAt, lastSeenAt }]
- `buddi telegram unpair <id>`: Unpair a device, so it can no longer reach your agents.
- `buddi mcp`: Run buddi as an MCP server over stdio, for Claude Code or any MCP client.

## Operate

Keeping buddi running: the service, upgrades, backups, secrets and the work queue.

- `buddi doctor`: Check every moving part and say what is wrong.
- `buddi upgrade [--no-backup]`: Back up, move to the new version, migrate, and restart.
  - `--no-backup`: In a source checkout, skip the archive it takes first. A packaged upgrade always takes one.
- `buddi version`: Print the version, with the commit in a source checkout.
- `buddi service status [--json]`: Say whether the background service is running.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.
- `buddi service start [--json]`: Start the background service.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.
- `buddi service stop [--json]`: Stop the background service. Running work finishes first.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.
- `buddi service restart [--json]`: Restart the background service, to load a change.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.
- `buddi service logs`: Follow the service's log. Ctrl-C stops following.
- `buddi service install`: Install the background service, started at login. Source checkout only.
- `buddi service uninstall`: Remove the background service. Your data stays. Source checkout only.
- `buddi backup create [--encrypt] [--out <dir>] [--no-artifacts] [--prune [n]]`: Write one archive of this installation: the database, your agents and skills, and your files.
  - `--encrypt`: Seal it with your backup passphrase from the vault. A packaged install always does.
  - `--out <dir>`: Write it here instead of the backups directory. Source checkout only.
  - `--no-artifacts`: Leave the files out. Source checkout only.
  - `--prune [n]`: Then keep only the newest n archives.
- `buddi backup list [--json]`: List every archive, newest first.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: { dir, archives: [{ name, bytes, at }] }, newest first; at is an ISO time.
- `buddi backup verify <archive> [--passphrase "<words>"]`: Check that an archive is whole and can be restored.
  - `--passphrase "<words>"`: For an encrypted archive from another machine.
- `buddi backup restore <archive> [--into <db>] [--files] [--yes] [--force] [--passphrase "<words>"]`: Put an archive back. It asks you to type a word first.
  - `--into <db>`: Restore the database only, into this one.
  - `--files`: Also restore agents, skills and files.
  - `--yes`: Do not ask.
  - `--force`: Restore over a database that has data in it.
  - `--passphrase "<words>"`: For an encrypted archive. Without it: the vault, then a prompt.
- `buddi backup prune [--keep <n>]`: Delete old archives and keep the newest ones.
  - `--keep <n>`: How many to keep.
- `buddi backup schedule [status | install | uninstall] [--keep <n>]`: The nightly backup at 03:30, prune included: status, install or uninstall. Source checkout only.
  - `--keep <n>`: How many archives the nightly prune keeps.
- `buddi vault set <NAME>`: Keep a secret in the vault. It asks for the value with the typing hidden.
- `buddi vault get <NAME>`: Print a secret from the vault.
- `buddi vault delete <NAME>`: Remove a secret from the vault.
- `buddi vault list`: List the names of the secrets in the vault, never their values.
- `buddi vault import-env`: Move the secrets in .env into the vault.
- `buddi browser [status]`: Say which browser the agents' own browser uses here.
- `buddi browser install`: Download Chromium for the agents' own browser, about 150 MB.
- `buddi jobs [--state <state>] [--kind <kind>] [--limit <n>] [--json]`: List the work queue: what is waiting, running and failed.
  - `--state <state>`: Only pending, leased, succeeded, failed, suspended or cancelled jobs.
  - `--kind <kind>`: Only jobs of this kind.
  - `--limit <n>`: At most n jobs. The default is 20.
  - `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.
  - JSON: { paused, counts: { pending, leased, succeeded, failed, suspended, cancelled }, jobs: [{ id, state, kind, attempts, maxAttempts, createdAt, runAfter, leaseOwner, suspendedReason, lastError }] }
- `buddi jobs retry <id> | --all [--kind <kind>] [--state <state>] [--limit <n>]`: Run a failed job again, or every failed job with --all.
  - `--all`: Every dead job, not one.
  - `--kind <kind>`: With --all: only jobs of this kind.
- `buddi jobs cancel <id>`: Cancel a job that has not run yet.
- `buddi pause`: Stop taking new work. What is running finishes.
- `buddi resume`: Start taking work again.

## Develop

Only in a source checkout. A packaged install does not list them.

- `buddi init [--yes]`: Set a source checkout up: .env, the database, the service. Safe to run again.
  - `--yes`: Ask nothing and take every default, for scripts and CI.
- `buddi db up`: Start the Postgres container of a source checkout.
- `buddi db down`: Stop the Postgres container.
- `buddi db status`: Say whether the Postgres container is running.
- `buddi db secure`: Give the database a generated password, kept in the vault.
- `buddi migrate`: Apply core's migrations and every installed plugin's.
- `buddi serve`: Run the gateway in this terminal instead of the service.
