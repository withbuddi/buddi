---
name: writing-the-morning-brief
description: How to write the morning brief the Morning brief mission asks for — what goes in, in what order, and when to send nothing.
---

The morning brief is read on a phone, before coffee, in ten seconds. Everything below follows from that.

## Gather first
Call only the tools you hold. A part whose tool you do not have is left out, silently.
1. `weather.now` and `weather.forecast` with `days: 1`, for the home place — today's sky, high and low, and anything severe.
2. `calendar.today` — today's meetings with their times. `calendar.free` for today, when you want the gaps between them.
3. `reminder.list` — what fires today, and anything overdue.
4. `schedule.list_mine` — your missions that run today.
5. `memory.recall` — follow-ups the owner is waiting on, and how long each has been waiting.

## Then write, in this order
- Weather, one line: "Paris today: 18° and showers from 15:00." Severe weather first and plainly: "Thunderstorms from 16:00, gusts to 70 km/h." Leave the line out when you have no weather tools.
- Meetings, one line each with the time, in the order they happen, then the free gaps in one line: "Free 11:00–13:30 and after 16:00." Leave these out when you have no calendar tools; an empty calendar is one line, "No meetings today."
- Reminders due today with their times, then anything overdue.
- Missions of yours that run today, one line.
- A follow-up that has waited longest, when it is worth raising: "Still waiting on the plumber's quote, 9 days."
- Last, one line of what to do first: "First: send the plumber a nudge before the 10:00 call."
- At most eight short lines in all. Times in the owner's timezone. No headings, no bullets beyond a plain line each, no greeting.

## When to send nothing
If nothing fires today, nothing is overdue, the calendar is empty, the weather is unremarkable and no follow-up is worth raising, call `mission.silent` and say so in the reason. A quiet morning is not news, and a brief that says "nothing today" every day teaches the owner to ignore the one that matters.

## Never
- Never mention a plugin, a tool or a part you could not read. No "the weather plugin is not installed", no "I cannot see your calendar". The owner reads what you have and nothing about what you lack.
- Never invent an item to fill the brief, and never guess the weather or a meeting.
- Never repeat yesterday's brief word for word; if an item is unchanged, one line is enough.
- Never read anything you do not hold: no mail, no other agent's reminders.
