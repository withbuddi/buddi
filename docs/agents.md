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

## Before saying no

Every agent is told to use what it can reach before it declines, worded for
the tools it holds. A question about a website you use (an account page, a
cart, a statement): an agent with `browser.act` reads `browser.status` and
looks, with your approval for the session. In your own browser ("Your
browser" mode) you are usually signed in already; in buddi's own browser it
signs in with a login you stored in Settings → Keys and secrets (`secret.list`,
then `secret.fill`, which keeps its own approval rules), and when a code or a
challenge appears that no stored TOTP secret answers, it asks you to press
Take over and carries on after. A question that belongs to a colleague it can
delegate to is handed over and the answer relayed, rather than sending you to
ask. Only then does it say exactly what it lacks, with one next step (grant a
tool, pair a browser, link an account). An agent without the browser says it
could look if you gave it browser control and paired a browser.

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

## Skills

A skill is one Markdown file: front matter with its `name` (the file's name),
a `description` saying when it is used, and optionally a `title`; then the
steps. A skill informs an agent's reasoning; it never grants a tool or lowers
a tier. Skills live in two places:

- your **shared skills folder** (`skills/` beside your agents directory):
  every skill you write or upload goes here;
- an **agent's own folder** (`agents/<id>/skills/`): a skill it learned, one
  that came with a catalogue agent, or one you put there by hand. That agent
  always uses it.

**One name, one procedure per agent.** When an agent's own skill has the name
of a shared one (a catalogue agent's packaged skill meeting one a plugin
imported earlier, say), the agent uses its own and not the shared one; every
other agent keeps the shared one. The log says so once. The Skills page lists
both (`answering-with-sources` and `researcher/answering-with-sources`), leaves
that agent out of the shared one's users, and refuses to give it the shared one
by name.

Agents → Skills lists them in four groups: **Yours** (written or uploaded by
you), **Learned** (an agent proposed it and you kept it), **From plugins**
(accepted from a plugin; its text reads only and it goes with the plugin) and
**From the catalogue** (came with a teammate; yours to change, and a change
means its next update asks before replacing it). The shipped house rules in
`examples/skills` are the platform's and are not listed.

**Who uses a skill is written in the agents' files**, so the file stays the
record. A shared skill with no `agents` key is used by every agent; one with
`agents: []` is used only by the agents whose own `skills:` line names it.
Another agent's own skill is given by its qualified name:

```yaml
skills: [my-voice, researcher/compare-sources]
```

A qualified name that no longer resolves (the skill or its agent was removed)
is skipped with a line in the log; a plain name that is not a shared skill
still stops the agent loading. Every change on the Skills page is checked by
reloading the agents, and a change the loader would refuse is undone before
it answers.

**Uploads.** A single `.md` is read in the browser and saved like a written
skill. Unless you tick "Mark as mine", it is untrusted: its text reaches the
agents fenced as outside text they may learn from but never obey, until you
mark it as yours.

**Bundles.** A skill can also be a folder: `SKILL.md` with `scripts/` and
`assets/` beside it (the Agent Skills format), uploaded as a `.zip` from
Upload on the Skills page. Nothing in it runs on upload, ever. buddi streams
the zip to a temporary folder and checks it before keeping anything — at most
20 MB unpacked and 500 files, a `SKILL.md` (at the top or inside the one
folder everything sits in) with a `description` in its front matter, no
absolute paths, no `..`, no links, nothing encrypted and nothing executable
outside `scripts/` — then shows what is inside. "Add the skill" unpacks it
into the shared skills folder under its own directory (`skills/<name>/`) and
rewrites `SKILL.md`'s front matter in buddi's keys (keys like `license` or
`allowed-tools` are dropped: a skill never grants a tool). Only `SKILL.md` is
edited in the browser; Download gives the bundle back as a `.zip`.

An agent holding a bundle gets its text, the folder's path and its file list,
and small text files (a template, a palette) read whole. **Its scripts run only
through `host.exec`'s `skill` form** —
`{ skill: { bundle, script: "scripts/make_cover.py", args: [...] } }`, no
command — and only for an agent that holds both the bundle and `host.exec`; the
Skills page and the picker say which agents those are. Each run:

- is refused while the bundle is untrusted: an uploaded bundle's scripts cannot
  run until you mark it as yours;
- asks you every time — the card names the script, the bundle, the arguments,
  the working folder and what it may touch, with Reject · Show the script ·
  Allow once and no Auto or Always (no standing permission answers for it);
- works in its own folder (`<data>/host/skill-runs/<bundle>/…`), reads the
  bundle without changing it and writes only in that folder, confined by
  `sandbox-exec` on macOS or bubblewrap (`bwrap`) on Linux. With neither, bundle
  scripts do not run. The network is as host commands have it.

A plain `host.exec` command that names the skills folder is refused. The
developer plugin's run list does not run bundle scripts.

`examples/skills/letterhead/` is a shipped bundle with no scripts: a letter
template and a logo, given to no agent (`agents: []`). Copy the folder into
your skills folder, change the template to your own, and give it to the agents
that write your letters and invoices.

**Edits.** A learned skill's edit is saved as its next version, marked as
your correction; the earlier versions stay in `skills/versions/`. Deleting a
skill takes it off every agent that named it; a learned one keeps its
versions and is not proposed again for 90 days, anything else goes to the
trash folder beside your agents. `buddi skills list` prints the page in the
terminal; the routes are under `/api/skills` (docs/api.md).

## The catalogue

A fresh install has two agents: the front desk and Agent Father. Everything
else is picked from the catalogue: ready-made agents buddi publishes on
withbuddi.com beside the plugins, each tested against the plugins it uses.

Ask the front desk for a new agent and it looks in the catalogue first. A
match comes back as a button under its reply (**Add Chef**) that opens the
agent's install sheet; when nothing fits, **Continue with Agent Father** moves
the conversation to Agent Father with your request already sent. On Telegram
both are inline buttons (Add Chef is a link to the dashboard when the phone has
its address). The front desk cannot ask Agent Father itself: only your tap
starts that. The behaviour comes from the shipped
`examples/agents/concierge/agent.md`, which every install reads from the
package, so an upgrade brings it; a private copy of the concierge in your
agents directory replaces the shipped one and keeps its old wording until you
add `platform.catalogue` to its tools and the handoff section to its persona
(or delete the copy).

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
unknown field is refused, and so is a model, a provider or an account) and recomputes its integrity before using it: a listing that does
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
against its hash and re-encoded like an upload, and kept in buddi's database:
every place an agent's face appears (the rail, the chat, its page, Home, the
Skills page) draws it from there, offline too, without asking withbuddi.com
again. An agent whose picture did not arrive at install gets it with its next
update; a picture you chose yourself is never replaced. An agent without one
keeps its initials. The file is yours from then on.

