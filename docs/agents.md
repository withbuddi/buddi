---
title: "Agents"
status: reference
updated: 2026-09-27
---

# Agents

An agent is a file: an `agent.md` whose frontmatter names it (`id`, `handle`,
`name`, `description`), lists the tools it may call and, optionally, its
roles and language, and whose body is its persona. Procedures it follows sit
beside it in `skills/`. Your agents live in your private agents directory;
Agent Father writes them there, and every write waits for your approval.

## Starter team

A fresh install has two agents: the front desk and Agent Father. To show what
another agent adds, which is its own memory, its own tools and work that runs
on a schedule, buddi ships a starter team you add in one tap.

| Agent | What it does | Needs | Arrives with |
|---|---|---|---|
| Scout | Reads the web, gives a second opinion, watches pages you name. | a brain | — |
| Planner | Keeps your day: reminders, follow-ups it remembers, a brief every morning. | a brain | Morning brief, 08:00 in your timezone |
| Keeper | Remembers one domain's history you choose: the car, the house, a project. | a brain | — |

Their grants stay inside what a brain alone allows: Scout holds `memory.*`,
`reminder.*`, `web.*` and `browser.status`; Planner `memory.*`, `reminder.*`
and `schedule.*`; Keeper `memory.*` and `reminder.*`. None of them reaches
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
never rewrites it. The × on a card dismisses it for good. Agent Father sees
the same catalogue under the source `buddi` (`platform.plugin_agents`) and
can add one when you ask it to.

The files ship in `packages/gateway/src/agents/starter/<id>/`: an `agent.md`
and its skills, each an ordinary agent you can read before adding it.
