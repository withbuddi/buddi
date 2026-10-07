---
title: "Telegram: the phone in your pocket"
status: reference
updated: 2026-09-27
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
- **Settings → Telegram.** Its own page saves or replaces the
  token, lists the phones you paired, unpairs one, and pairs another with the
  same QR code.
- **`buddi telegram pair`** does the same from a terminal.

`/devices` in the chat lists what is paired. A phone you unpair stays
unpaired until you pair it again.

The old `.env` lines `TELEGRAM_OWNER_USER_ID` and `TELEGRAM_OWNER_CHAT_ID` are
no longer read. An installation that had them pairs that account once, at
the first start of this version, and records it; after that the lines are
ignored and `buddi doctor` warns until you delete them.

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
  end-of-day message, following your focus and choices on Settings →
  Notifications (see [Notifications](notifications.md)).

## What you can send

- **Text.** Talk to the active agent, or start with `@handle` to ask another
  agent one message without switching.
- **Photos and documents.** A receipt, a statement, a CSV. They are saved to
  [Files](files.md) and handed to the agent; a caption is your message. A
  file over 20 MB is refused, because Telegram will not hand a bot anything
  bigger.
- **Voice notes.** Heard and answered, when the speech plugin is set up (see
  [Voice](#voice)). Without it they are saved, and the reply says how to have
  them heard.

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
| `/focus [dnd\|urgent] [1h\|3h\|until tomorrow\|until off]` | Switches a focus for notifications: `dnd` is Do not disturb, `urgent` is Urgent only; `1h`, `3h` (any number of hours up to 24), `until tomorrow` (08:00 on your clock) or `until off`, the default. `/focus off` turns it off, and whatever waited arrives as one message. `/focus` alone says what is on and until when, and the words it takes ([Notifications](notifications.md), "Focus"). |
| `/files` | The last files you sent. |
| `/where` | The dashboard address when your phone can reach it; otherwise says it is on this computer only. |
| `/browser` | Where the screen stands; `stop`, `resume` or `release` it. |
| `/voice [spoken\|always\|off\|voice\|both\|text]` | Voice replies. When: a voice note back when you send one (spoken, the default), every answer (always), or never (off). What: the voice note alone (voice, the default), or with the text (both); text is off. `/voice` alone says which. |
| `/host`, `/hoststop`, `/hostrevoke` | Host execution permissions and running commands. |
| `/devices` | The devices paired to this installation. |
| `/reset` | Starts a fresh conversation with the active agent. |
| `/id` | Your numeric user id and this chat id. |
| `/help` | The list above. |

The menu shows these to paired chats only; `/use` names the active agent.

Asking for a web page from the phone works best when the agents have a
browser of their own (Settings → Browser & apps, "buddi's own
browser"): it never hands a page back to you. In your own Chrome through the
extension, a slow page makes the agent wait and look again; control pauses
only when the tab closes or the page fails to answer three times in a row,
and then `/browser resume` gives control back.

## Examples

What the chat looks like, with an agent called ledger. Buttons are in
brackets.

**A question.** The answer replaces the "Working on it" line as it is
written. Once the bot has made its sticker set (`buddi_working_by_<bot
username>`, on the paired owner's behalf, the first time it is needed), a
thinking-Blob sticker stands in for that line and is deleted when the answer
arrives as its own message; if the sticker cannot be sent, the line comes back.

```text
You:    What did I spend on food last month?
ledger: ⏳ Working on it…
        (the same message, a moment later)
ledger: $612 on food in August, $80 more than July. Most of the
        difference is restaurants. Want the list?
```

**A file coming back.** After the answer, a picture arrives as a photo with
its name as the caption; anything else as a document under its own name.

```text
You:    Send me August as a spreadsheet.
ledger: Here it is: every August transaction, one row each.
        [document] august-2026.csv
```

**An approval card.** The tool, the preview it drew, who asked and when the
request lapses. Only the buttons decide it.

```text
ledger: Approval needed — email.send

        To: landlord@example.com
        Subject: September rent

        Asked by ledger. Expires 2026-09-27.
        Action 3f1c…
        [✅ Approve] [✖ Reject]
```

Once decided, the same message reads "Approved and done — email.send" (or
"Rejected — email.send") and loses its buttons.

**`/goals`.** Read only, one line per open goal.

```text
You:    /goals
buddi:  Your goals:
        Pay off the card: $1,240, on track
        Gym twice a week: 1 of 2 this week, behind
```

**A reminder arriving.** When a reminder is due, the agent that set it first
checks it still matters, then writes one short message. A reminder about
something already done is not sent.

```text
ledger: The card payment is due tomorrow.

        $1,240 on the Visa. Your checking account covers it.
```

**A proposal card.** It waits for the end of your day, then arrives with
Keep and Discard.

```text
ledger: ledger proposes a skill: monthly-close

        When: the owner asks to close a month

        You asked for the same three checks at the end of July and August.

        Kept, it becomes a skill ledger follows next time.
        The whole of it is on the dashboard, under Proposals.
        [Keep] [Discard]
```

## Voice

With the [speech plugin](speech.md) installed and listening set up on
Settings → Speech, a voice note is transcribed and the agent answers as if
you had typed it:

```
you:    (voice note, 0:04)
buddi:  (voice note, 0:05)
```

Nothing is echoed back to the chat: the transcript is your message in the
conversation, where the dashboard shows what was heard. A caption under your
voice note is added after the transcript. Only the transcript reaches the
model, with the language it was heard in ("The owner spoke in French."), so
the agent answers in that language; the recording stays in your Files. When
the note cannot be transcribed, one line says so.

Two choices decide the answer, per chat with `/voice` or on **Settings →
Speech → On Telegram** (the two are the same setting):

- **When.** `/voice spoken` (the default) answers a voice note with one;
  `/voice always` speaks every answer, typed questions included; `/voice off`
  keeps every answer text.
- **What.** `/voice voice` (the default) sends the voice note alone, with no
  caption and no text; `/voice both` puts the text in its caption, or right
  under it when the text is longer than 1,024 characters. `/voice text` is
  the same as `/voice off`.

The agent knows it will be read aloud and keeps to two or three short
sentences, and what is spoken is rewritten for the ear first: handles read
as names, dates and amounts as words, links as their site, no markdown or
emoji ([Speech](speech.md#text-for-the-ear)). Cards, questions, proposals
and answers with buttons stay text, and an answer over 4,000 characters is
sent as text only.

When the voice cannot be made (speaking is not set up, or Kokoro on this
computer is asked for a language other than English), the answer comes as
text and, once a day, one line says why. Transcribing and speaking count
against the speech plugin's daily limits, and run without an approval card:
they are you, acting in your own chat.

Without the speech plugin, or with listening not set up, a voice note is
saved and the reply says where to fix that.

## Short answers

Agents know you read Telegram on a phone: they lead with the point, keep to a
few short sentences, and offer detail rather than giving it. Ask for more
and you get more. Replies preserve bold labels, lists and clickable source names.
Light Markdown is converted to safe Telegram HTML; source links stay on their
labels instead of expanding into long URLs.

## Reactions

React to an agent's answer and buddi takes it as feedback, not a command.
The bot asks Telegram for `message_reaction` updates; only your own
reactions, in your paired private chat, count, and anyone else's are dropped
silently.

- 👍 ❤️ 🔥 👏 🎉 🙏 count as good, 👎 💩 🤮 as not, any other emoji as
  neutral. Each is recorded against that answer, the run behind it and the
  agent (`core.message_feedback`, source `telegram`), and shows under the same
  message on the dashboard. Taking the reaction back clears it.
- The bot answers a reaction with nothing. The one exception: a 👎 gets a
  single "What was off?" as a reply to that answer, once per answer, ever.
  Use Reply on that question within six hours and your words are kept as the
  note on the 👎 (the bot marks it 👌), not sent to the agent. Anything else
  you write is an ordinary message.
- The weekly learning digest counts reactions per agent and lists the 👎
  notes ([learning.md](learning.md) §5).

Answers sent before this existed, cards, and your own messages carry no
feedback.

## Sign-in cards

An agent that needs a sign-in buddi does not have asks for it with a card
(`secret.request`, [owner-secrets.md](owner-secrets.md) §6). Telegram is not a
place to type a password, so the card collects nothing here: the answer ends
with **"Open the dashboard to save the sign-in for wikipedia.org"** and the
dashboard link to that conversation (when buddi knows its public address), and
the one button is **Decline**. Save it on the dashboard, where the same card
stands with the fields as inputs; the agent carries on there. Decline tells the
agent the owner turned the card down (`{ declined: 'cancelled' }`), never the
word "Decline" as a message to act on. Nothing you type in this chat is ever
saved as a secret.

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
- A voice note is heard up to 25 MB with a cloud listener, and up to ten
  minutes with Whisper on this computer.

## What leaves this computer

Everything in the chat goes through Telegram's servers (`api.telegram.org`):
your messages and files on the way in, the answers, files, tables and cards
on the way out. The bot token is kept in the vault. Nothing else about buddi
is sent to Telegram.

A voice note is also sent to your listening service and a spoken answer's
text to your speaking service when those are cloud accounts; with Whisper and
Kokoro on this computer neither leaves it (see [Speech](speech.md)).

A tool whose view says it leads with media (host API 1.33, `messenger` in
[plugins.md](plugins.md) §2.5) — opening a story, playing a saved edition —
sends its picture or recording first: a picture its plugin keeps on this
computer, with the caption the plugin wrote, or a recording already saved.
The full answer follows as a new message below it. A missing picture or
recording leaves the text answer as it is; nothing is fetched from a remote
address on the way.

If Telegram ever refuses a formatted answer, the same words are sent again as
plain text, so an answer is never lost to its formatting.
