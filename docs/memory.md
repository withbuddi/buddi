---
title: "Memory and the people in your life"
status: reference
updated: 2026-10-03
---

# Memory

What your agents keep about you lives in the `memory` plugin
(`packages/tools/memory`), in three kinds kept apart: **preferences** you
stated (one current value each, corrected by revision), **notes** an agent
wrote with provenance (who, from which conversation, a scope, an optional
expiry), and **people**. All of it is context, never permission: nothing in
memory authorises an action or stands in for the owner asking.
[architecture.md](architecture.md#memory) has the rules; Settings → Memory
shows everything, with People first.

## People

A person is a name, who they are to you ("wife", "accountant"), how to address
them ("Mum"), a birthday and an anniversary (day and month, the year optional)
and a few notes. One live person per name, whatever the case.

- **Every agent reads them**, one line each, after your stated preferences and
  before the notes, in their own room so a long life of notes never pushes
  them out: `- Marion: wife; birthday 14 March (in 5 days); anniversary 21 June 2014`.
  The soonest dates come first, at most 40 people. Notes are left out of that
  line; `memory.people` returns them when an agent looks someone up.
- **Agents add and change people with `memory.person`.** It is kept at once
  only when you named the person in the very message the agent is answering,
  in an authenticated turn (dashboard, Telegram, terminal), with nothing
  untrusted in view (no page, mail or file) and not as a colleague's delegate.
  Anything else — a mission, a watcher, a person read in a mail, a name the
  agent inferred — becomes a card on Settings → Proposals and in Needs you
  ("Remember Ben: brother, birthday 9 October."), kept or discarded like any
  rule (a card learned from untrusted text is marked so). Keeping it writes the
  person. Several open cards fold into one "Keep all".
- **The notes you already had** are read once, at the first start with People:
  every person a live note names ("Marion is your wife", "the owner's brother
  Ben", "Ben, the owner's brother, …") who is not in People yet becomes such a
  card, with the note it came from and a birthday a note gives for them.
  Nothing is added until you keep it, and the look never runs again
  (`memory.meta`).
- **Settings → Memory → People** lists them with who they are, the birthday,
  the next date ("Birthday in 6 days · turns 35") and a bell when their
  reminders are on; the cards waiting to be kept sit above the list. The sheet
  edits every field, switches "Remind me of their dates", and Forget… removes
  the person (and their reminders) after asking, with Undo; notes that mention
  them stay. `memory.forget_person` does the same for an agent when you ask.
- API: `GET/POST /api/memory/people`, `POST /api/memory/people/:id/forget` and
  `/restore` ([api.md](api.md)). Schema: `memory.people`, soft-deleted like a
  note.

## Dates buddi acts on

Yearly dates are missions on the front desk, kept in step with what you wrote
(at start, every five minutes, and at once after a save):

- **Your birthday** (`owner-birthday`), set on Settings → Profile. On by
  default; the switch is yours on Missions afterwards. First thing on the day,
  08:00 in your zone, the front desk writes a short note from the team, signed
  by them; when an agent can draw (an Illustrator holding `image.generate`) and
  the image plugin has an account, it asks for one picture first. The note
  reaches you on Telegram and sits on Home all day under "Happy birthday,
  <name>.", the picture beside it; × puts it away for the day. Every agent is
  also told, in your context, that today is your birthday.
- **Each person with a date** (`person-dates:<id>`, "Marion's birthday"). Off
  until you turn it on, in the person's sheet or on Missions. A week before
  and on the day, at 09:00, the front desk tells you — who, what, how old or
  how many years when the year is known — and offers to find something (and,
  on the day, to draft a message). Forgetting the person or clearing their
  dates removes it.

The schedule fires on a few candidate days a year (29 February also on the
28th); a run that is not on one of its days stops before any model is called
and stays silent.

The morning brief (Chief of Staff) and the front desk read all-day calendar
events the same way: "Happy birthday!", "Anniversary", "Marion's birthday" are
called out as occasions, in words, never listed as events with a time.
