# Roadmap

Status: reference, 2026-09-21

One page: what is built, what is in progress, and the order of what comes
next. Checked against the code and `git log` on 2026-09-21.

## Built

- [Install](install.md) — the published package, bundled Postgres, the
  first-run wizard, encrypted backup/restore, plugins from npm, the version
  check and upgrade action. [Packaged install foundation](install-foundation.md)
  and [first run](onboarding.md) are the implementation detail underneath it.
- [Operations](operations.md) — backup, restore, and upgrade, including that a
  start migrates the schema itself.
- [Provider accounts](providers.md) — named API-key and compatible-endpoint
  accounts, explicit account/model per agent. [Claude OAuth](anthropic-oauth.md)
  is a built, independently gated experiment on top of it.
- [Conversations](conversations.md) — the context budget follows the bound
  model's window, and a message sent while the agent works is queued and
  delivered mid-run, on the dashboard and on Telegram.
- [Computer and browser control](browser.md) — native macOS computer control by
  default, headed Playwright as an explicit alternative, the pinned Browser
  canvas tab, and Telegram parity (screenshots and take-over). [Computer
  use](computer-use.md) is the historical survey this superseded.
- ["Your browser", the Chrome extension](browser.md#optional-your-browser-the-chrome-extension)
  — the third browser mode: agents work in the owner's own signed-in Chrome,
  paired with a six-digit code (`packages/extension`).
- [The remote hand](browser.md#the-remote-hand-driving-from-the-dashboard) —
  clicking, typing and scrolling the live page from the dashboard, and the same
  screen from Telegram.
- [Signing in through Tailscale](operations.md) — the dashboard on the tailnet
  without a ticket, off until an owner names the login that may sign in.
- The memory plugin (`packages/tools/memory`) — what the agents remember about
  the owner, scoped per agent; the contract is
  [writing a plugin](plugins.md).
- [Groups](groups.md) — a team of agents in one persistent conversation.
- [Files](files.md) — uploads and agent outputs in one library.
- [Host execution](host-execution.md) — `host.exec` and friends.
- [Built-in system context](system-context.md) — the clock snapshot and host
  summary every run gets for free.
- [The web plugin](web.md) — search and read-one-page as a capability.
- [Writing a plugin](plugins.md) — the contract for anything an agent can do.

## In progress

- [Email](specs/email.md) — 4 of 5 steps built (policies and the gate;
  accounts plural; threads and the Sent folder; the first two watchers with a
  switch each); step 5 (draft lifecycle, alias choice on approval) remains.

## Next, in order

1. [Developer](specs/developer.md) — an agent that works in a workspace.
2. [Messengers](specs/messengers.md) — buddi speaks as you, Telegram first.
3. [Learning](specs/learning.md) — buddi proposes, the owner keeps.
4. [Owner secrets](specs/owner-secrets.md) — site passwords the agent can fill
   but never see.
5. macOS app — a packaged desktop app around the existing service.
6. Linux and Windows — a second vault backend, the Task Scheduler unit, and a
   three-platform CI job (see [install.md §12](install.md#12-what-of-this-is-built)).
7. Drive and Dropbox — the provider APIs for backup, after the folder target
   has been used for real.
8. [Voice](ideas/voice.md) — notes on Telegram, audio mode on the dashboard.

Small, whenever a slot opens:

- Agent avatar — an optional uploaded PNG or SVG on the agent record next to
  the icon, size-capped and re-encoded on upload, served at
  `/api/agents/:id/avatar`, shown in the roster, chat header, delegation view
  and the Telegram profile photo; the icon remains the fallback. The mascot
  artwork itself lives in the `buddi-design` repository, never here.
- Artefacts page — the list of `core.artifacts` with preview and download.

## Later

- [Reusable Codex adapter](ideas/reusable-codex-adapter.md) — extract the
  Codex App Server integration into a package other projects can consume,
  once the [experiment](codex-accounts.md) is stable and a
  second consumer exists.
- Remote/headless browser display — a browser on a remote host with no
  desktop session; not the first delivery of [browser.md](browser.md).
- [buddi as an MCP server](ideas/mcp.md) — parked, not pursued.
- Long-running browser context compaction and no-progress recovery — a browser
  session that runs for hours needs its transcript compacted and a way out of a
  loop that is making no progress.
- Cross-platform encrypted-Postgres credential storage — decide and migrate how
  the database credential is stored where there is no macOS keychain, rather
  than leaning on the file vault by default ([providers.md](providers.md)).
