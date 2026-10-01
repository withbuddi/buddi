---
title: "Agents"
status: reference
updated: 2026-09-30
---

# Agents

An agent is a file: an `agent.md` whose frontmatter names it (`id`, `handle`,
`name`, `description`), lists the tools it may call and, optionally, its
roles and language, and whose body is its persona. A tool grant names a tool
(`reminder.set`) or a family (`finance.*`); a family nothing installed
provides holds the agent back until its plugin is there. A grant ending in
`?` (`weather.*?`) holds only if provided: missing, it is skipped silently and
the agent loads with the rest. Procedures it follows sit
beside it in `skills/`. Your agents live in your private agents directory;
Agent Father writes them there, and every write waits for your approval.

## Steps per reply

Each tool call an agent makes in one reply is a step. `maxTurns` in the
frontmatter caps them; without it an agent gets 40, which suits chat. Set it on
the agent's Setup → Brain ("Steps per reply", 10 to 500) or with
`buddi agents set <handle> --max-turns <n>`. The Developer agent the developer
plugin proposes asks for 150, since coding spends many steps on one answer. An
agent already installed keeps the number in its file; buddi does not rewrite it.

A reply that uses all its steps stops and says so ("Stopped after 40 steps…").
The dashboard marks it "Turn budget reached" and, under the conversation's
latest reply while nothing is running, offers **Continue**, which sends
"continue" as you so the next run picks up with the whole history. On Telegram
the answer carries a Continue button that does the same once, then goes away.

## Telling the owner now

`owner.notify` lets an agent message the owner itself, on the channel they
chose ("sent to Telegram"), within limits and settings the owner controls:
6 urgent messages an hour, 20 a day, a switch for all of them, and a mute per
agent on its Tools tab. It is shown as "@handle: title", plain text. The
front desk, the first assistant and the starter agents hold it; give it to
another agent on its Tools tab. See [notifications.md](notifications.md),
"Messages from your agents".

## Placeholders in the persona

The persona may use one placeholder, `{{today}}`. buddi replaces it with the
owner's date, in the owner's timezone, as `YYYY-MM-DD` (`2026-09-30`), fresh on
every turn: a conversation that crosses midnight gets the new date on its next
message. It is filled in wherever an agent runs (the dashboard, Telegram, the
terminal, a mission), by the agent catalog in `@buddi/core`.

It is the only placeholder. Anything else between double braces, `{{date}}` or
`{{owner}}`, stays in the persona as written, so the agent sees the braces
rather than a value.

## Starter team

A fresh install has two agents: the front desk and Agent Father. To show what
another agent adds, which is its own memory, its own tools and work that runs
on a schedule, buddi ships a starter team you add in one tap.

| Agent | What it does | Needs | Arrives with |
|---|---|---|---|
| Scout | Reads the web, gives a second opinion, watches pages you name. | a brain | — |
| Planner | Keeps your day: reminders, follow-ups it remembers, a brief every morning. Better with the Weather and Calendar plugins. | a brain | Morning brief, 08:00 in your timezone |
| Keeper | Remembers one domain's history you choose: the car, the house, a project. | a brain | — |

Their grants stay inside what a brain alone allows: Scout holds `memory.*`,
`reminder.*`, `owner.notify`, `web.*` and `browser.status`; Planner `memory.*`, `reminder.*`,
`schedule.*` and `owner.notify`, plus `weather.*?` and `calendar.*?`, which hold only when
those plugins are installed; Keeper `memory.*`, `reminder.*` and `owner.notify`. None of them reaches
mail, money, this computer's shell or the browser's controls. Keeper asks, in
its first message, which domain it keeps, and remembers the answer; its name
on the roster stays Keeper.

The cards appear under "Add a teammate" on the Agents page and under Home's
"Your team" while the team is only the front desk and Agent Father. After
that, the Agents page keeps them behind its "Add a teammate" button. Beside
them are the agents plugins propose: Mail Triage (needs a mailbox), Ledger
(from the finance plugin) and Illustrator (needs the image plugin and an
account that draws). Until their plugin or requirement is there, they are
greyed with the reason and a link to the page that fixes it.

Add is the same accept every agent offer uses: the owner's click approves the
gated `platform.accept_plugin_agent`, whose preview names the whole grant and,
for Planner, the mission. The new agent's file is yours from then on; buddi
never rewrites it. Planner's morning brief reads today's weather and meetings
when those plugins are there and leaves those lines out when they are not; a
Planner added before this gains them with one line in its file: `tools:
[memory.*, reminder.*, schedule.*, weather.*?, calendar.*?]`. The × on a card dismisses it for good. Agent Father sees
the same catalogue under the source `buddi` (`platform.plugin_agents`) and
can add one when you ask it to.

The files ship in `packages/gateway/src/agents/starter/<id>/`: an `agent.md`
and its skills, each an ordinary agent you can read before adding it.
