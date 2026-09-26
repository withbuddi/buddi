# Docs

Every page here describes what buddi does today. The roadmap, ideas and
unbuilt specs are kept outside this repository.

## Running it

- [Install](install.md), [first run](onboarding.md),
  [operations](operations.md): backup, restore, and where your data lives.
- [The command line](cli.md): every `buddi` command, its flags and exit codes.
- [Provider accounts](providers.md), [Claude subscription sign-in](anthropic-oauth.md),
  [ChatGPT subscription through Codex](codex-accounts.md).
- [Using buddi from Claude Code](mcp.md) (`buddi mcp`).

## What agents do

- [Conversations](conversations.md): what the model sees, and what you can say
  while it works.
- [Groups](groups.md), [Files](files.md), [Host execution](host-execution.md).
- [Computer and browser control](browser.md), [the web plugin](web.md).
- [Email](email.md): accounts, threads, policies, watchers.
- [Goals](goals.md): a target with a clock.
- [Learning](learning.md): buddi proposes, the owner keeps.
- [Owner secrets](owner-secrets.md): used, never seen.
- [Notifications](notifications.md): what reaches you, when, and where.
- [The developer plugin](developer.md): an agent that works in a workspace.
- [Built-in system context](system-context.md).

## How it is built

- [Architecture](architecture.md): the boundaries, the contracts and the
  rules the code holds to.

## Writing plugins

- [Writing a plugin](plugins.md): the guide and the full contract.
- [The plugin host API](plugin-host-api.md): `ctx.buddi`, and the boundary.
- [Plugin pages](plugin-pages.md): a plugin's screens, as data.
