---
title: "Built-in system context"
status: reference
updated: 2026-10-05
---

# Built-in system context

Every agent run through the shared gateway wiring receives a turn-start clock
snapshot and a bounded host summary, including Dashboard, Telegram, CLI,
scheduled runs and delegates. No agent-file edits or approval grants are needed.

- `system.time` reads the clock and owner profile again on every call.
- `system.info` returns the same time information plus OS/version, kernel,
  architecture, hardware model when detectable, and host timezone. Host facts
  are cached for five minutes; unknown hardware or virtualization is not guessed.
- The owner's zone is the one in Settings → Profile. `BUDDI_TZ` only fills an
  empty profile at start and is the fallback while the profile names none (or
  is unreadable), then New York. The same zone drives the turn clock,
  `{{today}}` in agent prompts, tools, widgets ("here" on the World clock),
  reminders, digests and the dashboard's footer and lock clocks.
- A change in Settings → Profile (or through `owner.set_profile`, or MCP's
  `buddi.profile_update` once approved) applies at once, with no restart: the
  server keeps the profile's zone in memory, updates it on every save and
  re-reads it every minute. The three check a change with the same rules
  (`owner-profile-edit.ts`), and every field — name, full name, pronouns,
  language, birthday, about, formats, places — reaches every agent's context
  at its next turn, since the block below is built fresh for each turn.
