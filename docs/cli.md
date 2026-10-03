---
title: "The buddi command line"
status: reference
updated: 2026-10-03
---

# The buddi command line

Every command, grouped the way `buddi help` groups them. The same words work in a
packaged install and in a source checkout; what does not apply where you run it is
left out of `buddi help`, and says what to do instead when typed. Each group lists its
commands, then gives each one its own section: usage, flags, an example, what it tells
you to do next, and its exit codes, the same words `buddi help <command>` and
`buddi <command> --help` print.

This page is generated from the command table (`packages/cli/src/commands.ts`) by
`pnpm docs:cli`; a test fails when the two differ.

## Common tasks

### Add a model account

Accounts are added on the dashboard: Settings → Model accounts → Add account (an API key,
a Claude or ChatGPT sign-in, or a model server on your network). Then put an agent on it
under Agents → the agent → Setup → Brain, or from a terminal:

```sh
buddi accounts
buddi agents set ledger --account <id>
buddi agents test ledger
```

[`buddi accounts`](#buddi-accounts) prints each account's id and whether it can run now (the account's page on the
dashboard shows the id too, with Copy); [`buddi agents set`](#buddi-agents-set) takes it, and [`buddi agents test`](#buddi-agents-test) runs one
cheap turn to prove the account answers.

### Change an agent's model or step budget

```sh
buddi agents models --provider anthropic
buddi agents set ledger --model claude-sonnet-5
buddi agents set ledger --max-turns 30
buddi service restart
```

[`buddi agents models`](#buddi-agents-models) lists the model ids this build knows. [`buddi agents set`](#buddi-agents-set) prints the change
and asks for a restart so the running service, Telegram and the scheduler pick it up;
`--max-turns` is how many steps one run may take.

### Back up and restore

```sh
buddi backup create --encrypt
buddi backup verify <archive>
buddi backup restore <archive> --files
```

[`buddi backup create`](#buddi-backup-create) prints the archive's path and the [`buddi backup verify`](#buddi-backup-verify) line to check it;
[`buddi backup list`](#buddi-backup-list) shows every archive. [`buddi backup restore`](#buddi-backup-restore) asks you to type a word first.
A packaged install always encrypts (the passphrase is in its vault), reads archives from
its own backups directory, and stops the gateway for the restore; then run `buddi doctor`
and open the dashboard, which opens in recovery. In a source checkout, `--files` also
puts back agents, skills and files, and `--force` restores over a database that has data.

### Pair Telegram

```sh
buddi vault set TELEGRAM_BOT_TOKEN
buddi service restart
buddi telegram pair
```

Ask @BotFather for a bot and keep its token with [`buddi vault set`](#buddi-vault-set), then restart so the service
starts the bot; pasting it in Settings → Telegram on the dashboard does both.
[`buddi telegram pair`](#buddi-telegram-pair) prints a QR code, a link and a code, good for ten minutes: open it on the phone
while the service runs. [`buddi telegram devices`](#buddi-telegram-devices) lists what is paired and [`buddi telegram unpair`](#buddi-telegram-unpair) removes one.

### Add a local connection

```sh
buddi connections add files -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
buddi connections add github-local --secret GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github
```

[`buddi connections add`](#buddi-connections-add) with `-- <command>` registers an MCP server that runs on this computer as you.
It starts the program once to read its tools, prints each with its tier, and asks to keep them
and which agents get them (`--keep` and `--to <agent,agent>` answer ahead). `--secret K` asks for a
value with the echo off and keeps it in the vault. The service must be running. [`buddi connections list`](#buddi-connections-list)
shows it; [`buddi connections remove`](#buddi-connections-remove) takes it away.

### Upgrade

```sh
buddi status
buddi upgrade
```

[`buddi status`](#buddi-status) says whether a newer buddi is out. In a packaged install [`buddi upgrade`](#buddi-upgrade) takes a backup,
installs the new version, migrates and restarts itself (`buddi upgrade <version>` picks one).
In a source checkout, `git pull` first: it upgrades the code on disk (backup, stop, install
and build, migrate, start, `buddi doctor`).

## What it is for

`buddi` runs your agents and keeps them running: it starts the service, checks on it,
backs it up and upgrades it. It is also a way to talk to your agents without the
dashboard, from a terminal or a script, and to pair the phone you reach them from.

## Examples

- `buddi status`: a few short sentences: the version, whether the service is running
  and the database reachable, which agents can run, what needs you, and whether a
  newer buddi is out.
- `buddi ask "Any reminder today?" --json`: one object with the answer in `text`, the
  `runId` and `conversationId`, and any files the run saved in `artifacts`.
- `buddi chat --agent @ledger`: a conversation in the terminal. It opens with the
  agent's name, the conversation id, its provider and model, and
  `/help for commands, /quit to leave`.
- `buddi backup create`: the path of the archive it wrote, its size and how long it
  took, what is inside, and the `buddi backup verify` line to check it.
- `buddi telegram pair`: a QR code, the link to open on the phone and a code, valid
  for ten minutes.

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

- [`buddi`](#buddi): Open the dashboard. In a packaged install the first run sets everything up.
- [`buddi status`](#buddi-status): One screen: version, service, database, agents, what needs you, and whether a newer buddi is out.
- [`buddi ask`](#buddi-ask): Ask one question, print the answer, and exit. Made for scripts.
- [`buddi chat`](#buddi-chat): Talk with an agent in the terminal. /help inside lists what you can type.
- [`buddi dashboard`](#buddi-dashboard): Open the dashboard with a sign-in link that is good for five minutes.

### buddi

Open the dashboard. In a packaged install the first run sets everything up.

```sh
buddi
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi status

One screen: version, service, database, agents, what needs you, and whether a newer buddi is out.

```sh
buddi status [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi status
```

**JSON**: { version, install, service: { state, detail }, database: { reachable, error? }, agents: { ready: [{ handle, id }], unavailable: [{ handle, id, reason }] }, needsYou: { approvals, questions, total } | null (total is the dashboard's Needs you count), lastRecapAt | null, update: { available, latest? }, ollama: [{ label, line }] }. service.state is running, stopped, not-installed or unknown.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable. The rest of the report is still printed.

### buddi ask

Ask one question, print the answer, and exit. Made for scripts.

```sh
buddi ask "<question>" [--agent <handle>] [--resume <id> | --last] [--file <path>] [--wait <seconds>] [--json]
```

**Flags**

- `--agent <handle>`: Ask this agent, by handle or id, instead of the default one.
- `--resume <id>`: Continue that conversation. With no question, it finishes a run that stopped for an approval you have since given.
- `--last`: Continue the most recent conversation with that agent.
- `--file <path>`: Attach a file. It is kept in the library like a file dropped on the dashboard.
- `--wait <seconds>`: When the run stops for an approval, wait this long for you to give it elsewhere, then finish.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi ask "what did I spend on food last month?" --agent ledger
```

**Then**: When the run stops for an approval: approve it on the dashboard or Telegram, then `buddi ask --resume <conversation id>` finishes it.

**JSON**: { text, runId, conversationId, artifacts: [{ id, filename }] }, plus pendingActionId when the run stopped for an approval. With no question as an argument and stdin not a terminal, stdin is the question.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The run stopped for an approval, the agent does not exist or cannot run, or the database is not reachable.

### buddi chat

Talk with an agent in the terminal. /help inside lists what you can type.

```sh
buddi chat [--agent <handle>] [--resume <id> | --last] [--quiet]
```

**Flags**

- `--agent <handle>`: Talk to this agent, by handle or id.
- `--resume <id>`: Continue that conversation.
- `--last`: Continue the most recent conversation with that agent.
- `--quiet`: No footer after each answer.

**Example**

```sh
buddi chat --agent ledger --last
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi dashboard

Open the dashboard with a sign-in link that is good for five minutes.

```sh
buddi dashboard [--token | --off | --install-app | --uninstall-app | --unlock | --remove-pin]
```

**Flags**

- `--token`: Print only the five-minute ticket.
- `--off`: Say how to turn the dashboard off.
- `--install-app`: Put a double-clickable Buddi Dashboard in ~/Applications.
- `--uninstall-app`: Remove it.
- `--unlock`: Forgot the lock screen PIN: open the dashboard past it once, with a five-minute link (and one for your other devices when the tailnet address is set).
- `--remove-pin`: Remove the lock screen PIN on every device. Set a new one in Settings → Lock screen.

**Example**

```sh
buddi dashboard --token
```

**Then**: With --off: put `BUDDI_WEB=0` in .env, then `buddi service restart`.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

## Agents

Your agents, what they have scheduled, and the plugins they use.

- [`buddi agents`](#buddi-agents): List every agent, its engine, and whether it can run.
- [`buddi agents show`](#buddi-agents-show): Show one agent in full: engine, tools, skills and its last run.
- [`buddi agents set`](#buddi-agents-set): Change an agent's account, model, step budget, language or when its chats start fresh.
- [`buddi accounts`](#buddi-accounts): List the model accounts: id, provider, default model, whether each can run now, and the agents on it.
- [`buddi accounts show`](#buddi-accounts-show): Show one model account in full: its address, default model, state, agents and last connection test.
- [`buddi agents models`](#buddi-agents-models): List the models this build knows, and which of them this machine can reach.
- [`buddi agents test`](#buddi-agents-test): Run one cheap live turn on an agent's provider, to prove it answers.
- [`buddi agents migrate`](#buddi-agents-migrate): Move agents/ and skills/ out of the checkout and into your private directory. Source checkout only.
- [`buddi agents catalogue`](#buddi-agents-catalogue): List the agent catalogue from withbuddi.com: each ready-made agent, and whether it is ready to add, needs something, or is already on your team.
- [`buddi agents add`](#buddi-agents-add): Add an agent from the catalogue: prints what it would install, its picks, its tools and its missions (off), then adds it on your yes. A missing by-buddi plugin is installed on the way.
- [`buddi agents update`](#buddi-agents-update): Update an agent added from the catalogue to the version listed now: prints the changes, the persona diff and any new tools, then updates it on your yes. An agent you edited is left alone unless you pass --replace.
- [`buddi agents remove`](#buddi-agents-remove): Remove an agent from your team: its directory goes to the trash and its missions are paused. Plugins stay installed.
- [`buddi missions list`](#buddi-missions-list): List every scheduled mission, its schedule, its next run and its last one.
- [`buddi missions add-defaults`](#buddi-missions-add-defaults): Register every mission the installed plugins suggest.
- [`buddi missions add-recap`](#buddi-missions-add-recap): Register the recap mission, or refresh it.
- [`buddi missions add-friday-recap`](#buddi-missions-add-friday-recap): The same as buddi missions add-recap, under its older name.
- [`buddi missions run-now`](#buddi-missions-run-now): Queue a run of a mission for now, or run it here with --inline.
- [`buddi missions enable`](#buddi-missions-enable): Turn a mission back on.
- [`buddi missions disable`](#buddi-missions-disable): Turn a mission off. Its schedule is kept.
- [`buddi reminders`](#buddi-reminders): List the one-off reminders the agents have set, soonest first.
- [`buddi reminders cancel`](#buddi-reminders-cancel): Cancel a pending reminder.
- [`buddi nudges`](#buddi-nudges): Say what the first-run arc has sent, and whether it is still running.
- [`buddi nudges stop`](#buddi-nudges-stop): Stop the first-run arc until you ask for it back.
- [`buddi nudges resume`](#buddi-nudges-resume): Start the first-run arc again.
- [`buddi plugins list`](#buddi-plugins-list): List what is installed, its version, and whether it is healthy.
- [`buddi plugins describe`](#buddi-plugins-describe): Stage a plugin, read its manifest, print what it brings, and delete the stage.
- [`buddi plugins info`](#buddi-plugins-info): Show what a plugin is, what it brought, and what it proposes.
- [`buddi plugins install`](#buddi-plugins-install): Stage a plugin and read what it claims, then approve it with --yes.
- [`buddi plugins update`](#buddi-plugins-update): Stage the next version of a plugin (a folder install is reread, the same version too); --yes --integrity approves it.
- [`buddi plugins staged`](#buddi-plugins-staged): List what is staged and waiting for you.
- [`buddi plugins approve`](#buddi-plugins-approve): Approve a staged plugin by its staging id.
- [`buddi plugins reject`](#buddi-plugins-reject): Delete a stage and everything it fetched.
- [`buddi plugins disable`](#buddi-plugins-disable): Turn a plugin off now without removing it: its tools, pages and watchers stop, its data stays, its missions pause.
- [`buddi plugins enable`](#buddi-plugins-enable): Turn a disabled plugin back on now and resume its missions.
- [`buddi plugins uninstall`](#buddi-plugins-uninstall): Say what removing a plugin would do; --yes removes it and keeps its data.
- [`buddi plugins init`](#buddi-plugins-init): Write a new plugin you can build and install.
- [`buddi plugins dev`](#buddi-plugins-dev): Watch a plugin's dist/ and restart buddi when it changes.
- [`buddi skills list`](#buddi-skills-list): List every skill, grouped as the Skills page groups them (yours, learned, from plugins, from the catalogue), with the agents that use each.
- [`buddi connections list`](#buddi-connections-list): List the connected services: their state, their tools, and the agents that hold them.
- [`buddi connections add`](#buddi-connections-add): Connect a service that speaks MCP: address, sign-in, review and give, as on the dashboard. GitHub signs in with a code you type on github.com. With -- <command>, a program on this computer that buddi starts as you.
- [`buddi connections review`](#buddi-connections-review): Print every tool a connection brings with its tier, and keep them with --keep.
- [`buddi connections give`](#buddi-connections-give): Give a connection's tools to agents: mcp.<name>.* on their tools line, as the dashboard writes it.
- [`buddi connections remove`](#buddi-connections-remove): Disconnect a service: its sign-in is deleted and its tools leave every agent.

### buddi agents

List every agent, its engine, and whether it can run.

```sh
buddi agents [list] [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi agents
```

**JSON**: [{ handle, id, isDefault, provider, model, credential, available, unavailableReason?, roles, source }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

**See also**: [`buddi agents show`](#buddi-agents-show), [`buddi agents set`](#buddi-agents-set), [`buddi agents models`](#buddi-agents-models), [`buddi agents test`](#buddi-agents-test), [`buddi agents migrate`](#buddi-agents-migrate), [`buddi agents catalogue`](#buddi-agents-catalogue), [`buddi agents add`](#buddi-agents-add), [`buddi agents update`](#buddi-agents-update), [`buddi agents remove`](#buddi-agents-remove)

### buddi agents show

Show one agent in full: engine, tools, skills and its last run.

```sh
buddi agents show <handle> [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi agents show ledger
```

**JSON**: { handle, id, name, description, isDefault, source, file, provider, model, accountId?, credential: { kind, env }, available, unavailableReason?, maxTurns, language, roles, tools, skills: [{ name, provenance }], capabilities, lastRun: { at, provider, model, servedModel?, turns, stopped, input, output } | null }

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: No agent has that handle or id.

### buddi agents set

Change an agent's account, model, step budget, language or when its chats start fresh.

```sh
buddi agents set <handle> [--account <id>] [--model <id>] [--max-turns <n>] [--language mirror|en|fr] [--idle-rollover 3h|1d|1w|never]
```

**Flags**

- `--account <id>`: Run it on this model account, added on the dashboard under Settings → Model accounts. buddi accounts prints every account with its id.
- `--provider anthropic|openai`: Where its conversations go, on an agent without an account.
- `--model <id>`: Checked against that provider's models.
- `--max-turns <n>`: How many steps one run may take.
- `--language mirror|en|fr`: Which language it answers in.
- `--idle-rollover 3h|1d|1w|never`: How long a chat may sit idle before your next message starts a fresh one.

**Example**

```sh
buddi agents set ledger --max-turns 20
```

**Then**: `buddi service restart`, so the running service, Telegram and the scheduler load the change; then `buddi agents test <handle>` to check it.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: No agent has that handle or id.

### buddi accounts

List the model accounts: id, provider, default model, whether each can run now, and the agents on it.

```sh
buddi accounts [list] [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi accounts
```

**Then**: To put an agent on one: `buddi agents set <handle> --account <id>`.

**JSON**: [{ id, label, kind, provider, auth, defaultModel, enabled, configured, state, rateLimit: { scope, until, limit, unit, freeTier, provider, model } | null, agents: [{ id, handle, model }] }]. state is ready, rate-limited, needs-credential, needs-sign-in or disabled; rateLimit is set only while rate-limited, and scope is day (a daily quota used up) or burst. Never a key or a token.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

**See also**: [`buddi accounts show`](#buddi-accounts-show)

### buddi accounts show

Show one model account in full: its address, default model, state, agents and last connection test.

```sh
buddi accounts show <id> [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi accounts show 6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10
```

**Then**: To put an agent on it: `buddi agents set <handle> --account <id>`.

**JSON**: The fields of buddi accounts list, plus { baseUrl, contextWindowTokens, detectedContextWindowTokens, test: { state, message, checkedAt } | null }. The account may be named by its id or its label.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: No account has that id or label, or the database is not reachable.

### buddi agents models

List the models this build knows, and which of them this machine can reach.

```sh
buddi agents models [--provider anthropic|openai] [--json]
```

**Flags**

- `--provider anthropic|openai`: Only that provider.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi agents models --provider anthropic
```

**JSON**: [{ kind, credentialEnv, credentialKind, usable, problem?, defaultModel, defaultFrom, defaultEnv, prefixes, models: [{ id, note }] }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi agents test

Run one cheap live turn on an agent's provider, to prove it answers.

```sh
buddi agents test <handle> [--prompt "<text>"]
```

**Flags**

- `--prompt "<text>"`: Ask this instead of the one-word default.

**Example**

```sh
buddi agents test ledger
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: No agent has that handle or id.

### buddi agents migrate

Move agents/ and skills/ out of the checkout and into your private directory. Source checkout only.

buddi agents migrate is for a source checkout. A packaged install keeps its agents in its data directory already.

```sh
buddi agents migrate [--dry-run]
```

**Flags**

- `--dry-run`: Say what would move, and move nothing.

**Example**

```sh
buddi agents migrate --dry-run
```

**Then**: `buddi service restart`, so the service reloads the files from their new place.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi agents catalogue

List the agent catalogue from withbuddi.com: each ready-made agent, and whether it is ready to add, needs something, or is already on your team.

```sh
buddi agents catalogue [--refresh] [--json]
```

**Flags**

- `--refresh`: Ask withbuddi.com again instead of the copy kept for an hour.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi agents catalogue
```

**Then**: Add one: `buddi agents add <name>`.

**JSON**: { fetchedAt, stale?, agents: [{ name, version, handle, title, pitch, category, state, addable, missing?, installed?: { agentId, handle, version, drift, via? }, tools, missions, fills, examples, … }], fromPlugins: [{ plugin, agent, handle, name, state }], delisted, unavailable? }

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running, or the catalogue could not be fetched and no copy was kept.

### buddi agents add

Add an agent from the catalogue: prints what it would install, its picks, its tools and its missions (off), then adds it on your yes. A missing by-buddi plugin is installed on the way.

```sh
buddi agents add <name> [--fill <pick>=<answer>]... [--mission <id>]... [--handle <handle>] [--yes]
```

**Flags**

- `--fill <pick>=<answer>`: Answer one of its picks (a mailbox, calendars, a place, a mission hour as HH:MM, or a line of text). Each pick left out takes its default.
- `--mission <id>`: Turn this mission on from the start. Every other mission arrives off.
- `--handle <handle>`: Another handle than the package's own (a free one beside it is picked when that is taken).
- `--yes`: Approve it without asking. Without a terminal and without --yes, the plan is printed and nothing changes.

**Example**

```sh
buddi agents add chef --fill "diet=no pork" --yes
```

**Exit codes**

- `0`: Done.
- `1`: Something it needs is missing, or the install failed; the reason is printed.
- `2`: The command was not typed right.
- `3`: buddi is not running, or the catalogue lists no agent of that name.

### buddi agents update

Update an agent added from the catalogue to the version listed now: prints the changes, the persona diff and any new tools, then updates it on your yes. An agent you edited is left alone unless you pass --replace.

```sh
buddi agents update <handle> [--replace] [--yes]
```

**Flags**

- `--replace`: You changed its file: replace your changes with the catalogue's. Your file goes to the trash first.
- `--yes`: Approve it without asking.

**Example**

```sh
buddi agents update chef
```

**Exit codes**

- `0`: Done.
- `1`: It is already up to date, or the update was refused; the reason is printed.
- `2`: The command was not typed right.
- `3`: buddi is not running, or that agent did not come from the catalogue.

### buddi agents remove

Remove an agent from your team: its directory goes to the trash and its missions are paused. Plugins stay installed.

```sh
buddi agents remove <handle> [--yes]
```

**Flags**

- `--yes`: Approve it without asking.

**Example**

```sh
buddi agents remove chef
```

**Exit codes**

- `0`: Done.
- `1`: It was refused (the default agent, a shipped example); the reason is printed.
- `2`: The command was not typed right.
- `3`: buddi is not running.

### buddi missions list

List every scheduled mission, its schedule, its next run and its last one.

```sh
buddi missions list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi missions list
```

**JSON**: [{ id, name, agentId, enabled, alwaysDeliver, proposedBy, schedule: { cron, timezone, revision, misfirePolicy } | null, nextRunAt | null, lastOccurrence: { scheduledAt, state, error } | null, lastNotification: { kind, at, reason?, chars? } | null }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions add-defaults

Register every mission the installed plugins suggest.

```sh
buddi missions add-defaults
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions add-recap

Register the recap mission, or refresh it.

```sh
buddi missions add-recap
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions add-friday-recap

The same as buddi missions add-recap, under its older name.

```sh
buddi missions add-friday-recap
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions run-now

Queue a run of a mission for now, or run it here with --inline.

```sh
buddi missions run-now <id> [--inline]
```

**Flags**

- `--inline`: Run it in this terminal and print what it would deliver.

**Example**

```sh
buddi missions run-now recap --inline
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions enable

Turn a mission back on.

```sh
buddi missions enable <id>
```

**Example**

```sh
buddi missions enable recap
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi missions disable

Turn a mission off. Its schedule is kept.

```sh
buddi missions disable <id>
```

**Example**

```sh
buddi missions disable recap
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi reminders

List the one-off reminders the agents have set, soonest first.

```sh
buddi reminders [--agent <id>] [--all] [--json]
```

**Flags**

- `--agent <id>`: Only that agent's.
- `--all`: Include the ones that fired, were cancelled or expired.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi reminders --all
```

**JSON**: [{ id, state, dueAt, agentId, text, cancelReason? }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

**See also**: [`buddi reminders cancel`](#buddi-reminders-cancel)

### buddi reminders cancel

Cancel a pending reminder.

```sh
buddi reminders cancel <id>
```

**Example**

```sh
buddi reminders cancel 3f2a9c1e
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi nudges

Say what the first-run arc has sent, and whether it is still running.

```sh
buddi nudges [status]
```

**Example**

```sh
buddi nudges
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

**See also**: [`buddi nudges stop`](#buddi-nudges-stop), [`buddi nudges resume`](#buddi-nudges-resume)

### buddi nudges stop

Stop the first-run arc until you ask for it back.

```sh
buddi nudges stop
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi nudges resume

Start the first-run arc again.

```sh
buddi nudges resume
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi plugins list

List what is installed, its version, and whether it is healthy.

```sh
buddi plugins list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi plugins list
```

**JSON**: [{ name, version, installedAs?, origin, health, detail }]. origin is built-in or installed; health is ok, warn, fail or off. For a plugin installed from a folder, version is the folder's package.json now and installedAs the version recorded at install, when they differ.

**Exit codes**

- `0`: Done.
- `1`: An installed plugin did not load. The rest of the list is still printed.
- `2`: The command was not typed right.

### buddi plugins describe

Stage a plugin, read its manifest, print what it brings, and delete the stage.

```sh
buddi plugins describe <spec> [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi plugins describe @withbuddi/plugin-weather@0.1.1 --json
```

**JSON**: { package, claims, manifest, drift }: what the package says, what its manifest declares (tools with tiers, schema, hosts, timers, agents), and where the two differ. Nothing is installed.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins info

Show what a plugin is, what it brought, and what it proposes.

```sh
buddi plugins info <name>
```

**Example**

```sh
buddi plugins info finance
```

**Exit codes**

- `0`: Done.
- `1`: No plugin has that name here, or it did not load.
- `2`: The command was not typed right.

### buddi plugins install

Stage a plugin and read what it claims, then approve it with --yes.

```sh
buddi plugins install <spec> [--yes --integrity <hash>] [--registry <url>]
```

**Flags**

- `--yes`: Approve it: import it, plan it, install it.
- `--integrity <hash>`: The hash the staged card printed. A package from npm or a .tgz is never approved without it.
- `--registry <url>`: Fetch from this npm registry.

**Example**

```sh
buddi plugins install @you/buddi-plugin-finance
```

**Then**: Without --yes: `buddi plugins approve <id> --integrity <hash>` (a folder needs no hash). Once it is installed: `buddi service restart`, which registers its tools.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: --yes came without --integrity for a package from npm or a .tgz: staged, not installed. Without --yes it stages and exits 0.

### buddi plugins update

Stage the next version of a plugin (a folder install is reread, the same version too); --yes --integrity approves it.

```sh
buddi plugins update <name> [--version <v>] [--yes --integrity <hash>]
```

**Flags**

- `--version <v>`: This version instead of the newest.
- `--yes`: Approve it.
- `--integrity <hash>`: The hash the staged card printed.

**Example**

```sh
buddi plugins update weather
```

**Then**: Without --yes: `buddi plugins approve <id> --integrity <hash>`. Once it is installed: `buddi service restart`, which loads the new version.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: --yes came without --integrity: staged, not installed.

### buddi plugins staged

List what is staged and waiting for you.

```sh
buddi plugins staged
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins approve

Approve a staged plugin by its staging id.

```sh
buddi plugins approve <id> [--integrity <hash>] [--acknowledge-drift]
```

**Flags**

- `--integrity <hash>`: The hash the staged card printed.
- `--acknowledge-drift`: Approve it although what is on disk changed since it was staged.

**Example**

```sh
buddi plugins approve 7c1e2a90
```

**Then**: `buddi service restart`, which registers its tools. When its files changed since it was staged: `buddi plugins approve <id> --acknowledge-drift`.

**Exit codes**

- `0`: Done.
- `1`: Its files changed since it was staged: nothing was installed. --acknowledge-drift approves it anyway.
- `2`: The command was not typed right.

### buddi plugins reject

Delete a stage and everything it fetched.

```sh
buddi plugins reject <id>
```

**Example**

```sh
buddi plugins reject 7c1e2a90
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins disable

Turn a plugin off now without removing it: its tools, pages and watchers stop, its data stays, its missions pause.

```sh
buddi plugins disable <name>
```

**Example**

```sh
buddi plugins disable finance
```

**Then**: When the running buddi could not take the change: `buddi service restart`.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins enable

Turn a disabled plugin back on now and resume its missions.

```sh
buddi plugins enable <name>
```

**Example**

```sh
buddi plugins enable finance
```

**Then**: When the running buddi could not take the change: `buddi service restart`.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins uninstall

Say what removing a plugin would do; --yes removes it and keeps its data.

```sh
buddi plugins uninstall <name> [--yes] [--detach-agents] [--purge --confirm <name>]
```

**Flags**

- `--yes`: Remove it. Its database schema is kept.
- `--detach-agents`: Also take its tools out of the agents that were given them.
- `--purge --confirm <name>`: Also drop its schema and everything in it. This cannot be undone.

**Example**

```sh
buddi plugins uninstall weather --yes
```

**Then**: With --yes: `buddi service restart`, so no running process keeps registering its tools.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins init

Write a new plugin you can build and install.

```sh
buddi plugins init <name> [--dir <path>] [--license <spdx>] [--author <name>]
```

**Flags**

- `--dir <path>`: Write it here instead of ./<name>.
- `--license <spdx>`: The license it carries. Apache-2.0 unless you name another.
- `--author <name>`: Who made it, shown on the install card. Asked otherwise, with git config user.name as the default.

**Example**

```sh
buddi plugins init weather
```

**Then**: `cd <name>`, `pnpm install && pnpm build && pnpm test`, `buddi plugins install . --yes`, then `buddi service restart`.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi plugins dev

Watch a plugin's dist/ and restart buddi when it changes.

```sh
buddi plugins dev <dir>
```

**Example**

```sh
buddi plugins dev ./weather
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi skills list

List every skill, grouped as the Skills page groups them (yours, learned, from plugins, from the catalogue), with the agents that use each.

```sh
buddi skills list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi skills list
```

**JSON**: [{ id, name, title, description, group, file, home, every, holders: [{ agent, how }], untrusted, provenance, source, learned, from, editable, deletable, shareable }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running: these commands go through the running gateway.

### buddi connections list

List the connected services: their state, their tools, and the agents that hold them.

```sh
buddi connections list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi connections list
```

**JSON**: [{ id, name, slug, state, host, url, signedIn, tools, heldTools, agents: [id] }]. state is connected, pending-review, needs-review, needs-reconnect or unreachable.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running: these commands go through the running gateway.

### buddi connections add

Connect a service that speaks MCP: address, sign-in, review and give, as on the dashboard. GitHub signs in with a code you type on github.com. With -- <command>, a program on this computer that buddi starts as you.

```sh
buddi connections add <card|https://url> [--name <name>] [--token | --token-stdin | --client-id <id>] [--json '<mcpServers json>'] [--keep] [--slug <slug>] [--to <agent,agent>]  |  buddi connections add <name> [--env K=V]... [--secret K]... -- <command> <args...>
```

**Flags**

- `--name <name>`: What the connection is called on the dashboard.
- `--token`: Sign in with a token you made on the service's site, typed with the echo off, instead of a code. buddi tries it before it keeps it.
- `--token-stdin`: The same, with the token piped on stdin.
- `--client-id <id>`: Sign in with a client id from an app you created in the service's developer settings.
- `--json '<mcpServers json>'`: The block another MCP client takes: the address, the name and a header token, or a program's command, args and env (a placeholder value is asked for).
- `--env K=V`: A program's environment variable, as written. Repeat it for more.
- `--secret K`: A program's secret variable: its value is asked for with the echo off (one line each on stdin without a terminal) and kept in the vault. Repeat it for more.
- `-- <command> <args...>`: The program that starts the server, and its arguments, exactly as its docs give them. It is first run by the review, only to list its tools.
- `--keep`: Keep the tools without asking once they are printed.
- `--slug <slug>`: The connection's name in buddi, which every tool carries: mcp.<slug>.<tool>.
- `--to <agent,agent>`: Give the tools to these agents without asking. --to nobody keeps the connection waiting.

**Example**

```sh
buddi connections add github --to buddi
```

**Then**: When the tools were not kept: `buddi connections review <name> --keep` once you have read them.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: Not typed right, or no card has that name.
- `3`: buddi is not running: these commands go through the running gateway.

### buddi connections review

Print every tool a connection brings with its tier, and keep them with --keep.

```sh
buddi connections review <name> [--keep] [--slug <slug>] [--json]
```

**Flags**

- `--keep`: Keep the list as printed.
- `--slug <slug>`: Its name in buddi, on the first review only.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi connections review github
```

**Then**: Without --keep: `buddi connections review <name> --keep` once you have read them.

**JSON**: { connection, slug, slugEditable, host, hash, tools: [{ name, fullName, description, tier, destructive, annotated, problem, change }], annotatedNothing, changes }. tier is auto or gated.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running: these commands go through the running gateway.

### buddi connections give

Give a connection's tools to agents: mcp.<name>.* on their tools line, as the dashboard writes it.

```sh
buddi connections give <name> --to <agent,agent>
```

**Flags**

- `--to <agent,agent>`: The agents, by handle or id.

**Example**

```sh
buddi connections give github --to buddi,ledger
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running: these commands go through the running gateway.

### buddi connections remove

Disconnect a service: its sign-in is deleted and its tools leave every agent.

```sh
buddi connections remove <name> [--yes]
```

**Flags**

- `--yes`: Do not ask first.

**Example**

```sh
buddi connections remove github --yes
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: buddi is not running: these commands go through the running gateway.

## Reach

The ways your agents reach you, and the ways you reach them.

- [`buddi telegram pair`](#buddi-telegram-pair): Show a QR code and a link that pair a phone with your agents.
- [`buddi telegram devices`](#buddi-telegram-devices): List every paired device.
- [`buddi telegram unpair`](#buddi-telegram-unpair): Unpair a device, so it can no longer reach your agents.
- [`buddi mcp`](#buddi-mcp): Run buddi as an MCP server over stdio, for Claude Code or any MCP client.

### buddi telegram pair

Show a QR code and a link that pair a phone with your agents.

```sh
buddi telegram pair
```

**Then**: Scan the code or open the link on the phone within ten minutes. The service must be running to receive it.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or no Telegram bot is configured.

### buddi telegram devices

List every paired device.

```sh
buddi telegram devices [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi telegram devices
```

**Then**: With no device paired: `buddi telegram pair`.

**JSON**: [{ id, surface, label, externalUserId, externalChatId, pairedAt, lastSeenAt }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi telegram unpair

Unpair a device, so it can no longer reach your agents.

```sh
buddi telegram unpair <id>
```

**Example**

```sh
buddi telegram unpair 12
```

**Exit codes**

- `0`: Done.
- `1`: No paired device has that id.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi mcp

Run buddi as an MCP server over stdio, for Claude Code or any MCP client.

```sh
buddi mcp
```

**Example**

```sh
claude mcp add buddi -- buddi mcp
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

## Operate

Keeping buddi running: the service, upgrades, backups, secrets and the work queue.

- [`buddi doctor`](#buddi-doctor): Check every moving part and say what is wrong. `buddi doctor browser`: where agents may look and the last week of browser stops by cause.
- [`buddi upgrade`](#buddi-upgrade): Back up, move to the new version, migrate, and restart.
- [`buddi version`](#buddi-version): Print the version, with the commit in a source checkout.
- [`buddi service status`](#buddi-service-status): Say whether the background service is running.
- [`buddi service start`](#buddi-service-start): Start the background service.
- [`buddi service stop`](#buddi-service-stop): Stop the background service. Running work finishes first.
- [`buddi service restart`](#buddi-service-restart): Restart the background service, to load a change.
- [`buddi service logs`](#buddi-service-logs): Follow the service's log. Ctrl-C stops following.
- [`buddi service install`](#buddi-service-install): Install the background service, started at login. Source checkout only.
- [`buddi service uninstall`](#buddi-service-uninstall): Remove the background service. Your data stays. Source checkout only.
- [`buddi uninstall`](#buddi-uninstall): Remove buddi from this machine: the service, the data, the secrets. It lists everything first and asks.
- [`buddi backup create`](#buddi-backup-create): Write one archive of this installation: the database, your agents and skills, and your files.
- [`buddi backup list`](#buddi-backup-list): List every archive, newest first.
- [`buddi backup verify`](#buddi-backup-verify): Check that an archive is whole and can be restored.
- [`buddi backup restore`](#buddi-backup-restore): Put an archive back. It asks you to type a word first.
- [`buddi backup prune`](#buddi-backup-prune): Delete old archives and keep the newest ones.
- [`buddi backup schedule`](#buddi-backup-schedule): The nightly backup at 03:30, prune included: status, install or uninstall. Source checkout only.
- [`buddi vault set`](#buddi-vault-set): Keep a secret in the vault. It asks for the value with the typing hidden.
- [`buddi vault get`](#buddi-vault-get): Say whether a secret is in the vault. It never prints the value.
- [`buddi vault delete`](#buddi-vault-delete): Remove a secret from the vault.
- [`buddi vault list`](#buddi-vault-list): List the names of the secrets in the vault, never their values.
- [`buddi vault import-env`](#buddi-vault-import-env): Move the secrets in .env into the vault.
- [`buddi browser`](#buddi-browser): Say which browser the agents' own browser uses here.
- [`buddi browser install`](#buddi-browser-install): Download Chromium for the agents' own browser, about 150 MB.
- [`buddi speech`](#buddi-speech): Say which local speech models are downloaded, and their size.
- [`buddi speech install`](#buddi-speech-install): Download Whisper (252 MB) and Kokoro (92 MB), or one of them, so listening and speaking run on this computer.
- [`buddi jobs`](#buddi-jobs): List the work queue: what is waiting, running and failed. Failed jobs say whether they were dismissed; `--state failed` also groups them by cause.
- [`buddi jobs retry`](#buddi-jobs-retry): Run a failed job again, or every failed job with --all.
- [`buddi jobs dismiss`](#buddi-jobs-dismiss): Dismiss a failed job, or every failed job with --all: it stays on record but leaves the "failed" count. Failed jobs older than 14 days are dismissed on their own.
- [`buddi jobs cancel`](#buddi-jobs-cancel): Cancel a job that has not run yet.
- [`buddi api-token create`](#buddi-api-token-create): Make an owner API token, for calling the HTTP API from a script or another program. Printed once.
- [`buddi api-token list`](#buddi-api-token-list): List the API tokens: id, name, last four characters, when made and last used. Never the token.
- [`buddi api-token revoke`](#buddi-api-token-revoke): Revoke an API token: a request carrying it is refused from the next one on.
- [`buddi pause`](#buddi-pause): Stop taking new work. What is running finishes.
- [`buddi resume`](#buddi-resume): Start taking work again.

### buddi doctor

Check every moving part and say what is wrong. `buddi doctor browser`: where agents may look and the last week of browser stops by cause.

```sh
buddi doctor [browser]
```

**Example**

```sh
buddi doctor
```

**Exit codes**

- `0`: Done.
- `1`: A critical check failed. Warnings alone exit 0.
- `2`: The command was not typed right.

### buddi upgrade

Back up, move to the new version, migrate, and restart.

```sh
buddi upgrade [<version>] [--no-backup]
```

**Flags**

- `<version>`: In a packaged install, move to this version instead of the newest.
- `--no-backup`: In a source checkout, skip the archive it takes first. A packaged upgrade always takes one.

**Example**

```sh
buddi upgrade
```

**Then**: When it fails: `buddi doctor`, which says what is wrong and, in a packaged install, which archive to restore from and how.

**Exit codes**

- `0`: Done.
- `1`: A step failed, or buddi doctor found something afterwards. The backup taken first is kept.
- `2`: The command was not typed right.

### buddi version

Print the version, with the commit in a source checkout.

```sh
buddi version
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service status

Say whether the background service is running.

```sh
buddi service status [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi service status
```

**JSON**: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.

**Exit codes**

- `0`: Done.
- `1`: It is not running.
- `2`: The command was not typed right.

### buddi service start

Start the background service.

```sh
buddi service start [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi service start
```

**JSON**: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service stop

Stop the background service. Running work finishes first.

```sh
buddi service stop [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi service stop
```

**JSON**: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service restart

Restart the background service, to load a change.

```sh
buddi service restart [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi service restart
```

**JSON**: The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. Source checkout: { installed, running, pid?, unitPath, detail }.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service logs

Follow the service's log. Ctrl-C stops following.

```sh
buddi service logs
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service install

Install the background service, started at login. Source checkout only.

buddi service install is for a source checkout. A packaged install sets up its service the first time you run buddi.

```sh
buddi service install
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi service uninstall

Remove the background service. Your data stays. Source checkout only.

buddi service uninstall is for a source checkout. A packaged install stops with buddi service stop, and buddi uninstall removes it.

```sh
buddi service uninstall
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi uninstall

Remove buddi from this machine: the service, the data, the secrets. It lists everything first and asks.

```sh
buddi uninstall [--yes] [--keep-data] [--no-backup]
```

**Flags**

- `--yes`: Do not ask.
- `--keep-data`: Keep the data directory and the secrets that open it, for a reinstall.
- `--no-backup`: Skip the last backup it takes first.

**Example**

```sh
buddi uninstall
```

**Exit codes**

- `0`: Done.
- `1`: Something listed could not be removed, or nothing was: the question was not answered yes, the backup failed, or the data directory is not an installation.
- `2`: The command was not typed right.

### buddi backup create

Write one archive of this installation: the database, your agents and skills, and your files.

```sh
buddi backup create [--encrypt] [--out <dir>] [--no-artifacts] [--prune [n]]
```

**Flags**

- `--encrypt`: Seal it with your backup passphrase from the vault. A packaged install always does.
- `--out <dir>`: Write it here instead of the backups directory. Source checkout only.
- `--no-artifacts`: Leave the files out. Source checkout only.
- `--prune [n]`: Then keep only the newest n archives.

**Example**

```sh
buddi backup create --encrypt
```

**Then**: `buddi backup verify <archive>`, to check what it wrote.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi backup list

List every archive, newest first.

```sh
buddi backup list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi backup list
```

**JSON**: { dir, archives: [{ name, bytes, at }] }, newest first; at is an ISO time.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi backup verify

Check that an archive is whole and can be restored.

```sh
buddi backup verify <archive> [--passphrase "<words>"]
```

**Flags**

- `--passphrase "<words>"`: For an encrypted archive from another machine.

**Example**

```sh
buddi backup verify buddi-backup-20260914-033000.tar.gz.age
```

**Exit codes**

- `0`: Done.
- `1`: The archive is not there, or is not whole: do not rely on it.
- `2`: The command was not typed right.

### buddi backup restore

Put an archive back. It asks you to type a word first.

```sh
buddi backup restore <archive> [--into <db>] [--files] [--yes] [--force] [--passphrase "<words>"]
```

**Flags**

- `--into <db>`: Restore the database only, into this one.
- `--files`: Also restore agents, skills and files.
- `--yes`: Do not ask.
- `--force`: Restore over a database that has data in it.
- `--passphrase "<words>"`: For an encrypted archive. Without it: the vault, then a prompt.

**Example**

```sh
buddi backup restore buddi-backup-20260914-033000.tar.gz.age --files
```

**Then**: Packaged: `buddi doctor`, then open the dashboard, which opens in recovery. Source checkout: it lists what to do in order, ending with `buddi doctor` and `buddi service restart`.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi backup prune

Delete old archives and keep the newest ones.

```sh
buddi backup prune [--keep <n>]
```

**Flags**

- `--keep <n>`: How many to keep.

**Example**

```sh
buddi backup prune --keep 7
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi backup schedule

The nightly backup at 03:30, prune included: status, install or uninstall. Source checkout only.

buddi backup schedule is for a source checkout. A packaged install sets its nightly backup on the dashboard, in Settings → Backup.

```sh
buddi backup schedule [status | install | uninstall] [--keep <n>]
```

**Flags**

- `--keep <n>`: How many archives the nightly prune keeps.

**Example**

```sh
buddi backup schedule install
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi vault set

Keep a secret in the vault. It asks for the value with the typing hidden.

```sh
buddi vault set <NAME>
```

**Example**

```sh
buddi vault set TAVILY_API_KEY
```

**Exit codes**

- `0`: Done.
- `1`: The vault is locked or not usable, or nothing was typed.
- `2`: The command was not typed right.

### buddi vault get

Say whether a secret is in the vault. It never prints the value.

```sh
buddi vault get <NAME>
```

**Example**

```sh
buddi vault get TAVILY_API_KEY
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi vault delete

Remove a secret from the vault.

```sh
buddi vault delete <NAME>
```

**Example**

```sh
buddi vault delete TAVILY_API_KEY
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi vault list

List the names of the secrets in the vault, never their values.

```sh
buddi vault list
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi vault import-env

Move the secrets in .env into the vault.

```sh
buddi vault import-env
```

**Then**: `buddi service restart`, so the running process reads the secrets from the vault.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi browser

Say which browser the agents' own browser uses here.

```sh
buddi browser [status]
```

**Example**

```sh
buddi browser
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

**See also**: [`buddi browser install`](#buddi-browser-install)

### buddi browser install

Download Chromium for the agents' own browser, about 150 MB.

```sh
buddi browser install
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi speech

Say which local speech models are downloaded, and their size.

```sh
buddi speech [status]
```

**Example**

```sh
buddi speech
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

**See also**: [`buddi speech install`](#buddi-speech-install)

### buddi speech install

Download Whisper (252 MB) and Kokoro (92 MB), or one of them, so listening and speaking run on this computer.

```sh
buddi speech install [whisper|kokoro]
```

**Example**

```sh
buddi speech install kokoro
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi jobs

List the work queue: what is waiting, running and failed. Failed jobs say whether they were dismissed; `--state failed` also groups them by cause.

```sh
buddi jobs [--state <state>] [--kind <kind>] [--limit <n>] [--json]
```

**Flags**

- `--state <state>`: Only pending, leased, succeeded, failed, suspended or cancelled jobs.
- `--kind <kind>`: Only jobs of this kind.
- `--limit <n>`: At most n jobs. The default is 20.
- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi jobs --state failed
```

**JSON**: { paused, counts: { pending, leased, succeeded, failed, suspended, cancelled, dismissed }, jobs: [{ id, state, kind, attempts, maxAttempts, createdAt, runAfter, leaseOwner, suspendedReason, lastError, acknowledgedAt, acknowledgedBy }] }

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

**See also**: [`buddi jobs retry`](#buddi-jobs-retry), [`buddi jobs dismiss`](#buddi-jobs-dismiss), [`buddi jobs cancel`](#buddi-jobs-cancel)

### buddi jobs retry

Run a failed job again, or every failed job with --all.

```sh
buddi jobs retry <id> | --all [--kind <kind>] [--state <state>] [--limit <n>]
```

**Flags**

- `--all`: Every dead job, not one.
- `--kind <kind>`: With --all: only jobs of this kind.

**Example**

```sh
buddi jobs retry --all --kind mission-run
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi jobs dismiss

Dismiss a failed job, or every failed job with --all: it stays on record but leaves the "failed" count. Failed jobs older than 14 days are dismissed on their own.

```sh
buddi jobs dismiss <id> | --all
```

**Flags**

- `--all`: Every failed job still counted, not one.

**Example**

```sh
buddi jobs dismiss --all
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi jobs cancel

Cancel a job that has not run yet.

```sh
buddi jobs cancel <id>
```

**Example**

```sh
buddi jobs cancel 1234
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi api-token create

Make an owner API token, for calling the HTTP API from a script or another program. Printed once.

```sh
buddi api-token create <name>
```

**Example**

```sh
buddi api-token create "home automation"
```

**Then**: The token alone is printed on stdout (the note on stderr), so `TOKEN=$(buddi api-token create cron)` keeps it. Send it as `Authorization: Bearer <token>`; docs/api.md lists every route and which a token may call.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.
- `4`: Refused: no name, a name over 60 characters, or 20 tokens already.

### buddi api-token list

List the API tokens: id, name, last four characters, when made and last used. Never the token.

```sh
buddi api-token list [--json]
```

**Flags**

- `--json`: Print JSON instead of text. BUDDI_JSON=1 does the same.

**Example**

```sh
buddi api-token list
```

**JSON**: [{ id, name, hint, scope, createdVia, createdAt, lastUsedAt }]

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi api-token revoke

Revoke an API token: a request carrying it is refused from the next one on.

```sh
buddi api-token revoke <id>
```

**Example**

```sh
buddi api-token revoke 6b2f9c1e
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: No token has that id (or the database is not reachable).
- `4`: More than one token starts with that id.

### buddi pause

Stop taking new work. What is running finishes.

```sh
buddi pause
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi resume

Start taking work again.

```sh
buddi resume
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

## Develop

Only in a source checkout. A packaged install does not list them.

- [`buddi init`](#buddi-init): Set a source checkout up: .env, the database, the service. Safe to run again.
- [`buddi db up`](#buddi-db-up): Start the Postgres container of a source checkout.
- [`buddi db down`](#buddi-db-down): Stop the Postgres container.
- [`buddi db status`](#buddi-db-status): Say whether the Postgres container is running.
- [`buddi db secure`](#buddi-db-secure): Give the database a generated password, kept in the vault.
- [`buddi migrate`](#buddi-migrate): Apply core's migrations and every installed plugin's.
- [`buddi serve`](#buddi-serve): Run the gateway in this terminal instead of the service.

### buddi init

Set a source checkout up: .env, the database, the service. Safe to run again.

buddi init is for a source checkout. A packaged install sets itself up the first time you run buddi.

```sh
buddi init [--yes]
```

**Flags**

- `--yes`: Ask nothing and take every default, for scripts and CI.

**Example**

```sh
buddi init --yes
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi db up

Start the Postgres container of a source checkout.

buddi db is for a source checkout. A packaged install runs its own database; buddi status says whether it is up.

```sh
buddi db up
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi db down

Stop the Postgres container.

buddi db is for a source checkout. A packaged install runs its own database; buddi status says whether it is up.

```sh
buddi db down
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi db status

Say whether the Postgres container is running.

buddi db is for a source checkout. A packaged install runs its own database; buddi status says whether it is up.

```sh
buddi db status
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi db secure

Give the database a generated password, kept in the vault.

buddi db is for a source checkout. A packaged install runs its own database; buddi status says whether it is up.

```sh
buddi db secure
```

**Then**: `buddi service restart`, so what is running picks up the new password.

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.

### buddi migrate

Apply core's migrations and every installed plugin's.

buddi migrate is for a source checkout. A packaged install migrates when it starts and when it upgrades.

```sh
buddi migrate
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
- `3`: The database is not reachable, or not configured.

### buddi serve

Run the gateway in this terminal instead of the service.

buddi serve is for a source checkout. A packaged install runs in the background; buddi service status says how it is.

```sh
buddi serve
```

**Exit codes**

- `0`: Done.
- `1`: It failed; the message says why.
- `2`: The command was not typed right.
