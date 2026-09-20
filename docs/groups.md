# Groups: a team of agents in one conversation

Status: implementation contract, agreed 2026-09-20. First version built on the
`groups` branch the same day; see *What the first version does* at the end.

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
resumes after. Members may ask for each other's help, through the coordinator;
see *Member-to-member requests*.

**Sequential execution.** One active member run per group at a time. The
coordinator requests a contribution; that member finishes; coordination
resumes. A pending approval suspends the whole group request: no other member
starts until the decision is made, and new owner messages and scheduled
requests queue behind it. Stop invalidates every pending continuation, so a
late approval cannot restart a stopped request; effects already completed stay
completed. Parallel research is a later feature, not a hidden complication of
the first version.

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

- Its own earlier turns become its assistant history, preserving their content
  and the pairing of each tool call with its result through the provider
  adapter. Not the wire form: an agent's account or model can change between
  turns, and provider-specific blocks do not travel.
- The owner's turns become user turns.
- Other members' turns become attributed room context in a user turn, built
  from the speaker metadata: `@ledger said: …`. Never assistant turns, never
  the model's own words, never system text. Another member's tool results are
  attributed room data in the same way, never executable tool history of the
  receiving agent.
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
- A call is reserved atomically on that row before it is dispatched. An
  ambiguous failure, such as a timeout or a crash after dispatch, keeps the
  reservation: a timeout does not say whether the model ran. Only a rejection
  the provider confirmed before doing any work, such as a 429, releases it. A
  retry after an ambiguous failure reserves another call from the twelve; the
  separate limit on retry attempts and retry time is a second ceiling on top
  of the twelve, never a source of free calls.
- One call, the last, is reserved for synthesis: the coordinator only, no
  tools, given the transcript and the contributions. It cannot start new work.
  Synthesis may come early; two working calls and a conclusion is a complete
  request, and eleven is a ceiling, not a target.
- When the working budget is spent, the coordinator is told and moves to
  synthesis. If synthesis fails, the request ends honestly: the completed
  contributions are already in the thread under their speakers, and the owner
  is told the summary did not come.
- Maintenance has its own budget, recorded on the same row: one call for the
  rollover summary. It is never taken from a request's twelve, and it is never
  invisible extra work.
- Members asking for each other's help spend from the request's twelve; see
  *Member-to-member requests* for how that is scheduled.

## Member-to-member requests

Members request help through the coordinator, which schedules the next
contribution sequentially. Group orchestration never invokes ordinary
delegation recursively: today's delegation cap means a delegate cannot delegate
again, and a group run is not a delegate.

A request is a structured, validated call, not prose. Mentioning another member
in generated text schedules nothing. The call is checked against the group's
membership and against the requesting agent's delegation allowlist, both
explicitly, before anything is queued.

## Memory

Two things, kept apart so task details do not become permanent facts:

- **Group memory.** Durable conclusions, preferences and decisions the room
  reached. A memory scope of its own, written by members through the existing
  memory tools with the group as scope.
- **Rollover summary.** Where this particular discussion stopped: outstanding
  questions, decisions pending, relevant artifact ids. Written by the
  coordinator in one counted call when the thread rolls over, and read into the
  next thread's first turn.

A group run can recall only the shared scope and the group scope. No member,
the coordinator included, performs an automatic private-memory lookup inside a
group run. Private information enters the room in exactly two ways: an
owner-authorised import, or a contribution the owner posts. What is in the
room is seen by the room, and the creation sheet says so in one sentence.

The group scope an agent writes to or reads from comes from the trusted
execution context of the run, never from a group id the model supplies.

Rollover happens between completed owner requests, never mid tool exchange or
with an approval pending. The trigger is a conservative character budget for
the whole room, set per group with a default well under what the smallest
common model holds, since every member turn re-sends the whole room. Per-model
limits can replace the group default once the account layer knows them.

The starting cap does not guarantee a request fits: one large tool result can
exhaust a member's context mid-request. That case ends with a controlled stop,
not a provider error: the oversized output is kept as an artifact and replaced
in the transcript by a reference, the run records that it was too large to
carry, the coordinator is told, and the request proceeds to synthesis.
Synthesis always receives a bounded projection, with references in place of
anything oversized, so the coordinator cannot hit the same overflow while
summarising.

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

## What the first version does

Built: group rows and membership; the shared transcript with a speaker on
every turn; the projection with its tests, holding everything that arrives while any
of the agent's tool calls is open — keyed on the call ids, so two asks in one
response are answered together — so calls and results stay adjacent; the
coordinator loop with mention override and sequential member runs through
`group.ask`, serialised per group in the process and by a partial unique
index on the request row; the twelve-call budget reserved on the request row
before every dispatch, retries included, with no retry ever drawing the
conclusion's call; the room bounded before every call, not once; the
conclusion as a separate no-tools call when members spoke; a member's
approval pause ending the coordinator's turn too, so nothing else in that
turn runs; approval suspension and resume by the exact action; stop, which
rejects the pending approval; the group memory scope with private memory never recalled and
every write in a room landing in the room; rollover on a character cap with a
one-call maintenance summary made through the same accounting and the same
bound, and the new thread reading the summary just written; the roster entry, creation sheet, `@`
completion, attribution and the activity line; routes under `/api/groups`.

Deliberate deviations, to be closed later:

- **A member's answer reaches the coordinator through the tool result.** The
  coordinator's loop holds its history in memory during a run, so the
  contribution has to come back through `group.ask`. It comes back attributed
  (`@ledger said: …`) with a note that it is context, never bare. In later
  runs the transcript shows it under the member's name.
- **The conclusion is skipped when the coordinator already concluded.** If the
  coordinator wrote prose after the last member spoke, that prose stands and
  no second, tool-less call is made; otherwise the separate synthesis call
  runs. Two answers to one request read worse than one answer with tools
  available.
- **Oversized output is bounded, not externalised.** Before every call the
  room is reduced to the group's cap in this order: an agent's own tool
  results clipped, the oldest turns dropped whole, pictures and documents
  turned into one-line references, long text clipped, every marker counted.
  A room that still cannot fit ends the run with a named refusal rather than
  a silent shortfall. Moving an oversized result into an artifact is not
  built.
- **A rejection the provider confirmed is counted on retry.** The adapters
  retry a 429 themselves; each dispatch reserves, and only the final refusal
  releases. Never fewer reservations than dispatches.
- **Groups are a dashboard surface.** Telegram and the terminal know nothing
  of them: no group can be created, addressed or read there. The one place
  the surfaces meet is an approval: a member's pending action can be decided
  from Telegram like any other, and that decision is handed to the
  dashboard's group path, which resumes the request; Telegram says so and
  never runs the member as an ordinary turn. With no dashboard running, the
  request stays suspended until there is one.
- **Missions cannot target a group yet.**
