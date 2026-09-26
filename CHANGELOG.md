# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

## 0.1.0-pre.18 — 2026-09-26

### Added

- One `buddi` command tree, the same words in a packaged install and in a source checkout. `buddi help` lists what applies where you run it, in five groups; `buddi help <command>` and `buddi <command> --help` explain one command with an example and its exit codes. A mistyped command answers "Did you mean buddi …?". Every command is in [docs/cli.md](docs/cli.md).
- `buddi status` is one screen: the version, the service, the database, which agents can run, what needs you, the last recap, and whether a newer buddi is out. `buddi doctor` stays the deep check.
- `--json` on `buddi status`, `buddi jobs`, `buddi backup list`, `buddi telegram devices` and the `buddi service` verbs. `BUDDI_JSON=1` does the same for the commands that read.
- In a packaged install, `buddi backup create`, `buddi backup list`, `buddi backup verify`, `buddi backup prune` and `buddi service logs` work.
- `buddi ask` is made for scripts: `--json` prints `{ text, runId, conversationId, artifacts }`, a question can come on stdin, `--file <path>` attaches a file the way a file dropped on the dashboard is kept, and `--wait <seconds>` waits for an approval you give elsewhere and then finishes the answer.
- `--json` on `buddi agents`, `buddi agents show`, `buddi agents models`, `buddi missions list`, `buddi reminders` and `buddi plugins list`.
- With a mail account set up, buddi can reach you by mail to yourself: a plain-text mail from that account to its own address, and to no other, at most one a minute. Pick it in Settings → Notifications. A plugin can add a channel like it through `ctx.buddi.channels` once it declares `owner:channel`; the install card says "adds a way for buddi to reach you". The host API is now 1.3.
- buddi can reach you with a system notification on the computer it runs on: `terminal-notifier` or `osascript` on a Mac, `notify-send` on Linux with a desktop. It shows up in Settings → Notifications only where it can show something, and nothing leaves the machine. Telegram stays the default when both are there.
- The dashboard tells buddi when you are looking at it. A message that arrives while you are there shows as a card at the top right, with the agent's face and a link, instead of going to Telegram; one you have not seen after ten minutes still goes.
- Home's "Needs you" lists what buddi kept for you: watcher finds, reminders, reports, failures and plugin messages, and what waits for the end of the day.
- Settings → Notifications: where buddi reaches you, with a "Send a test" button for each channel; a channel or Off for each kind; quiet hours and the end of the day; and the last twenty messages with where each went and whether you saw it.

- Everything buddi tells you unasked, from approvals and watcher alarms to reminders, reports and failed jobs, is now kept as one list of notifications, with where each went, when, and whether you saw it.
- Items that can wait for the end of the day go out together at 18:00 your time, as one message with a line each.
- A plugin can send you a message through `ctx.buddi.owner.notify` once it declares `owner:notify`. The install card says "can send you messages when you are away", the message carries the plugin's name, and your settings choose where it goes, never the plugin. The host API is now 1.2.
- A camera button in the composer snaps one picture of another tab in your browser and attaches it to the message. The browser's own chooser picks the tab; nothing is recorded.
- The menu under your initial at the foot of the rail names the running buddi version, and the newer one when the daily check found it.
- Settings → System → Version shows what changes in a newer buddi before you upgrade to it.
- When a newer buddi is ready, Home says so under the greeting and Settings gets a dot in the sidebar.

### Changed

- When the keychain is locked for a terminal session, the vault's sentence names the command that unlocks it.
- `buddi version` prints the real version: the installed one, or in a source checkout the version and its commit.
- A command that does not apply to a packaged install, like `buddi init` or `buddi db up`, says what to do instead and exits 2, instead of "checkout-oriented command not yet supported". Exit codes are the same everywhere: 0 done, 1 failed, 2 not typed right, 3 needs something first.
- In a packaged install, `buddi service status` answers in a sentence; `--json` prints what it printed before.
- In a source checkout, `buddi` with no arguments opens the dashboard, as it does in a packaged install.
- `buddi ask` exits 3 when a run stops for an approval, not 2, and says where to approve it and how to finish with `buddi ask --resume <conversationId>`. A database that is not reachable, or an agent that does not exist or cannot run, is also exit 3; a mistyped option is exit 2.
- Tables on the canvas are compact: one line per row, smaller type, dates with their year, long cells cut with an ellipsis that shows the whole text on hover.
- Without Telegram, an approval or a report no longer fails to send: it is kept for the dashboard, and the list says there was no channel to reach you.
- The same alert firing more than three times in an hour waits for the end-of-day message instead, and says so once.
- The Settings entry in the rail is a gear, the sign everyone knows, instead of three sliders.
- An agent's Setup tab is three shorter pages: Identity, Brain and Access. Each saves its own fields, and the address keeps the page you are on.
- The dashboard's type is DM Sans, with DM Mono for code, shipped inside the package. It loads no font from the internet, as before.
- The agents' Chromium now lives in the data directory, at `browser/engines`, so a container that keeps its data volume keeps the browser too.
- On an agent's Setup tab, Roles are four chips (front desk, overview, recap, maker) that say what each one does and which agent holds it now. Any other role goes in a line of text below.

### Fixed

- A line under "Needs you" on Home leaves when you click it, link or not, and a reminder's or a mission's line opens the conversation that wrote it.
- An answer whose reasoning ends in a lone `</think>`, as Ollama Cloud sends for glm and qwen, keeps that reasoning as thinking instead of printing it as the reply.
- `buddi status` and `buddi agents` read the provider keys from the vault the way the service does, instead of saying a key is not set when it lives in the keychain.
- A tool call cut off by the reply length limit no longer sits at "Awaiting result" and stops the run. It shows as failed, the agent is told to send fewer items or pass a file, and it gets another turn to do so.
- In the collapsed agent rail, the groups separator, the + button and a group's faces now sit on the rail's centre line.
- Settings → Version now reads the running version from the installed package, which is named `@withbuddi/buddi`, instead of falling back to the core library's version.
- When the system will not let Chromium start its sandbox, the browser status says so in one sentence with the command to run, and the check now tests the browser with the sandbox on.
- A model that turns images down no longer stops the run: buddi sends the turn again with each screenshot replaced by a line of text.
- With a public origin set, the dashboard on 127.0.0.1 no longer refuses writes with a bare 403 when another buddi's cookie is in the browser. Cookies are named after the port the page is on, and a write refused for stale cookies now says to reload the page.

Releases up to 0.1.0-pre.17 are described on their GitHub release pages: https://github.com/withbuddi/buddi/releases

### Removed

- "Run setup again" in the owner menu and in Settings → System: it only bounced back to the dashboard on a finished installation, and everything the first run sets has its own page now.

