# Docs

Every page here describes what buddi does today. The roadmap, ideas and
unbuilt specs are kept outside this repository.

## Running it

- [Install](install.md), [first run](onboarding.md),
  [operations](operations.md): backup, restore, and where your data lives.
- [Provider accounts](providers.md), [Claude subscription sign-in](anthropic-oauth.md),
  [ChatGPT subscription](codex-accounts.md).

## Where you talk to buddi

- [The dashboard](dashboard.md): the page in your browser, place by place.
- [Telegram](telegram.md): pairing, what arrives on your phone, the commands.
- [The command line](cli.md): every `buddi` command, its flags and exit codes.
- [The HTTP API](api.md): every route the dashboard uses, and how a script
  calls buddi without it (an API token).
- [Using buddi from Claude Code](mcp.md) (`buddi mcp`).
- [Notifications](notifications.md): how buddi reaches you when you are not
  looking.

## What agents do

- [Agents](agents.md): what an agent is, and the catalogue you add more from.
- [Conversations](conversations.md): what the model sees, and what you can say
  while it works.
- [Groups](groups.md), [Files](files.md), [Host execution](host-execution.md).
- [Computer and browser control](browser.md), [the web plugin](web.md).
- [Email](email.md): accounts, threads, policies, watchers.
- [Goals](goals.md): a target with a clock.
- [Learning](learning.md): buddi proposes, the owner keeps.
- [Memory](memory.md): preferences, notes, the people in your life, and the
  dates buddi acts on.
- [Owner secrets](owner-secrets.md): used, never seen.
- [Connections](connections.md): services that speak MCP, their tools given to
  your agents.
- [The developer plugin](developer.md): an agent that works in a workspace.
- [Speech](speech.md): agents listen to a recording and answer with a voice.
- [Built-in system context](system-context.md).

## How it is built

- [Architecture](architecture.md): the boundaries, the contracts and the
  rules the code holds to.

## Writing plugins

- [Writing a plugin](plugins.md): the guide and the full contract.
- [The plugin host API](plugin-host-api.md): `ctx.buddi`, and the boundary.
- [Plugin pages](plugin-pages.md): a plugin's screens, as data.
