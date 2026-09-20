# Groups: a team of agents in one conversation

Status: agreed design, not built. Dated 2026-09-20.

A group is a persistent conversation with a chosen team of agents. You create
"Household finances", add Concierge, Ledger and Finance Advisor, and say
"Review this month's spending and help me decide how much I can save." You see
who is working, what each contributed, the files they produced, and one
consolidated answer, all in that thread. Later you say "@ledger, exclude that
reimbursement" and Ledger handles the correction in the same conversation.

The experience to aim for: you give a task to your team once, can watch or
step in, and receive a coherent result, not several disconnected answers.

## What a group is not

- Not several agents answering the same message. Not every member speaks on
  every request; the coordinator decides who works.
- Not a new kind of agent. Members are the agents you already have, with the
  accounts, tools and approval rules they already have.
- Not a shared permission. Adding an agent to a group grants it nothing it did
  not hold, and gives no member access to another member's private
  conversations or private memory.

## The model

**Fixed membership, chosen coordinator.** A group has a name, a member list,
and one coordinator picked by the owner at creation (Concierge by default). The
first version has no dynamic membership, no voting, no autonomous debates and
no workflow builder.

**One room, real speakers.** The group has one stored transcript. Every turn
records who spoke: the owner, or a member by agent id. That speaker is trusted
metadata, never inferred from the text.

**Coordinator-directed work with mention override.** A message with no
mention goes to the coordinator, which interprets it, asks members for
contributions, and brings the results together. A message that names members
with `@handle` goes to those members, in the order named, and the coordinator
resumes after. Members may address each other, within the budget below.

**Sequential execution.** One active member run per group at a time. The
coordinator requests a contribution; that member finishes, or pauses on an
approval; coordination resumes. Parallel research is a later feature, not a
hidden complication of the first version.

**A hard request budget.** Each owner request may spend twelve model calls
across all members: eleven working calls and one synthesis call reserved for
the coordinator's conclusion. Details under *Budget*.

**Group memory and rollover.** A group has its own memory scope. Rollover
happens only between completed owner requests and writes a summary of where
the discussion stopped. Details under *Memory*.

**Missions can target a group.** A mission names an agent or a group, through
an explicit target type, and runs through the same path with the same budget
and the same approvals. A schedule is not permission to bypass approval.

## The projection: what each model sees

Providers know two roles, user and assistant. The stored transcript has many
speakers. Each model call receives a projection of the transcript built for
the agent about to speak:

- Its own earlier turns become its assistant history, verbatim, so its tool
  calls and tool results stay paired.
- The owner's turns become user turns.
- Other members' turns become attributed room context in a user turn, built
  from the speaker metadata: `@ledger said: …`. Never assistant turns, never
  the model's own words, never system text.
- Shared artifacts stay references, reached through that agent's existing
  artifact tools.
- Coordination requests ("Ledger, summarise the transactions") are turns like
  any other, spoken by the coordinator, and reach the member as room context
  plus the instruction to contribute now.

A member's statement can never become a system instruction or a permission
grant for another member. The projection is the boundary that makes the
feature safe, and it gets dedicated tests before any orchestration is built on
it: role mapping, pairing of tool use and result, attribution from metadata,
and refusal to promote room text.

## Budget

- Twelve model calls per owner request, shared across every member, counted on
  the group request row in the database so it survives approval pauses and
  restarts.
- A call counts when the provider answered, including an answer the run then
  treated as an error. A transport failure that never reached the model, or a
  429 the adapter backs off from, does not count.
- The twelfth call is the synthesis: the coordinator only, no tools, given the
  transcript and the contributions. It cannot start new work.
- When the working budget is spent, the coordinator is told and moves to
  synthesis. If synthesis fails, the request ends honestly: the completed
  contributions are already in the thread under their speakers, and the owner
  is told the summary did not come.
- Members addressing each other spend from the same budget; the existing
  delegation depth cap still applies, so two members cannot loop.

## Memory

Two things, kept apart so task details do not become permanent facts:

- **Group memory.** Durable conclusions, preferences and decisions the room
  reached. A memory scope of its own, written by members through the existing
  memory tools with the group as scope.
- **Rollover summary.** Where this particular discussion stopped: outstanding
  questions, decisions pending, relevant artifact ids. Written by the
  coordinator in one counted call when the thread rolls over, and read into the
  next thread's first turn.

Recall in a group run covers the shared scope and the group scope. Agent
private memory is not recalled automatically, the coordinator's included.
Bringing private context into the room is an explicit act: the agent says it in
a turn, where it is visible and attributed. The creation sheet says this in one
sentence: anything an agent brings into the room is seen by the room.

Rollover happens between completed owner requests, never mid tool exchange or
with an approval pending. The trigger is a conservative character budget for
the whole room, set per group with a default well under what the smallest
common model holds, since every member turn re-sends the whole room. Per-model
limits can replace the group default once the account layer knows them.

## What you see

The existing chat and Canvas carry it:

- Groups in the roster beside the agents, with a stacked-faces avatar. Creating
  one is a sheet: name, members, coordinator, the memory sentence.
- The header shows the members; every turn carries its agent's face and name.
- `@` completion in the composer.
- A compact activity line for coordination: "Concierge asked Ledger to analyse
  the transactions." Routine coordination is collapsed by default; the full
  exchange stays one click away, the way tool calls do.
- Approvals appear inline and name the requesting agent. Documents, charts and
  browser activity open on the shared Canvas, tagged with the agent.
- Stop ends the whole request. Computer control keeps exclusive ownership,
  because the machine has one mouse and keyboard.

## Boundaries, stated once

- Shared conversation, separate permissions: each member keeps its own model
  account, tools and approval requirements.
- Members may use the group's messages, attachments and results. Their
  individual conversations remain separate.
- Speaker attribution comes from stored metadata only.
- A schedule never bypasses an approval.

## Build order

1. The projection and its tests.
2. Group rows and membership; the shared transcript with speakers.
3. The sequential coordinator loop: routing with mention override, the
   twelve-call budget on the request row, synthesis as the reserved call.
4. Group memory scope and rollover with the summary call.
5. Roster entry, creation sheet, `@` completion, attribution and the activity
   line in the thread and on the Canvas.
6. Missions with a group target.

Postponed on purpose: parallel member runs, voting, autonomous debates,
dynamic membership, workflow builders.
