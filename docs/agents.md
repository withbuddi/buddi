---
title: "Agents"
status: reference
updated: 2026-10-01
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

## New chat after

A chat with an agent rolls over to a fresh conversation when it has sat idle
too long or its transcript has grown too long. The idle time is the agent's
own: `idleRollover` in the frontmatter, `3h` (the default when absent), `1d`,
`1w` or `never`. Set it on Setup → Brain ("New chat after"), with
`buddi agents set <handle> --idle-rollover 1d`, or over MCP with
`buddi.agent_update`'s `idleRollover`. `never` turns off only the idle rule:
a transcript past its budget still rolls over. A plugin's proposed agent may
declare its own default; the Developer agent asks for a day. The fresh
conversation opens with a carried-over note written from the old one
([conversations.md](conversations.md#the-context-budget-follows-the-model)).

## Telling the owner now

`owner.notify` lets an agent message the owner itself, on the channel they
chose ("sent to Telegram"), within limits and settings the owner controls:
6 urgent messages an hour, 20 a day, a switch for all of them, and a mute per
agent on its Tools tab. It is shown as "@handle: title", plain text. The
front desk, the first assistant and most catalogue agents hold it; give it to
another agent on its Tools tab. See [notifications.md](notifications.md),
"Messages from your agents".

## What every agent is told about you

Beside the clock (docs/system-context.md), every agent is told what you set on
Settings → Profile: the name to use, the language, your own few lines, and how
you read times and dates (12-hour or 24-hour, "Thu, Oct 1" or "Thursday, 1
October" or ISO), so its replies match. The front desk is also told your
places — Home, Work and the rest, with the address, the town and its zone — so
"how long to work?" or "the weather at home" needs no explaining. All of it is
context, never an instruction or a grant.

## Placeholders in the persona

The persona may use one placeholder, `{{today}}`. buddi replaces it with the
owner's date, in the owner's timezone, as `YYYY-MM-DD` (`2026-09-30`), fresh on
every turn: a conversation that crosses midnight gets the new date on its next
message. It is filled in wherever an agent runs (the dashboard, Telegram, the
terminal, a mission), by the agent catalog in `@buddi/core`.

It is the only placeholder. Anything else between double braces, `{{date}}` or
`{{owner}}`, stays in the persona as written, so the agent sees the braces
rather than a value.

## The catalogue

A fresh install has two agents: the front desk and Agent Father. Everything
else is picked from the catalogue: ready-made agents buddi publishes on
withbuddi.com beside the plugins, each tested against the plugins it uses.

| Category | Agents (first lineup) |
|---|---|
| Work | Chief of Staff, Researcher, Writer, Illustrator |
| Money | CFO |
| Home | Chef, Home Manager |
| Health | Coach |
| Learning | Tutor |
| Life | Travel Planner |

An agent from the catalogue is configuration, never code: a persona, a few
text skills, the tools it asks for, missions, the picks it asks you, and
three example asks. Nothing in it runs. buddi reads each listing strictly (an
unknown field is refused, and so is a model, a provider, an account or a
delegate) and recomputes its integrity before using it: a listing that does
not hash to what withbuddi.com published is left out. Only listings made by
buddi are offered for now.

**Adding one** is one approval. The plan says what will happen: the plugins it
installs on the way, the picks (a mailbox, the calendars to read, a place, a
mission's hour, a line of text) filled with defaults, the handle (a free one
beside the package's when it is taken: `chef-2`), every tool with its tier,
and its missions. A missing plugin is installed only when it is a by-buddi
listing whose package hashes to exactly what withbuddi.com lists, and loaded
before the agent is written; anything else waits on its card in Settings →
Plugins and the agent is not made. Then the agent file is written: the persona
verbatim, then a short "## For this owner" section from the picks, nothing
else. Your name, language, timezone and places are never written into it,
because every agent is told them on every turn (above). Missions arrive off
unless you turned them on. Its picture comes from the listing, checked
against its hash and re-encoded like an upload. The file is yours from then
on.

Beside the file, `plugin.json` records where it came from: `source:
"market"`, the package and version, the package integrity you approved, the
hash of the file as written, and the picks. That is how buddi tells an
untouched agent from one you edited.

**Updates** are offered, never written on their own. When a newer version is
listed and you have not touched the file, Update shows what changed: the
version's one line, the persona diff, tools added and removed, new missions.
Approving it writes the file again from the new package with the same picks;
a grant that gains tools says so loudly and names them. When you edited the
file, nothing is touched, ever: the card says a new version is out, with
"See what changed" and "Replace my changes" (your file goes to the trash
first). Missions are your rows: an update adds new suggested ones off and
never changes or turns on one you have.

**Removing** an agent moves its directory to the trash beside your agents and
pauses its missions in the same approval. Plugins stay; the preview names the
ones no other agent uses.

**Older agents.** Planner, Scout and Keeper (the starter team before the
catalogue) and Ledger and Illustrator (proposed by the finance and image
plugins) keep working with their handles, files and data. Each maps to its
package (Chief of Staff, Researcher, Home Manager, CFO, Illustrator) through
the package's `replaces`, so the catalogue shows it as added, and offers the
update only while its file is untouched; an update keeps its id and handle,
so @planner and @ledger stay. A new install of CFO is @cfo.

**From chat**, Agent Father reads the catalogue (`platform.catalogue`) and adds
one with `platform.install_agent` (gated, the same plan and preview), asking
the picks in a sentence each. It cannot install a missing plugin; the
dashboard can. Agents an installed plugin proposes (Mail Triage, a third-party
plugin's advisor) are listed beside the catalogue as "from <plugin>" and
added with `platform.accept_plugin_agent`.

**From the terminal**, through the running service: `buddi agents catalogue`,
`buddi agents add <name> [--fill pick=answer]… [--mission id]… [--yes]`,
`buddi agents update <handle> [--replace]` and `buddi agents remove <handle>`
([cli.md](cli.md)). The routes are `/api/catalogue…` ([api.md](api.md)).

What a package may not ask for, whatever it says: the tools that write agents
(`platform.*` writes), `host.*`, `secret.*`, `developer.*`, connection tools
(`mcp.*`), `agent.delegate`, `owner.set_profile`, `email.send` and the
mailbox account tools, and anything owner-only. You can give any of them to an
agent by hand afterwards.

The integrity is `sha256-<base64>` of one canonical JSON document (keys sorted
at every depth, no whitespace): `{ "agent.json": <agent.json without integrity
and claims>, "persona.md": <text>, "skills": { "<file>.md": <text> },
"avatar.png": "sha256-<base64>" | null }`, the same computation as the
market's check (`withbuddi/buddi-market`, `scripts/agents.mjs`).

