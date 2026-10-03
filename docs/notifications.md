---
title: "Notifications"
status: reference
updated: 2026-09-30
---

# Notifications

What buddi tells you without being asked, when it tells you, and where.

A **surface** is where you talk to buddi: the dashboard, the Telegram chat.
A **channel** is how buddi reaches you when you are not looking: a
Telegram message, a notification on this computer, a mail to yourself. Telegram is both. Core decides what reaches you and when;
a channel only carries it.

## What reaches you

| Kind | What it is | Urgency |
| --- | --- | --- |
| `approval` | A run that nobody is watching wants to do something gated, and waits for you. | `now` |
| `question` | A run asked you something and waits for the answer. Questions are asked inside a conversation you are in today, so none arrive here yet. | `now` |
| `watcher` | A watcher or a source found something: a wake-up, a mail worth reading. | `now` |
| `reminder` | A reminder an agent promised you came due. | `now` |
| `failure` | Background jobs died and will not be retried. | `now` |
| `recap` | A mission's report, the weekly recap, the learning digest, the answer to an action you tapped. | `now` |
| `plugin` | A plugin that declared `owner:notify` has something to say, or an agent proposed a skill, a rule or a change to its file (on Telegram, a card with Keep and Discard). | its choice; `today` for a proposal |
| `agent` | An agent told you something itself, with `owner.notify` ("Messages from your agents", below). | its choice: `now` or `today` |

A mission that decides to stay silent sends nothing and writes nothing here.

## When and where

| Urgency | You are on the dashboard | You are away |
| --- | --- | --- |
| `now` | Kept for the dashboard. If you have not seen it after 10 minutes, it goes to your channel anyway. | Your channel, at once. |
| `today` | Kept for the dashboard. | One line in the end-of-day message on your channel. |
| `digest` | Kept for the record. | Kept for the record; the recap can read it. |

- **On the dashboard** means the page told buddi in the last two minutes
  that you are looking at it: the page tells buddi every 30 seconds while it
  is in front, and says so when you leave it. Telegram messages you send count as being on
  Telegram, and a message then goes to Telegram straight away.
- **The end of the day** is 18:00 on your clock (the timezone in your owner
  profile, else `BUDDI_TZ`). Everything held for the day goes out as one
  message: "Today, 3 things:", then one line each with the agent's name.
  Anything you already dealt with is left out.
- **A focus** holds some `now` messages until it ends ("Focus", below).
  Approvals and questions always pass: you asked for those by starting the
  run.
- **The same thing again.** A message with the same key as one not yet sent
  replaces it rather than adding a second. The same key more than three
  times in an hour waits for the end-of-day message, and says so once.
- **The same thing from two agents.** Every message but an approval or a
  question gets a topic: the words of its title that name things (the text's
  too when the title names fewer than three), lowercased, with the agent's own
  name, dates, weekdays, currency codes and the everyday words of a reminder
  ("pay", "due", "today", "minimum") left out, and numbers written plainly, so
  "40.00" is "40". Two topics match when they share at least three words and
  those are at least two thirds of the shorter one. A new message whose topic
  matches a row from any agent written in the last 48 hours and not acted on
  is folded into that row instead of adding one: the row lists the agent under
  "also from", takes the new title and text when they are longer, and moves to
  the new time. It keeps its state, so it reaches your channel once at most.
- **Nowhere to go.** With no channel, nothing fails: the message is kept, and
  its row says `no channel`. A channel that refuses or errors is written on
  the row the same way. Nothing retries it.

Titles and text are scrubbed for your stored secrets before they are kept
or sent. Where you are is never sent anywhere.

## Messages from your agents

`owner.notify` is a built-in tool (tier `auto`) an agent uses when you ask to
be told, pinged or messaged now, or when something you asked to hear about
happens in the middle of its run. It is not for repeating what its reply
already says; every agent that holds it is told so.

