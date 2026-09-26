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

## The rail

The column on the left holds the places: **Home**, **Chat**, **Agents**,
**Activity**, **Files**, then the pages plugins add (such as **Mail** and
**Goals**), and **Settings** at the foot. The place you are on is filled and
marked. Home carries the rail's only count: the things waiting on you. Settings
carries a dot, without a number, when a newer buddi is ready.

Under Settings is your initial. It opens a small menu: the theme (Light, Dark,
System), a way to Appearance, and the running version, `buddi <version>`. When a
newer one is out it says "A newer buddi is ready" with its number, and a click
goes to Settings → System to upgrade.

## Home

The page the dashboard opens on. It answers three questions in order: what
needs me, what is my team up to, what is coming.

- **The greeting** says the day and counts what needs you.
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
budget, language, thinking) and **Access** (roles, the tools it may call, and
who it may ask).

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
- **Appearance**: theme, background and page width, kept in this browser.
- **Notifications**: where messages go, quiet hours, the end of the day, and
  the last twenty sent. Also where Telegram is paired.
- **Memory**: what the agents have kept about you, and the means to correct it.
- **Proposals**: what the agents learned, to keep or discard.
- **Model accounts**: the credentials the agents run on.
- **Computer & browser**: whether agents may act on this Mac, which apps, and
  which browser.
- **Keys and secrets**: your vault, and where each secret may be used.
- **Watchers**: the checks plugins run on a schedule, with a switch each.
- **Backup**: nightly backups, one now, a check, the passphrase, and restore.
- **System**: the version and upgrade, pausing the queue, this host.
- **All plugins**: what is installed, and installing one. A plugin's own
  settings tabs follow it (see [Plugin pages](plugin-pages.md)).

## Notifications on the dashboard

A `now` message that arrives while you are on the dashboard shows as a card at
the top right, three at most. Seeing it there means it is not sent to your
phone ten minutes later. What you have not seen yet is listed on Home under
Needs you. See [Notifications](notifications.md).

## Keyboard

- **Enter** sends, **Shift+Enter** starts a new line.
- **Up** in an empty composer brings back what you sent before; **Down** and
  **Escape** go back to your draft.
- In a group chat, `@` offers the members; **Enter** or **Tab** picks one.
- **Delete** closes the selected canvas tab.
- In the Settings list, the arrow keys, **Home** and **End** move between
  sections.
