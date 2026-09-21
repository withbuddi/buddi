# Send while the agent works

Status: Accepted — branch `queued-input`
Captured: 2026-09-21

## Problem / opportunity

While an agent is running, the composer shows Stop and refuses to send.
The owner who has one more thing to say has to wait for the run to end,
then type it, then wait again. On Telegram the message is accepted and
answered after the run, which is the better behaviour; the dashboard
should match it and go one further.

## Possible approach

- The composer always sends. A message sent during a run is queued on the
  conversation and shown in the thread at once, marked "waiting", so the
  owner sees it landed.
- When the run ends, queued messages are delivered as the next turn, in
  order, joined into one owner turn if there are several.
- The agent is told mid-run: the runtime injects the queued text into the
  next model step as an owner interjection ("the owner adds: …"), so a
  correction arrives before the agent finishes the wrong thing. Only text;
  attachments wait for the next turn.
- Stop stays as it is: it ends the run; queued messages then go out as the
  next turn.
- Same on Telegram: a second message during a run is an interjection, not
  a second run.

## What was built

- `core.pending_input` (migration 032) is the queue: one row per thing the
  owner said mid-run, with `pending → leased → delivered` or `→ promoted`.
  Never a `core.messages` row until a run can take it — a user turn written
  between a `tool_use` and its result is a transcript no provider replays —
  and durable, so a restart promotes what it finds instead of stranding it.
- `runAgent` takes an `interjections` source and **leases** from it after the
  tool calls of a turn have been answered and before the next model step. What
  it takes rides in that same tool-results turn, after the results, framed as
  "the owner adds: …"; the record keeps the owner's own words. Delivery is
  acknowledged only once the model has been shown it, and nothing is leased on
  the run's last allowed turn.
- `WebChat.send` on a live run queues the row and answers
  `{ ok: true, queued: true, runId, pendingId }`. What no run took is promoted
  in one transaction into a single new canonical turn; `openingPersisted` is
  set only when that transaction landed. Stop is unchanged, and what was
  queued goes out after it. Attachments are refused in a sentence.
- The transcript read joins the waiting rows on at the end, by their own ids,
  marked "added while working"; the page keeps its optimistic bubble under
  that id and lets it go once the server has read it back — so two lines
  promoted into one turn leave nothing behind.
- Telegram folds a plain second message into the run in flight, decided on the
  text with the bot mention stripped, and promotes whatever it was holding in
  a `finally` — a run that throws no longer loses the owner's message.

## Open questions

- Whether an interjection should be able to cancel a pending approval
  ("no, don't") or only add context. Still only context: a run that has
  suspended on an approval is not draining anything, so what the owner says
  becomes the next turn.

## Related work

- `packages/runtime/src/loop.ts`, `packages/web/src/chat/Composer.tsx`,
  `packages/gateway/src/telegram/surface.ts`.
