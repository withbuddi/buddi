---
title: "Telegram: the phone in your pocket"
status: reference
updated: 2026-09-26
---

# Telegram: the phone in your pocket

buddi on Telegram is a private chat with your own bot. It is for the things a
phone is good at: a quick question, a decision, what happened while you were
away. It is not a second dashboard. Anything that needs a screen answers in
one line with where it lives on the dashboard, and a link when your phone can
reach the dashboard.

Only private chats are served, and only from the Telegram account you paired.
A stranger who finds the bot gets no answer and no command menu.

## Pairing

You need a bot of your own: ask @BotFather for one and keep the token it
gives you. Then pair your phone in any of three places:

- **First run.** The wizard asks for the token and draws a QR code; scan it
  with your phone and the chat opens paired.
- **Settings → Notifications.** The Telegram panel saves or replaces the
  token, lists the phones you paired, unpairs one, and pairs another with the
  same QR code.
- **`buddi telegram pair`** does the same from a terminal.

`/devices` in the chat lists what is paired.

## What arrives

- **Answers.** The agent's reply streams into one message as the model writes
  it: a "Working on it" line first, then the text, updated at most every 1.5
  seconds. The last update is the whole answer. An answer longer than 4,096
  characters keeps its first part in that message and continues in new ones,
  split between paragraphs.
- **Files.** Files a run saved come after its answer: pictures as photos,
  everything else as documents under their own names.
- **Tables.** A table an agent draws arrives as monospace text when it fits
  one message, and as a CSV named after the table when it does not.
- **Cards.** Approvals, questions, proposals and offered next steps come with
  buttons. A card is decided only by its buttons: typing "yes" decides
  nothing. Proposals (a skill, a rule for a plugin, a change to an agent's
  file) wait for the end of your day, then arrive as cards with Keep and
  Discard.
- **Notifications.** Reminders, reports, what a watcher found, and the
  end-of-day message, following your quiet hours and choices on Settings →
  Notifications (see [Notifications](notifications.md)).

## What you can send

- **Text.** Talk to the active agent, or start with `@handle` to ask another
  agent one message without switching.
- **Photos and documents.** A receipt, a statement, a CSV. They are saved to
  [Files](files.md) and handed to the agent; a caption is your message. A
  file over 20 MB is refused, because Telegram will not hand a bot anything
  bigger.
- **Voice notes.** Saved, but not listened to yet: say in a line what it was
  about.

## Commands

| Command | What it does |
| --- | --- |
| `/agents` | Lists the agents; tap one to switch. |
| `/use <handle>` | Switches to an agent. |
| `/whoami` | Says which agent is active. |
| `/new` | Makes a new agent: the maker interviews you. |
| `/status` | Where you stand right now, from the agent that holds the overview role. |
| `/recap` | Runs the recap mission now. |
| `/missions` | The next five scheduled missions, with their times and agents. |
| `/goals` | Each open goal, its latest number (or this week's count) and one word: on track, behind, ahead or not measured. |
| `/reminders` | What the agents have put on the clock, with a button to cancel one. |
| `/approvals` | Anything waiting for your approval. |
| `/quiet [1d\|1w\|off]` | Stops proactive messages for a while (7 days by default). |
| `/files` | The last files you sent. |
| `/where` | The dashboard address when your phone can reach it; otherwise says it is on this computer only. |
| `/browser` | Where the screen stands; `stop`, `resume` or `release` it. |
| `/host`, `/hoststop`, `/hostrevoke` | Host execution permissions and running commands. |
| `/devices` | The devices paired to this installation. |
| `/reset` | Starts a fresh conversation with the active agent. |
| `/id` | Your numeric user id and this chat id. |
| `/help` | The list above. |

The menu shows these to paired chats only; `/use` names the active agent.

## Short answers

Agents know you read Telegram on a phone: they lead with the point, keep to a
few short sentences, and offer detail rather than giving it. Ask for more
and you get more. No markdown: the chat shows plain text.

## What stays on the dashboard

Settings, editing an agent, installing a plugin, the library, charts and the
canvas, groups, and any mission or goal you want to change. `/missions` and
`/goals` only read. Links point at the dashboard only when
`BUDDI_WEB_PUBLIC_ORIGIN` names an address your phone can open (a tailnet
name, for example).

## Limits

- 4,096 characters per message, Telegram's own. Longer answers continue in
  new messages.
- 50 MB per file buddi sends. A bigger file is named in one sentence that
  points to Files on the dashboard.
- 20 MB per file you send.

## What leaves this computer

Everything in the chat goes through Telegram's servers (`api.telegram.org`):
your messages and files on the way in, the answers, files, tables and cards
on the way out. The bot token is kept in the vault. Nothing else about buddi
is sent to Telegram.
