---
title: "Conversations: what the model sees, and what you can say while it works"
status: reference
updated: 2026-09-25
---

# Conversations: what the model sees, and what you can say while it works

A conversation is a transcript on disk and a *projection* of it sent to the
model. The two are not the same thing, and most of what is surprising about a
long conversation comes from the difference. This page is the two rules that
govern it: how much of a conversation the model is shown, and what happens to
something you type while a run is in flight.

## The context budget follows the model

**The budget is a share of the bound model's own window, not a fixed cap.**
`packages/runtime/src/context-window.ts` holds the table — Claude 5 and 4.x,
GPT-5 and the o-series, common local models by name prefix, and 128k for a name
it does not recognise — because no provider serves its window over the wire in
a usable shape.

The owner can override it **per account**, in a "Context window" field in
Settings → Model accounts, stored as
`core.provider_accounts.context_window_tokens`. Per account rather than per
model, because two OpenAI-compatible accounts are two endpoints: an 8k laptop
model and a 256k hosted one can both be "openai-compatible", and one number for
both would overflow the small one every time. An agent with no binding is not
unbudgeted — it is sized against the installation's default account. The legacy
80k constant is reached only when there is no model and no override to be had
at all: an installation with no accounts yet, or a database that will not
answer. It is a compatibility fallback and **not** a floor under a known model,
because an owner who declares 8,000 tokens means it.

The limit is **half the window** (`TRANSCRIPT_WINDOW_SHARE = 0.5`), counted in
tokens: non-ASCII characters at one token each, the rest at 3.6 characters a
token. CJK tokenises near 1:1, and a character budget would hand it three times
the room it actually has. It is a share rather than the whole window partly to
leave room for the answer and the system context, and partly for cost — the
runaway that motivated the original cap was a mail thread charged tens of
thousands of tokens a turn — which is why the override sits next to the model
choice.

**What the 80k cap actually was.** Not a projection cap at all: it was
`MAX_TRANSCRIPT_CHARS` in
`packages/gateway/src/surfaces/conversation-lifetime.ts`, the *size* axis of
the rollover rule. A browser conversation that hit it was not losing its oldest
turns, it was **ending**, and the agent began again in a fresh transcript. The
real limit now comes from `packages/gateway/src/surfaces/context-budget.ts` and
`@buddi/runtime`'s `contextWindowTokens`, measured against the *projected*
transcript; the rationale is written next to the old constant. Every failure in
that path degrades to the old constant and the stored count — a machine that
cannot size a transcript must still answer.

**Observations are compacted before the budget is raised.**
`compactObservations` in `packages/runtime/src/projection.ts` reduces every
`browser.act`, `browser.status` or `computer` result older than the last two
*observations* to one line: tool, action, title, URL, ok or failed. Results
that carry no page — a status answer, a failed click — are left alone and do
not count, so a status call can never evict the page the agent is acting on.
The transcript on disk keeps everything whole; only the projection shrinks. The
rollover now counts the **projected** size, cached per version of the
transcript, so a long browser conversation is measured once rather than on
every turn.

**A conversation that does end says what it was doing.** Every size rollover
carries a note — the task, the last thing asked, the agent's last words, the
pages if any — under the hidden speaker the browser handoff already used
(`packages/gateway/src/surfaces/browser-handoff.ts`). URLs are stripped of
credentials, query and fragment; titles are labelled as the pages' own
untrusted words; every copied message is redacted of anything
credential-shaped and capped at 400 characters. Idle rollovers are unchanged.
The rollover logs one line with the reason, both sizes and the limit applied.

## Sending while the agent works

The composer always sends. A message typed during a run is queued, shown in the
thread at once marked *waiting*, and reaches the agent mid-run rather than
after it — so a correction arrives before the agent has finished doing the
wrong thing.

**The queue is a table, not the transcript.** `core.pending_input` (migration
032) holds one row per thing said mid-run, moving `pending → leased →
delivered`, or `→ promoted`. Never a `core.messages` row until a run can take
it: a user turn written between a `tool_use` and its result is a transcript no
provider will replay. It is durable, so a restart promotes what it finds
instead of stranding it.

**Where it enters the run.** `runAgent` takes an `interjections` source and
*leases* from it after a turn's tool calls have been answered and before the
next model step. What it takes rides in that same tool-results turn, after the
results, framed as "the owner adds: …"; the record keeps the owner's own words.
Delivery is acknowledged only once the model has been shown it, and nothing is
leased on a run's last allowed turn.

**What the dashboard does.** `WebChat.send` on a live run queues the row and
answers `{ ok: true, queued: true, runId, pendingId }`. Whatever no run took is
promoted, in one transaction, into a single new canonical turn — two lines
promoted together become one turn — and `openingPersisted` is set only when
that transaction landed. The transcript read joins the waiting rows on at the
end by their own ids, marked *added while working*; the page keeps its
optimistic bubble under that id and lets it go once the server has read it
back, so nothing is left behind. Attachments are refused in a sentence and wait
for the next turn.

**Stop is unchanged.** It ends the run, and what was queued goes out as the
next turn. An interjection adds context; it cannot cancel a pending approval,
because a run suspended on an approval is not draining anything — what the
owner says there simply becomes the next turn.

**Telegram behaves the same way.** A plain second message during a run is
folded into the run in flight, decided on the text with the bot mention
stripped, and whatever was being held is promoted in a `finally`, so a run that
throws no longer loses the owner's message.

Where it lives: `packages/runtime/src/loop.ts`,
`packages/web/src/chat/Composer.tsx`,
`packages/gateway/src/telegram/surface.ts`.

## An approval inside a delegation

When a colleague reached through `agent.delegate` stops on an approval, the
asking agent waits for it instead of getting an empty answer. Nothing is held
open while it waits: the colleague's run ends awaiting the action, the tool
writes `delegation.waiting` in the asker's conversation, and `ctx.suspend`
ends the asker's run awaiting that same action, as a gate of its own would.

The owner sees the approval where they are. The root conversation's transcript
carries `delegatedApprovals`, which are the pending rows of every conversation
under its delegations. The dock shows each one with a line like "@art, asked by
@playground", the Delegation panel says "Waiting for your approval", and both
agents' faces are badged. It is the colleague's own row, so a decision in
either thread is the same decision.

A decision from any surface resumes the colleague's conversation. The
dashboard runs it on as the delegate it was: one level deep, on the nested
budget, and without the owner-facing tools. Its answer then resumes the asker,
as the deferred result of its `agent.delegate` call. If the colleague asks for
another approval, the asker keeps waiting on that one. A rejection or an expiry
reaches the asker as a failure with the reason. The approval's own expiry is
the longest the asker waits, and a sweep once a minute enforces it. A decision
made on Telegram is handed to the dashboard, as a group's is.

A colleague that ends with no final words still returns something: its last
message in its thread, the files it saved (library ids), its failed calls, and
a `status` with a `note`.

Where it lives: `packages/runtime/src/delegate.ts`,
`packages/gateway/src/agents/delegation-chain.ts`,
`packages/gateway/src/web/chat.ts` (`#resumeDelegate`,
`sweepExpiredDelegations`).

## Related

- [browser.md](browser.md) — what an observation holds, which is what the
  compaction is about.
- [groups.md](groups.md) — a group passes the projection's own cap as well.