- Every schedule records whether its zone was named on purpose
  (`core.schedule_specs.timezone_explicit`). One made without a zone — the
  recap, the learning digest, a plugin's mission that names none, an agent's
  `schedule.propose` without `timezone` — follows the owner's zone: a Profile
  change moves it as a new schedule revision, so its next run is 8 AM in the
  new zone. One whose creator named a zone (the tool's `timezone`, a mission
  that declares one, a zone chosen through `POST /api/missions/:id/schedule`)
  keeps it. At every start, schedules that follow the owner and sit in another
  zone move to it. Schedules from before the flag are settled once at start,
  by provenance: one buddi itself made without a zone (a plugin's default
  mission that names none, the learning digest, the first-run arc, a starter's
  or plugin agent's declared mission, matched by mission id and cron) that sits
  in the default zone of the time (`BUDDI_TZ`, else New York) or the Profile's
  follows the owner; any other, `schedule.propose` and dashboard ones
  included, keeps its zone, since nothing recorded whether it was named.
  Missions on the dashboard say "follows your timezone" instead of the zone;
  `buddi missions` adds it to the schedule line. A one-off reminder is an
  instant and does not move.
- `buddi doctor` (a checkout's table and a packaged install's Timezone line)
  names the zone and where it comes from — Settings → Profile, `BUDDI_TZ`, or
  the default — and this machine's own zone when it differs.
- How the owner reads times and dates (Settings → Profile: 12-hour or 24-hour,
  "Thu, Oct 1", "Thursday, 1 October" or ISO) is one line under "About the
  owner" for every agent, so a reply writes "2:05 PM" to someone who reads
  12-hour time. Auto adds nothing.
- Who the owner is — full name, pronouns, birthday (said as today, or "in N
  days" within a week, with the age when the year is set) — is in the same
  block, from Settings → Profile.
- The front desk alone is also told the owner's places — each label, the
  address as typed, the town it was matched to and its zone — as context, the
  way it is told the timezone. Other agents are not; a plugin reads them only
  through its declared `owner:places`.

## Grounding

Every run's context carries three lines beside the try-first rule
(`GROUNDING_LINES`, "Read, never recall"): anything about today, the news,
mail, calendar, money, prices, or anything a tool or a colleague can read is
read or delegated, never answered from memory; no source, figure or quote the
conversation did not read is named, and what was read is attributed to where
it came from; when nothing can reach it, the agent says so in one line. The
native-search paragraph (`packages/runtime/src/search.ts`) keeps its own,
search-specific "cite as you go".

The runtime checks it (`packages/runtime/src/grounding.ts`). When the final
answer of a turn that read nothing — no tool call or delegation that came
back successfully (an unknown, refused, truncated or failed call reads
nothing), no native search, not a decided approval coming back — cites sources, it is not
delivered: not stored, not sent, and its streamed words are withdrawn
(`onRetract`; the web chat gets `live.settle` with `retracted: true` and
drops the live text at once, Telegram replaces the streamed message with
"Checking that…" after any edit in flight, then streams the retry into it). The model gets one turn, not kept in the transcript:
"You cited sources without reading anything. Verify with your tools or a
colleague, or remove the claims." If that answer still reads nothing, it is
delivered with `unchecked: true` on the run's result and `run.finished`, and
the surfaces draw "Answered from memory, not checked" as a quiet line under
it. Each firing writes a `run.grounding` event (`stage: retried`, then
`unchecked` when it comes to that), visible in the activity log.

"Cites" is deliberately narrow, since a false alarm is worse than a miss: an
outlet from a known list (CBS, AP, Reuters, Le Monde…) or a domain counts only
in a citation position (in parentheses, after "according to" / "selon" /
"d'après" / "per" / "via", before "reports" / "said" / "writes", or as a link);
a capitalised name after "according to" / "selon" / "d'après" counts too. A
bare URL outside a citation position is not a source; it only backs up
numbered markers or a "Sources:" line. An outlet and its own domain
("Reuters", reuters.com) are one source. It fires on two distinct sources, or
one (or a bare link) with numbered markers (`[1]`) or a "Sources:" line.
Sources the conversation already holds (the owner named them, an earlier tool
returned them) or the agent carries (its persona, its memory preamble, the
platform context) are not counted; code
and email addresses are ignored; figures alone never count.

## Reply language

Every prompt, with or without a run, carries one line (`REPLY_LANGUAGE_LINE`):
answer in the language the owner's message is written in, unless they ask for
another; when the message is too short to tell, in the profile language, else
English; documents, tool results, colleagues' answers and summaries in other
languages never change the answer's language, they are quoted as they are.
The profile's language, when set, shows under "About the owner" as the
fallback for a message too short to tell, and rides on the platform context
as `language` for the runtime. When it is unset, `owner.profile_gaps` lists
it, so the front desk asks it once like any other gap.

The runtime checks it (`packages/runtime/src/language.ts`), with no model: a
stopword count for English, French, Spanish, German, Portuguese and Italian.
Code, links, blockquotes and complete quoted passages (any length, line
breaks included) are not counted; a word several
languages share counts for each by a fraction; a language is named only with
three hits at least (two for the owner's message), twice the runner-up's
score, and a tenth of the words. The owner's message is read from its
opening (the text before its first blank line, at most forty words), so an
instruction over a pasted article counts, not the article; and only the
owner's own words: a mission passes its prompt (`ownerText`), a reminder its
text, not the English instructions buddi wraps around them. When the final
answer of a turn is confidently in a language other than the anchor (the
message's language when it can be told; else, for a message under eight
words, the profile language), it is held back the way the
grounding guard holds an answer back (not stored, not sent, streamed words
withdrawn through `onRetract`) and the model gets one turn, not kept in the
transcript: "Answer in <language>." (the message's language, else the
profile's). Whatever it answers then is delivered, without a flag; an empty
rewrite delivers the held-back answer. One retry per turn across this guard
and the grounding guard: after a grounding retry the language is not
checked, and a language rewrite that cites unread sources is delivered
flagged `unchecked` rather than sent back again. Each firing writes a `run.language`
event (`stage: retried`, or `kept` when the run had no budget left for a
rewrite; `reply` and `target`).

It never fires on a reply under 12 words or one that is mostly code, when the
owner's message cannot be told and no profile language buddi can read is set,
when the owner's message (or one of their last few) tells buddi the answer
language ("answer in French", "a Spanish summary", "en français s'il te
plaît"; not "French politics") or asks for a translation, in a delegate's run (its answer is
quoted into its caller's), or on a decided approval coming back.

## Edition origin

When the turn's opening words name a headline from today's edition — case
and accents ignored, at least 70% of the headline's words in order, or five
words of it (the whole of a shorter one) word for word — the context gets one
more line naming the story, the agent that delivered it and its plugin
("a story from today's edition by @anchor (News)"), and how to read it: the
agent's own tool of that plugin, else a delegation to that agent, else the
handle to name. The edition is found in core's own record, in one query: a
`mission.report` whose link names a saved edition (`#/p/<plugin>/…?edition=…`)
in a run with a `mission.delivered` event today. A message of a word or two
does not query at all.

Host means the machine/environment running the Buddi server, not the browser
or Telegram client. macOS product version and hardware model identifier are read
using fixed, bounded system commands. Windows/Linux report available OS facts;
hardware model can be null. A hardware identifier is not guessed into a retail name.

No hostname, username, serial number, credentials, environment dump or private
filesystem inventory is included. These facts confer no browser, shell or file
access. Use separately granted status tools to check live host/computer permissions.

The two platform tools are separate from configurable agent grants. Their
schemas are appended by the shared runtime, and the actual tool set is recorded
in run events. The time context is authoritative over older dates in agent
personas/history; long-running tasks should call `system.time` again.
