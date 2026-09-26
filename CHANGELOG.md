# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

### Added

- [docs/dashboard.md](docs/dashboard.md): the dashboard place by place, with one thing to try in each. The docs index has a new group, "Where you talk to buddi": the dashboard, Telegram (now with example exchanges), the command line (now opening with what it is for and five examples), Claude Code and notifications.
- `secret.list` tells an agent which of your secrets the browser may fill, by name, and where each may go, so it no longer asks you for the names. It never returns a value.
- A goal can watch a number you report yourself, like your weight. When no plugin measures it, the agent creates the metric as it proposes the goal and takes the number you just said as the start; the card says "measured by you, when you tell buddi", and `goal.metrics` lists these metrics with the source `owner`.
- `goal.record` writes down a number you tell any agent ("285 this morning", "ran today"), names the goal or the metric rather than whose goal it is, and answers with where the goal stands in one sentence. A number more than half away from the last one, or of the other sign, is asked about before it is kept.
- When a week (or a day, for a daily goal) passes without you telling buddi the number, the goal's agent says so once, in the end-of-day message: "You have not told me your weight this week." A watcher finding can ask for this with `notify: { urgency: 'today' }`.
- Frequency goals: "run three times a week". A goal can count how many times you tell buddi something in each week (Monday to Sunday, your timezone) or month. The card says "3 times a week"; a week that closes short is said once, a streak milestone ("4 weeks in a row") once, and at the deadline the goal is met when more weeks met the count than fell short.
- The Goals page shows the numbers you told buddi for a goal you measure, and a frequency goal's weeks as met, short or partial. In chat, `goal.status` draws your own values, or the count for each week, against the target.
- Settings → Notifications has a Telegram panel: save or replace the bot token, see the phones you paired and unpair one, and pair another with the same QR code first run shows. Telegram appears in "Where buddi reaches you" as soon as the bot starts, without a restart.
- On Telegram, the files a run saved arrive after its answer: pictures as photos, everything else as documents under their own names. A file over Telegram's 50 MB limit is named in one sentence that points to the Files page.
- On Telegram, a table an agent draws arrives as monospace text when it fits one message, and as a CSV named after the table when it does not. A chart or another view answers with one line, and the dashboard link when a public address is set.
- On Telegram, the answer streams into one message as the model writes it, updated at most every 1.5 seconds; the last update is the whole answer.
- A new learning proposal (a skill, a rule for a plugin, a change to an agent's file) is a notification that waits for the end of your day and keeps quiet hours. On Telegram it arrives as a card with Keep and Discard; a tap decides it exactly as the Proposals page does, and a plain "yes" in the chat decides nothing.
- [docs/telegram.md](docs/telegram.md): what the Telegram surface is and is not, pairing, what arrives on the phone, what you can send, the commands, the limits and what leaves this computer.
- Three read-only Telegram commands: `/missions` lists the next five scheduled missions with their times and agents, `/goals` each open goal with its number and whether it is on track, behind or ahead, and `/where` the dashboard address when your phone can reach it.

### Changed

- When a site mails a one-time code, an agent with the email tools reads it from your inbox before asking you: the newest message from that site, from the last ten minutes. The code is never stored or reused. The browser's guidance, `email.search` and the first assistant's "How you work" say so.
- Every browser observation says when it was taken ("Observed 12:04:35 UTC.", and `observedAt` on the observation), and the agent observes once more after a click that submits or navigates before it says whether it worked, judging from the newest observation only. A sign-in that succeeded is no longer reported as failed from an older page.
- A browser binding for a secret can name a wildcard origin, like `*.wikimedia.org`, so one binding covers a site's sign-in host and its pages. `*.` stands for the leftmost part only and may not sit on a public suffix such as `*.com` or `*.github.io`; the card and the use log still name the real site. A form data binding's origin is read the same way as a field binding's.
- A secret's browser binding takes the site as you type it: a bare host becomes its https origin, a full address is cut to its origin, and anything else is refused with an example.
- On Telegram a browser screenshot's caption no longer counts steps; the count appears only when five or fewer are left.
- Signing in with Claude from the first run starts the account on the model catalogue's default for Claude, rather than a fixed Sonnet 5; Sonnet 5 is used only when the catalogue names none.
- A goal that stays off track wakes its agent at most once per cadence for the same drift: once a week for a weekly goal, once a day for a daily one. The first drift still wakes it at once. A watcher's finding can set its own `cooldownMs`.
- On Telegram, an answer longer than 4,096 characters keeps its first part in the message that said "Working on it" and sends the rest after it, split between paragraphs, instead of deleting that message.
- The model list knows Claude Opus 5.5 (`claude-opus-5-5`, $4 and $20 a million tokens) and Fable 5.1; Sonnet 5 stays the default, at half the price. The context table knows Fable 5.1, Opus 5.5 and Sonnet 5 hold a million tokens.
- Signing in with Claude from the first run opens the consent page itself; the button stays for a browser that blocks the window.
- Signing in with a Claude or ChatGPT subscription is offered by default; `BUDDI_SUBSCRIPTION_SIGNINS=off` hides both. The setup wizard shows the Claude card first, with a line on the plan's monthly Agent SDK credits. `buddi doctor` says whether the sign-ins are offered or hidden.

### Deprecated

- `BUDDI_ANTHROPIC_OAUTH_EXPERIMENT` and `BUDDI_CODEX_EXPERIMENT` are no longer needed. For one release, setting either to `0` still hides that one sign-in, and `buddi doctor` names the new variable.

### Fixed

- A model account imported from an environment variable no longer writes a refused use to the Keys and secrets log on every reload: its key answers from the vault directly, as the docs say.
- When you are looking at the tab an agent wants to act or fill in, the agent now asks you once to switch to another tab or window, instead of failing twice and retrying.
- `secret.fill` fills a username. A secret bound to a site as a browser field now goes into any field on that site, not only a password field, and the card names the field.
- The first assistant is granted `secret.*`, so it can fill a sign-in from Keys and secrets; the browser's notice tells every agent that is how a stored password goes in. Existing assistants get the family from their Setup tab.
- Settings → Keys and secrets saves again: the page's writes now run as the owner, so `secrets.put` and its siblings are no longer refused as unknown tools.
- In your own Chrome, an observation that finds the page not ready (a heavy page like cnn.com, or a tab the page script missed) injects the script again and reads the page up to three more times, after 0.5, 1 and 2 seconds, before it says "The page has not answered after three tries. Wait a few seconds and observe again."
- A browser observation that does not answer, after navigating, observing or an input action, no longer pauses control. The agent is told "The page has not answered yet. Wait a few seconds and observe again." and must observe before it acts. Control pauses only when the tab or window is gone, after three failed observations in a row, or when you take over.

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

- On Telegram the agents are told the owner reads on a phone and keep answers short, leading with the point; `/help` says so, and asking for more gets more.
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

- When the browser pauses because a page would not confirm it loaded, the sentence on Telegram says to send /browser resume, not to tap a dashboard button.
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