Beside the file, `plugin.json` records where it came from: `source:
"market"`, the package and version, the package integrity you approved, the
hash of the file as written, the hash of each skill it came with, and the
picks. That is how buddi tells an untouched agent from one you edited: a
changed or deleted skill counts as an edit too.

**Updates** are offered, never written on their own. When a newer version is
listed and you have not touched the file, Update shows what changed: the
version's one line, the persona diff, tools added and removed, new missions.
Approving it writes the file again from the new package with the same picks;
a grant that gains tools says so loudly and names them. When you edited the
file or one of its skills, nothing is touched, ever: the card says a new
version is out, with "See what changed" and "Replace my changes" (your file
and your changed skills go to the trash first). A skill of your own (or a
learned one) with the same name as one the new version brings counts as an
edit too, and is kept in the trash when replaced. A skill the earlier version
wrote and the new one dropped goes to the trash, so it stops running.
Missions are your rows: an update adds new suggested ones off and
never changes or turns on one you have.

The click approves exactly what was shown. The update sheet (and `buddi
agents update`) sends back the plan's fingerprint: the package's integrity,
the tools as they resolve, the file's and every affected skill's hash. If any
of it moved before the click (a new version, a plugin update, a skill you
edited again) nothing is touched and the sheet reads it again. An approval
Agent Father raised binds the same things. A write the agents would not load
with is undone and the install or update fails, rather than waiting for the
next restart. A packaged skill named like one of your shared skills is not
such a write: that agent uses its own (above).