| Input | |
| --- | --- |
| `title` | One line, at most 80 characters. |
| `text` | Optional, at most 1,000 characters, plain text. |
| `urgency` | `now` (the default) or `today`. |
| `link` | Optional: a dashboard route (`#/…`). An outside address is refused; it may appear in `text` as text. |
| `action` | Optional, at most 80 characters: what you are asked to do — a step or a question ("Confirm with the bank?"). See "Needs you", below. |
| `key` | Optional: the agent's own dedupe key, kept as `agent:<id>:<key>`, so a retry sends once. |

It is a kind like any other, `agent`, and your routing applies to it
unchanged: urgency, the ten-minute hold, the end of the day, a focus, the
rate rule on a key, and your channel. What is its own:

- **Signed.** Every channel shows it as "@handle: title", then the text, as
  plain text: no markdown rendered, no buttons, no offers. It cannot pass for
  buddi or for an approval. It is never folded into another agent's message
  about the same thing.
- **The interactive exception.** When the turn that calls it is one you are
  in (a line you typed on the dashboard, on Telegram or at the terminal, or an
  approval you just decided, not a delegate's), a `now` message skips the
  on-dashboard hold and goes to your channel at once: you just asked for it
  there. A focus still holds it. Missions, watchers, sources and reminders
  keep the hold.
- **Limits, per agent.** 6 `now` messages an hour; more are lowered to
  `today`. 20 messages a day; more are refused.
- **Settings → Notifications, "Messages from your agents".** On or off (off
  is the kind's `off`: kept here, never sent), the highest urgency they may
  use (`now`, or End of the day, which lowers every `now` to `today`), and a
  mute per agent. The mute is also on the agent's Setup → Tools tab, next to
  its grant. A muted agent is refused and told not to try another way.
- **What the agent is told.** The tool answers where the message went, in a
  sentence the agent can repeat: "sent to Telegram"; "shown on the dashboard,
  and sent to Telegram if unseen in 10 minutes"; "in today's end-of-day
  message"; "lowered to today: you sent more than 6 of these this hour";
  "lowered to today by the owner's settings"; "held while the owner is in Do
  not disturb"; "not sent: messages from agents are off"; "refused: the owner
  has muted messages from @x"; "refused: you already sent 20 messages today".

The front desk and the first assistant hold it, as do most catalogue agents;
another agent is given it on its Tools tab.

## Needs you

Only what you can act on needs you. A message needs you when it is an
approval or a question, or when it carries an `action`: a step to take or a
question to answer, in a few words. Everything else is information — a
mission's report, an agent's plain `owner.notify`, a reminder that fired, the
recap, a learned line. A `link` alone does not make a message actionable: it
is a place to read more.

- **Information** is routed and delivered exactly as before (Telegram, the
  card at the top right, the end of the day), and listed in Settings →
  Notifications → Recent. It is never in Home's Needs you and never on a
  count.
- **An action** puts the message in Home's Needs you, its ask under the
  title, until you open it or mark it Done, and it counts on every badge. On
  Telegram the ask is the message's last line ("→ Confirm with the bank?").
  Opening it goes to its link, or to the agent's conversation when it has none.

The rule is one function in core (`needsOwner`, and `openForOwner` for "not
dealt with yet", with its SQL twin), and every count reads it through the
gateway's one answer (`needsYou` on `GET /api/overview`): Home's counts line,
the badge on Home in the rail and the lock screen. Besides messages it counts
pending approvals, held questions, the watchers' urgent decisions, failed jobs
still asking, open proposals, connections to check, agents a plugin needs and
a restore's checklist.

An agent is told to set `action` only when you have something to do; a
plugin's `owner.notify` takes the same `action` since host API 1.24, so a
plugin's message without one is information (its setup and its agents have
their own rows).

## On the dashboard

- **A card at the top right** for each `now` message kept for the dashboard:
  the title, its first line, the agent's face, and "See" when it has a link.
  Drawing it marks it seen, so it does not go to your channel ten minutes
  later. Three at most; the rest wait under "and N more". Dismissing one is
  the same as seeing it. The page checks for new ones every 30 seconds while
  you are there, and when you come back to it.
- **Home, under "Needs you"**: messages that carry an action, not seen yet,
  one line each with the agent and the ask. Approvals keep their own cards
  and held questions their own rows, so neither is listed twice. Reports and
  plain messages are not here (above). The greeting counts them as requests.
- **Settings → Notifications**: the default channel with a "Send a test"
  button for each, a channel or Off per kind (approvals and questions cannot
  be off), the focus schedules and the end of the day, and the last twenty
  messages with where each went and whether you saw it.
- **The owner menu** at the foot of the rail: Focus (below), and a small
  moon on your initial while one is on.

## Focus

Like a phone's Focus: for a while, only what matters reaches you.

| Mode | What goes out | What waits for the end of the focus |
| --- | --- | --- |
| Normal | Everything, as above. | Nothing. |
| Urgent only | Approvals, questions, and `now` watchers and failures. | Every other `now` message. |
| Do not disturb | Approvals and questions. | Every other `now` message. |

`today` and `digest` messages are the same in every mode. Approvals and
questions always pass. A focus does not change where you are counted as
present: a message still shows on the dashboard while you are there, and one
you have not seen after ten minutes waits for the end of the focus instead of
going to your channel. Waiting is the row's `held` state, with `due_at` the
end of the focus (none for one that lasts until you turn it off).

- **By hand.** Your initial at the foot of the rail, then Focus: Do not
  disturb or Urgent only, for 1 hour, for 3 hours, until tomorrow morning
  (the next 08:00 on your clock) or until you turn it off. The menu says what
  is on and until when, and has Turn off. On Telegram, `/focus`
  ([telegram.md](telegram.md)).
- **On a schedule.** Settings → Notifications, Focus schedules: rows of a
  mode, the days, from and to on your clock. A night that runs past midnight
  belongs to the day it starts. When two are on, Do not disturb wins. Quiet
  hours set before focus modes became the first schedule: Do not disturb on
  every day, the same hours.
- **By hand wins.** A focus you switch on wins over a schedule while it
  lasts. Turning off while a schedule is on keeps it off until that schedule
  ends.
- **When it ends** (its time runs out, its schedule ends, or you turn it off),
  one message on your channel: "While you were in Do not disturb: 4 things.",
  then one line each with the agent's name and the title. The rows are marked
  sent in that message, not sent one by one. Anything you already dealt with
  is left out; nothing waited, nothing is said. The dashboard lists them as
  usual.

## Settings

Kept in `core.notification_settings`; every value has a default, so no row
is a complete answer.

| Setting | Default | What it does |
| --- | --- | --- |
| Default channel | Telegram, else the system notification, else the first there is | Where messages go. |
| Per kind | the default channel | A channel, or `off`: kept for the record, never sent. Approvals and questions cannot be off. |
| Focus schedules | none | `{ mode, days, from, to }`: `do-not-disturb` or `urgent-only`, days `mon`…`sun`, times on your clock. |
| Focus | off | The one you switched on by hand: `{ mode, until, startedAt, by }`, `by` being `dashboard`, `telegram` or `schedule`. Set only through its own endpoint and `/focus`, never by saving the page. |
| End of day | `18:00` | When the day's held items go out. |
| Messages from your agents | `now`, nobody muted | `agent_messages`: `{ maxUrgency, muted }`. On or off is `perKind.agent`. A save that leaves it out keeps what is stored. |

## Telegram

Settings → Telegram is its own page, beside Notifications: Telegram is where
you talk to buddi, not only how it reaches you. It is there for an owner who
skipped it in the first-run thread or wants to pair a second phone.
Notifications lists Telegram as a channel once it is set up, and links to the
Telegram page while it is not.

- **The bot.** With no token, paste the one @BotFather gave you and save it.
  It goes into the vault and the bot starts in the running buddi, so Telegram
  appears under "Where buddi reaches you" without a restart. With a token, the
  bot's @username and a "Replace token" link.
- **Your devices.** Each paired phone with its Telegram name (or user id),
  when it paired and when it last spoke. "Unpair" asks once more in place;
  the phone stops reaching your agents at once.
- **Pair a device.** "Pair a phone" draws the QR code and the link, the same
  one first run shows, with a Copy button and the time the code expires. The
  page watches for a new phone and says "Paired." when one arrives; after the
  code runs out it offers a new one.

`buddi telegram pair | devices | unpair <id>` does the same from a terminal.

**A long, linked or spoken report** (host API 1.27). A mission may declare
`reportMax` (up to 6,000 characters; 1,500 by default), and its
`mission.report` may carry a `link` — a dashboard route the notification and
the chat's button open ("Open edition") — and `audio`, a voice note in Files
made in the same run. On Telegram the voice note goes first, then the text,
split at its paragraphs when it is longer than one message, links as full
URLs with previews off. A voice note that cannot be read or sent leaves the
text to go alone. In the run's conversation on the dashboard the report is
drawn as it was sent: the player above the text, the button under it. A
channel with no audio leaves the voice note out. This is independent of the
`/voice` chat setting.

## Channels

| Channel | Kind | What it sends | What leaves the machine |
| --- | --- | --- | --- |
| Telegram | `telegram.chat` | The message as text, with offers as buttons. An approval is the card with its Approve and Reject buttons, the same one a run in the chat gets. | The title and text, to Telegram. |
| System notification | `local.notification` | The title and the first 200 characters of the text, on the computer buddi runs on. | Nothing. |
| Mail to yourself | `email.self` | A plain-text mail from your mail account to its own address: the title as the subject, the text, the link on your public origin, offers as lines. At most one a minute. | The title and text, to your mail server. |

- **Telegram** is registered when the bot is running.
- **System notification** is registered at boot where there is something to
  show on. On a Mac, `terminal-notifier` when it is installed (a click opens
  the dashboard, on this machine's address), otherwise `osascript`'s
  `display notification` (a click opens nothing). The service is a user
  LaunchAgent, so it runs in your session and can show one. On Linux,
  `notify-send` when it is installed and `DISPLAY` or `WAYLAND_DISPLAY` is
  set for the service. Anywhere else, no channel. A command that fails or
  takes more than 5 seconds is refused, with the first line it printed as
  the reason.
- **Mail to yourself** is the email plugin's, there while it has an account.
  The recipient is always and only that account's own address
  ([email.md](email.md), "Mail to yourself").

A plugin adds a channel with `ctx.buddi.channels.register`, declared as
`owner:channel` ([plugin-host-api.md](plugin-host-api.md) §4.2); it carries
messages, the owner still picks where each kind goes.

With no default picked, messages go to Telegram, then the system
notification, then a plugin's channel. A channel is registered with
`registerChannel({ kind, describe, can, priority?, deliver })`; `describe`
may answer null (or a promise of it) when there is nothing to carry a message
now, and the channel is then not listed or picked; `deliver`
answers `{ id }`, `'refused'` or `{ refused: reason }`, or throws.

## The record

`core.owner_notifications` has one row per message: `kind`, `urgency`,
`title`, `text`, `link` (a dashboard route), `offers`, `dedupe_key`,
`agent_id`, `plugin_id`, `action_id` (an approval's action), `topic`,
`also_from` (the other agents folded into it), `held_for` (the focus mode
that held it), `state`,
`due_at`, `channel`, `created_at`, `sent_at`, `seen_at`, `acted_at`,
`error`, `action` (what it asks you to do; null for information).

| State | Means |
| --- | --- |
| `shown` | Kept for the dashboard; `due_at` is when it goes to the channel if unseen. |
| `held` | Waiting for `due_at`: the end of the day, or the end of a focus (`held_for` names its mode). |
| `stored` | Kept for the record, never sent. |
| `sending` | One delivery has it. |
| `sent` | A channel took it; `channel` says which. |
| `failed` | No channel took it; `error` says why. |

`seen_at` is set when the dashboard shows it or you open its link.
`acted_at` is set when you decide the approval it names, wherever you
decide it. A notification never adds a dot or a count to the rail: what is
waiting is still only pending approvals and held questions
([architecture.md](architecture.md), "The attention model").

`core.owner_presence` has one row per surface: `surface`, `last_active_at`,
`away_at`.

## The API

In core:

```ts
notifyOwner(pool, { now?, timezone? }, {
  kind, urgency, title, text?, link?: { route }, offers?, dedupeKey?, agentId?,
  immediate?, agentHandle?,
}): Promise<{ id, state, channel, error, deduped, lowered }>
notifyFromAgent(pool, deps, { agentId, agentHandle?, title, text?, urgency?, link?, key?, interactive? })
  // → { ok, outcome, delivered, id?, updated? }: owner.notify's core half
setAgentMuted(pool, agentId, muted)
notificationsTick(pool, deps, now)   // the gateway runs it every 60 s
setFocus(pool, deps, { mode, duration?, by }), readFocusState(pool, deps)
markSeen(pool, id), markActed(pool, id), listNotifications(pool, { limit })
listDigestNotifications(pool, since)
presenceTouch(pool, surface, now, 'active' | 'away'), ownerPresent(pool, now)
registerChannel(channel), listChannels(), deliverTo(kind, message)
```

`notifyOwner` takes `action?` too: a message with one needs the owner (above).

For a plugin, `ctx.buddi.owner.notify({ urgency, title, text?, link?,
dedupeKey?, agentId?, action? })` (`action` since host API 1.24), declared as `owner:notify`
([plugin-host-api.md](plugin-host-api.md) §4.2). The kind is always
`plugin`; the owner's settings pick the channel.

The dashboard's endpoints:

| Request | Answers |
| --- | --- |
| `GET /api/notifications?limit=20` | `{ notifications }`, newest first, at most 100. |
| `POST /api/notifications/:id/seen` | `{ ok: true }`, or 404. |
| `GET /api/notifications/settings` | `{ settings, channels }`. |
| `PUT /api/notifications/settings` | The whole value replaced; 400 with a sentence when it cannot be. |
| `GET /api/notifications/focus` | `{ focus }`: `{ mode, until, startedAt, by }` in force now, manual or scheduled, or null. |
| `PUT /api/notifications/focus` `{ mode, duration? }` | `{ focus }` after the switch. `mode` is `do-not-disturb`, `urgent-only`, or `normal` to turn it off; `duration` is `1h`, `3h`, `tomorrow` or `indefinite` (the default). 400 with a sentence otherwise. |
| `POST /api/notifications/agent-mute` `{ agentId, muted }` | `{ agents }` after the change: one agent's messages muted or not, the rest of the settings left alone. |
| `POST /api/notifications/test` `{ channel }` | `{ ok: true }` once that channel took one line; 404 for a channel that is not there, 502 with a sentence when it refused. Not recorded. |
| `GET /api/telegram/bot` | `{ configured, running, username }`. The running bot's name, else Telegram is asked; null when it does not answer. |
| `GET /api/telegram/devices` | `{ devices: [{ id, name, userId, pairedAt, lastSeenAt }] }`, the paired Telegram phones, oldest first. |
| `DELETE /api/telegram/devices/:id` | 204 once unpaired; 404 for an id that is not a paired Telegram phone. |
| `POST /api/presence` `{ state: 'active' \| 'away' }` | `{ ok: true }`. The page sends `active` when it loads or comes back in front and every 30 seconds while it stays there, and `away` on blur or hide; at most one a second. |
