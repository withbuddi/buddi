# Roadmap

Status: reference, 2026-09-21

One page: what is built, what is in progress, and the order of what comes
next. Checked against the code and `git log` on 2026-09-21.

## Built

- [Goals](specs/goals.md) — a target with a clock: metrics from plugins,
  deterministic hourly checks, the holding agent woken when the owner drifts;
  Home block, Goals page, first metrics in finance, email and developer.
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
- [Developer](specs/developer.md) — an agent that works in a workspace: modes chosen
  once, a run list of plain commands, hardened git, previews on their own
  origin. Lives in buddi-plugins.
- [Plugin pages](specs/plugin-pages.md) — a plugin's screens as data: rail
  entries and settings tabs from descriptors, reads as queries, writes as
  tools; the email screens are the proof.
- [Email](specs/email.md) — all six steps: policies and the gate, accounts,
  threads and Sent, six watchers with a switch each, the draft lifecycle with
  owner choices on the approval card, a Mail page with search, attachments
  on request.

## In progress

- [Learning](specs/learning.md) — buddi proposes, the owner keeps. Steps 1–3
  built 2026-09-23 (buddi 44792d6, 55210a4, 37a4fff): the proposals table, the
  three `learning.*` tools, Settings → Proposals with a count on Home,
  provenance with the untrusted mark and its echoed sentences highlighted; a
  kept skill is a versioned file under the agent (a later one is a diff),
  removable from the inbox or the agent's Skills tab, and no file tool writes
  an agent's own skills; a plugin proposes rules through core and applies the
  kept ones itself, and the email plugin's learned rules wait in the same
  inbox. Next: persona changes through Agent Father and the digest (step 4).

## Next, in order

0. [MCP server](specs/mcp.md) — configure buddi from Claude Code: reads at
   once, every write an approval card, `buddi.ask` to talk to an agent.
   Taken ahead of Learning step 4 on 2026-09-23.
1. [Messengers](specs/messengers.md) — buddi speaks as you, Telegram first.
2. [Owner secrets](specs/owner-secrets.md) — site passwords the agent can fill
   but never see.
3. macOS app — a packaged desktop app around the existing service.
4. Linux and Windows — a second vault backend, the Task Scheduler unit, and a
   three-platform CI job (see [install.md §12](install.md#12-what-of-this-is-built)).
5. Drive and Dropbox — the provider APIs for backup, after the folder target
   has been used for real.
6. [Voice](ideas/voice.md) — notes on Telegram, audio mode on the dashboard.

Developer plugin, the visible layer (2026-09-23; the plugin itself is done —
run mode by default, remembered commands, lockfile installs, local `npx`,
`git init`, previews on the tailnet). One at a time, one Opus subagent each,
with a written brief; in order:

1. **Tool row gist and diff renderer** — built 2026-09-23 (buddi `2d899eb`, buddi-plugins `099db96`); rows unfold by the shape of the result (a `diff`, or a `command` with output), never by tool name, because `bundle.test.ts` forbids plugin tool names in the web source. Each
   chat tool row shows the path/command/query inline; write/edit rows expand
   to a colour-coded diff, run/start rows to command plus `plain` output; a
   `diff` canvas renderer replaces `document` for write, edit and summarise.
   Write's execute result gains `diff` (edit already has it).
2. **Auto-switch to Preview** — built 2026-09-23 (buddi `1f2fdfb`, buddi-plugins `7d1458f`); a start that is not listening yet names the preview it will be, the plugin watches the pid for three minutes and writes the port on its row, and the canvas asks the existing `check` route until it is served, then opens it. When a `developer.start` process is confirmed
   listening on a port, the canvas opens and focuses the Preview tab itself
   instead of waiting for `developer.preview`. Plain HTML sites also need a
   frame reload after a write (Vite reloads itself over the proxied websocket).
3. **File explorer** — built 2026-09-23 (buddi `45cc58a`, buddi-plugins `f04d944`); reads are the plugin's page queries run as the owner on `/api/pages/<plugin>/<query>`, which now streams a query's `pageFile` bytes behind the same session check, the gateway deciding what shows inline. A canvas tab over the workspace using `developer.list`
   and `developer.read` as the owner (skips agent tiers; reads only), refreshed
   on writes in the conversation stream; click opens a file view; images and
   PDFs render as themselves; uploads/downloads through the Files library.
   No in-place editing at first.
4. **Terminal and image renderers** — built 2026-09-23 (buddi `ab28132`, buddi-plugins `d97847e`); run and output draw as a dark terminal that follows the end and says what a cap dropped, and `image` takes a library file's id only, so the page builds nothing but the library's own URLs (the developer has no image result to use it on yet). A terminal renderer for run output
   (command on top) and an image renderer for any tool output naming a file
   in the library; useful to email, browser and finance too.
   - Port picker on the Preview — built with it; start and preview carry `ports`
     from the process tree, and choosing one reframes on `<name>.<port>`
     through the same ticketed link, which the plugin serves only for a port
     that tree holds.

Small, whenever a slot opens:

- Agent avatar — an optional uploaded PNG, SVG or GIF on the agent record next to
  the icon, kept in the database blob store (never in the agent file), size-capped and re-encoded on upload, served at
  `/api/agents/:id/avatar`, shown in the roster, chat header, delegation view
  and the Telegram profile photo; the icon remains the fallback. The mascot
  artwork itself lives in the `buddi-design` repository, never here.
- Artefacts page — the list of `core.artifacts` with preview and download.
- Agent tool picker — built 2026-09-23 (buddi `c8c2e1c`); every installed tool
  from `GET /api/agents/:id/tools`, grouped by plugin with its description, a
  search, and all/none per plugin that saves as the family glob when the server
  offers one. The agent-writing tools are drawn disabled, the memory tools are
  tagged core (a new agent from `platform.create_agent` starts with them unless
  `withoutMemory`; a plugin's proposal is left as written) and removing one asks
  once, and a plugin's newer suggestions sit on top, one click each.
- Save errors beside the button — built 2026-09-23 (buddi `c8c2e1c`); a refused
  "Save who it is" says why next to the button instead of in a banner at the top.
- `email.inbox_unread` needs IMAP flag re-sync first — the metric is worth
  having and cannot exist until a poll refreshes `\Seen` on rows it already
  has. Today flags are written once at ingest (`on conflict … do nothing`), so
  the count only climbs and a goal on it would be missed by construction.
- `ToolRef.pending` on plugin pages — a sentence drawn above a gated action's
  approval card while it waits ("Nothing has been sent…"); the one Mail
  behaviour the port could not express.

## Later

- [Reusable Codex adapter](ideas/reusable-codex-adapter.md) — extract the
  Codex App Server integration into a package other projects can consume,
  once the [experiment](codex-accounts.md) is stable and a
  second consumer exists.
- Remote/headless browser display — a browser on a remote host with no
  desktop session; not the first delivery of [browser.md](browser.md).
- [A browser operator on a local vision model](ideas/browser-operator.md) —
  one agent holds the browser tools and runs on an MLX vision model; the
  others delegate a task in words and get text back. To try once the main
  list is mostly drained (2026-09-23).
- Long-running browser context compaction and no-progress recovery — a browser
  session that runs for hours needs its transcript compacted and a way out of a
  loop that is making no progress.
- Cross-platform encrypted-Postgres credential storage — decide and migrate how
  the database credential is stored where there is no macOS keychain, rather
  than leaning on the file vault by default ([providers.md](providers.md)).