On Add, the sheet lists the package's own tools (its integrity covers them;
the listing's claims are only descriptions). When the plugins installed on the
way resolve a different grant from the one the click carried, the install
stops and shows the grant as it is, with **Add** and **Don't add it**.

**Removing** an agent moves its directory to the trash beside your agents and
pauses its missions in the same approval. Plugins stay; the preview names the
ones no other agent uses.

**Older agents.** Planner, Scout and Keeper (the starter team before the
catalogue) and Ledger and Illustrator (proposed by the finance and image
plugins) keep working with their handles, files and data. Each maps to its
package (Chief of Staff, Researcher, Home Manager, CFO, Illustrator) through
the package's `replaces`, so the catalogue shows it as "Replaces your @scout"
with Update instead of Add; an update keeps its id, handle, memory and
missions, so @planner and @ledger stay, and writes the sidecar it lacked. One
you changed is never replaced on its own: the sheet offers Keep mine or
Replace my changes. An agent made before buddi recorded where agents came
from (no `plugin.json` beside it) is matched when its directory, id and handle
are the older agent's (the Finance Advisor buddi shipped is `finance-advisor`
with handle `ledger`); it counts as changed unless its file is a version that
shipped. An agent of your own that only shares a name (a `garage` you made)
is not matched. A new install of CFO is @cfo.

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

**Trying packages before they are listed.** `BUDDI_MARKET_URL` points the
catalogue and Browse at another copy of withbuddi.com instead (unset, it is
withbuddi.com). The copy only has to serve `/plugins/index.json` and the
pictures beside it; build one from a buddi-market checkout and serve it
locally:

```
node scripts/index.mjs /tmp/market/plugins/index.json http://127.0.0.1:8090
for a in agents/*; do mkdir -p /tmp/market/plugins/$a; cp $a/avatar.png /tmp/market/plugins/$a/; done
(cd /tmp/market && python3 -m http.server 8090 --bind 127.0.0.1)
BUDDI_MARKET_URL=http://127.0.0.1:8090 buddi serve
```

Use it on a throwaway installation (its own `BUDDI_DATA_DIR`, database and
`BUDDI_PLUGINS_FILE`), not your own: the copy's listings are trusted the way
withbuddi.com's are. The gateway's `catalogue-lineup.web.db.test.ts` installs
every lineup package from a copy of the index kept in
`packages/gateway/src/__fixtures__/catalogue-lineup.json`.

What a package may not ask for, whatever it says: the tools that write agents
(`platform.*` writes), `host.*`, `secret.type` and `secrets.*`, `developer.*`,
connection tools (`mcp.*`), `owner.set_profile`, `email.send` and the mailbox
account tools, and anything owner-only. You can give any of them to an agent
by hand afterwards. `secret.list` and `secret.fill` may be asked for (since
pre.37): a fill only puts a value on a page you bound it to, and asks you for
anything else.

**Delegation from the catalogue.** A package may name colleagues in
`delegates`, by catalogue package name (`"delegates": ["cfo"]`), with
`agent.delegate` in its tools. At install they resolve to the agents
installed here — the package's own, or an agent it replaces (`cfo` finds an
older @ledger) — and become its `delegates.json`; a name with nothing
installed is skipped. Installing an agent later adds it to the list of every
installed agent whose package names it, and to the front desk's list when the
front desk has an explicit one (with none, it already asks everyone). An
update adds newly resolved colleagues and removes none. The approval card says
both: "It may hand work to: …" and "@buddi may hand work to it." Removing an
agent strips it from every list, as before.

The integrity is `sha256-<base64>` of one canonical JSON document (keys sorted
at every depth, no whitespace): `{ "agent.json": <agent.json without integrity
and claims>, "persona.md": <text>, "skills": { "<file>.md": <text> },
"avatar.png": "sha256-<base64>" | null }`, the same computation as the
market's check (`withbuddi/buddi-market`, `scripts/agents.mjs`).

