---
title: "The dashboard"
status: reference
updated: 2026-09-26
---

# The dashboard

The dashboard is buddi's page in your browser, on `http://127.0.0.1:4317`. It
is where you talk to your agents, decide what they ask, and see what ran while
you were away. It is served by buddi itself, on this machine, and reaches
nothing outside it.

## Getting in

`buddi` (or `buddi dashboard`) opens it with a sign-in link that is good for
five minutes and works once. The browser swaps it for a session: 30 days idle
on this machine, 12 hours from anywhere else. `buddi dashboard --token` prints
only the ticket, for a browser on another device. The first time, the link
opens the first-run wizard (see [First run](onboarding.md)). Remote access and
the session rules are in [Operations](operations.md).

### Install buddi as an app

The dashboard is an installable web app: Chrome and Edge offer "Install buddi"
(Home's **Install app** hands you that prompt), and Safari has File → Add to
Dock. Installed, it opens in its own window with the Blob as its icon. Home
suggests it once after setup, with the bookmark shortcut beside it, until you
choose Not now. On a Mac, `buddi dashboard --install-app` is the other way: a
double-clickable app in ~/Applications that signs you in with a fresh link each
time. An app keeps the address it was installed from, so the tailnet address
installs as its own app. The app has no reload button, so the owner menu at the
foot of the rail has **Reload**; after an upgrade it reads **Reload to update**
in any mode, with a dot on your initial. The page asks which build buddi serves
every five minutes and right after its live connection comes back (a restart
drops it). On a new build it reloads itself, where you were, when the tab is
hidden or you have been idle for a minute with every composer empty, nothing
recording and no sheet open; otherwise the dot and **Reload to update** wait
for you.
Installed, buddi also opens when the gateway is out of reach: instead of the
browser's error it says buddi isn't answering at that address and what to
check (on this Mac, `buddi status`; on the tailnet address, whether Tailscale
is on and the Mac awake), asks again every ten seconds and comes back on its
own. A page already open shows a thin "Lost buddi. Retrying…" bar after thirty
seconds without an answer.

## The rail

The column on the left holds the places: **Home**, **Chat**, **Agents**,
**Activity**, **Files**, then the pages plugins add (such as **Mail** and
**Calendar**), and **Settings** at the foot. Settings → Appearance → In the rail
chooses which plugin pages sit there; all are on until you turn one off, and a
page taken off the rail still opens from Settings → Plugins (**Open**). The place you are on is filled and
marked. Home carries the rail's only count: the things waiting on you. Settings
carries a dot, without a number, when a newer buddi is ready.

Under Settings is your initial. It opens a small menu: the theme (Light, Dark,
System), a way to Appearance, and the running version, `buddi <version>`. When a
newer one is out it says "A newer buddi is ready" with its number, and a click
goes to Settings → System to upgrade.

On every page but Home and Chat, a round buddi button in the bottom-right
corner opens a small chat with your front desk over the page (the same
composer, the answer streamed in place, **Open in Chat** to carry on there);
it keeps its conversation until you reload or press **New**.

## Home

The page the dashboard opens on. It answers three questions in order: what
needs me, what is my team up to, what is coming.

- **The greeting** says the day and counts what needs you. When the front
  desk's face is the Blob, it breathes there, as it does on the first-run
  page; it thinks beside "is working" in the chat and in the corner button.
  With reduced motion set on your computer, it stays a still picture.
- **The composer** under it writes to your front desk (the default agent),
  with files and voice like the chat; sending opens the new conversation
  where the answer arrives, and its last three conversations sit below as
  "Continue" links.
- **Needs you**: approval cards you decide in place, messages kept for the
  dashboard (a watcher's find, a reminder, a report), failed jobs, urgent
  alerts, an agent a plugin needs, and proposals to keep or discard.
- **Your team**: one face per agent, with what it is waiting on or what it
  does. A face opens a conversation with it.
- **On offer**: up to six next steps your agents suggested, each a chip.
- **Coming up**: the next missions and reminders. **Lately**: the last five
  conversations.
- Blocks plugins add, such as Goals, and "What buddi learned this week" when
  there is a digest.

**Tips.** When something in buddi has gone unused for a while, a second
agent, a group, a mission, voice, the browser, a mailbox nobody reads, or no
recommended plugin at all (finance, image, speech, weather, calendar), which
points at Browse, Home may show one quiet card under the composer: one sentence and one action.
At most one tip a day, never during first run, and never about a plugin that
is not installed. "Not this again" removes that tip for good; the × puts it off
for a week. A tip whose reason goes away disappears on its own. Settings →
Notifications → Tips on Home turns them off. The rules are data, one entry
each in `packages/gateway/src/tips/rules.ts`; what they decide on is read from
the installation, plus the pages the dashboard reports it opened, once a day
each. The lightbulb left of the Blob opens a Tips section under the greeting:
one card per tip with where it stands (due today, waiting, not needed now,
dismissed with Bring back, shown on a day), and the same Tips on Home switch;
while it is open the day's tip card is hidden, and the browser remembers it
open. A dot marks one due today while tips are off.

Try it: approve a waiting card from Needs you without opening the chat.

## Chat

A conversation on the left and the canvas on the right. It opens on your most
recent conversation, not on an empty page. A second rail beside it holds your
team, one face each; a badge on a face means that agent is waiting on you.
**New chat** starts a fresh conversation, **History** lists the earlier ones.

**The thread** is the conversation as it happens: the agent's answer, the
steps it took, and the cards it asks you to decide. You can keep typing while
the agent works: what you send joins the run (see
[Conversations](conversations.md)). **Stop** ends the run.

**The composer** is one box:

- the **paperclip** attaches a file; paste and drop work too. Each file is a
  tile that says uploading, ready or failed, and nothing is sent until it is
  ready;
- the **camera** snaps a tab: the browser asks which tab, and one frame of it
  is attached as a picture;
- the **model chip** shows the model this agent runs on; a click opens its
  setup to change it;
- **Thinking** turns the agent's reasoning before the answer on or off.

**Talking to buddi.** With the speech plugin set up on Settings → Speech,
the **microphone** beside the paperclip turns what you say into text: hold it
and let go, or click once to start and again to stop; a red dot follows your
voice while it listens. The words land in the box for you to edit and send;
hold **Shift** when you stop to send them at once. The **speaker** switch reads
each reply aloud when it is finished, and a new reply interrupts the last; it
is remembered in this browser and off until you switch it on. Both run as
you, so they ask nothing, and they count against the speech plugin's daily
limits ([Speech](speech.md)). The recording is kept in Files like any upload.
Under each reply, **Copy** puts its words on the clipboard and **Read aloud**
speaks that one reply (stop while it plays); they show on hover, and always on
a touch screen. An audio file in a conversation or in Files shows as a small
player with its length and a download link.

**The canvas** holds the last few things the conversation produced, as tabs:
tables, charts, diffs, terminal output, pictures, documents and previews, the
agent's workspace files, and a **Browser** tab while an agent drives a browser
(see [Computer and browser control](browser.md)). A decision waiting to be made
stays on the tab strip. On a small screen, the **Canvas** button opens it.

Try it: drop a bank statement on the chat and ask what changed since last month.

## Agents

Your team, and one page per agent. The index has four tabs:

- **Team**: every agent with its face and whether it can run, a **Talk**
  button, and the choice of default agent (the "front desk").
- **Missions**: what the team runs on a schedule.
- **Offers**: next steps the agents have suggested, and agents plugins need.
- **Reminders**: what the agents have put on the clock.

An agent's own page has the same things for that agent, plus Conversations,
Memory, Skills and **Setup**. Setup has three parts: **Identity** (name,
handle, face, description, persona), **Brain** (the account and model, turn
budget, language, and thinking where the provider honours the switch: Anthropic and OpenAI; on an OpenAI-compatible host it is up to the model) and **Access** (roles, the tools it may call, and
who it may ask: the front desk and the maker ask everyone until you limit them,
any other agent only the colleagues ticked there).

Try it: move an agent to another model under Setup → Brain.

## Activity

Everything that ran, in five tabs: **Conversations**, **Jobs**, **Approvals**,
**Alerts** and **Events**. Conversations is the readable stream; the others are
the same work seen from the queue, the decisions and the log.

Try it: open Jobs, see why one failed, and retry it.

## Files

Every file an agent made and every file you sent, across all conversations,
newest first. Search by name, filter by **Created by agents** or **Uploaded by
you** and by kind. Opening one shows a preview where it is safe, a download,
and the conversations it was part of. See [Files](files.md).

Try it: find the CSV you sent last week and jump back to its conversation.

## Mail

The email plugin's page: what buddi has read, newest first. Search by words,
sender, dates or attachments. Open a conversation to read it, or the reply
written for it; **Send** puts the whole envelope in front of you to approve.
See [Email](email.md).

Try it: open a thread with a Draft pill and send the reply after reading it.

## Goals

Everything buddi is keeping to a number and a date: open goals and finished
ones, each with its progress. One goal shows its history, the checks as a line,
its milestones, **Close** with a note, and a link to the agent that holds it.
See [Goals](goals.md).

Try it: open a goal that is behind and ask its agent why.

## Settings

A list of sections in four groups.

- **Profile**: your name and how the agents address you.
- **Appearance**: theme, background and page width, kept in this browser;
  which plugin pages sit in the rail and which Home glances show, kept by the
  installation.
- **Notifications**: where messages go, the focus schedules, the end of the
  day, and the last twenty sent. Also where Telegram is paired.
- **Memory**: what the agents have kept about you, and the means to correct it.
- **Proposals**: what the agents learned, to keep or discard.
- **Model accounts**: the credentials the agents run on.
- **Computer & browser**: whether agents may act on this Mac, which apps, and
  which browser.
- **Keys and secrets**: your vault, and where each secret may be used.
- **Watchers**: the checks plugins run on a schedule, with a switch each.
- **Backup**: nightly backups, one now, a check, the passphrase, and restore.
- **System**: the version and upgrade, pausing the queue, this host.
- **All plugins**: a page of its own under Settings (the title reads
  Settings › Plugins), with two tabs. **Installed** starts with one **Add a
  plugin** panel: where it comes from (From npm, A file, A directory I built),
  one field and **Read it first**, and the trust sentence under it, word for
  word. For a directory, **Browse…** lists the folders under your home
  directory on the computer buddi runs on, marks the ones with a package.json,
  and **Use this folder** fills the field. Reading shows its progress on one
  line; what was read comes back as a card with its facts on the left and what
  the package says about itself on the right, with **Not this one** and
  **Install** (and a second card, **Install anyway**, when the two disagree).
  Installed plugins are rows: the icon (the market's, once Browse has been
  opened, when it is listed there), name, version, agents waiting to be
  accepted, who made it, where it came from and what it adds; then **Update to
  <version>** when withbuddi.com lists a newer one, **Open** for its page, its
  state (loaded, disabled, did not load) and a ⋯ menu. A disabled row is
  dimmed. A row opens a sheet with the rest: where it came from, who published
  it, its integrity, the hosts it talks to, what it reaches in buddi, and the
  agents it proposes with **Accept**; its foot has **Remove…**, **Open**,
  **Disable…** or **Enable**, and **Update** (or **Check for an update**).
  Disable and Remove ask in a small dialog; Remove can also drop the plugin's
  data, once you type its name, and offers **Disable instead**. **Ships with
  buddi**, folded, names the plugins compiled in and how many tools each adds.
  **Browse** is the plugin list from withbuddi.com, fetched through buddi only
  when you open the tab and kept a day: a search field, filter chips (All,
  **Recommended** — the plugins buddi publishes that you do not have — and each
  category: Your days, Money, Voice, Work, Home, Other), and one grid of cards
  with who made it, how it is trusted and what you have installed. A card opens
  a sheet with its screenshot, the package, its tools (how many run without
  asking and how many ask you first), the hosts it talks to, what it reaches in
  buddi, its dependencies, and its licence and price. The icons and screenshots
  come through buddi, which keeps them beside the list; the page never fetches
  withbuddi.com itself. **Install** stages the listed version and takes you to
  Installed, where the staged card and its approvals are the same as any
  install; a newer listed version shows **Update to <version>**, there and on
  the installed row, and the Installed tab counts them. A link from
  withbuddi.com, `#/settings/plugins?install=<npm name>@<version>`, opens
  Installed and stages that version at once; `#/settings/plugins?tab=browse`
  opens Browse. A plugin's own settings tabs follow it (see [Plugin
  pages](plugin-pages.md)).

## Notifications on the dashboard

A `now` message that arrives while you are on the dashboard shows as a card at
the top right, three at most. Seeing it there means it is not sent to your
phone ten minutes later. What you have not seen yet is listed on Home under
Needs you. See [Notifications](notifications.md).

## Keyboard

- **Enter** sends, **Shift+Enter** starts a new line.
- **/** outside a field focuses the page's composer (Home's, the chat's); on
  a page without one it opens the corner chat. **Alt+/** opens or closes the
  corner chat from anywhere, and **Escape** closes it.
- **Up** in an empty composer brings back what you sent before; **Down** and
  **Escape** go back to your draft.
- In a group chat, `@` offers the members; **Enter** or **Tab** picks one.
- **Delete** closes the selected canvas tab.
- In the Settings list, the arrow keys, **Home** and **End** move between
  sections.
