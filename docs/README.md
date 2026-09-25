# Docs

`docs/` holds reference for what is built, each file starting `Status:
reference, <date>`. [`docs/specs/`](specs/) holds accepted specifications, built
or not; a built one stays there until it is folded into a reference page. [`docs/ideas/`](ideas/) holds proposals only; an accepted idea
moves to `specs/`, and a built one is folded into a reference page here and
deleted.

See [`ROADMAP.md`](ROADMAP.md) for what is built, what is in progress, and the
order of what comes next.

## Reference (built)

- [Install](install.md), [packaged install foundation](install-foundation.md),
  [first run](onboarding.md), [operations](operations.md)
- [Provider accounts](providers.md), [Claude OAuth experiment](anthropic-oauth.md),
  [Codex ChatGPT accounts](codex-accounts.md) (behind `BUDDI_CODEX_EXPERIMENT`)
- [Conversations](conversations.md)
- [Computer and browser control](browser.md), [computer use (historical)](computer-use.md)
- [Groups](groups.md), [Files](files.md), [Host execution](host-execution.md)
- [Built-in system context](system-context.md), [the web plugin](web.md)
- [Writing a plugin](plugins.md)
- [Using buddi from Claude Code](mcp.md) (`buddi mcp`)

## Specs, built

These specs are fully built; each is still the reference for its feature
until it is folded into a page above.

- [Email](specs/email.md) — all six steps.
- [Owner secrets](specs/owner-secrets.md) — built and merged 2026-09-24.
- [Plugin host API](specs/plugin-host-api.md) — built and merged 2026-09-24.
- [Learning](specs/learning.md) — built 2026-09-23.
- [Goals](specs/goals.md), [Plugin pages](specs/plugin-pages.md),
  [MCP server](specs/mcp.md).
- [Developer](specs/developer.md) — built; the plugin lives in buddi-plugins.

## Specs (accepted, not started)

- [Messengers](specs/messengers.md) — last on the roadmap.

## Ideas (proposals only)

See [`ideas/README.md`](ideas/README.md) for the open list.
