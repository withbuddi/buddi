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

- `runAgent` takes an `interjections` source and drains it between tool calls,
  before the next model step — never inside a tool call. Each line is sent as
  "the owner adds: …" and stored as an ordinary user turn stamped
  `owner:interjection`.
- `WebChat.send` on a live run stores the message, hands it to that run and
  answers `{ ok: true, queued: true, runId }` with the *running* run's id. What
  the run never picks up is promoted to the next turn: the rows are joined into
  one owner turn, the marker cleared, and the turn re-timed to the end of the
  thread rather than written a second time. Stop is unchanged, and what was
  queued goes out after it. Attachments are refused in a sentence.
- Telegram folds a plain second message into the run in flight, and only then:
  a command, an `@handle` and anything sent while something else is already
  waiting on that chat's chain keep their own turn.
- The composer always sends, with Stop beside it; a message sent mid-run shows
  in the thread at once under "added while working".

## Open questions

- Whether an interjection should be able to cancel a pending approval
  ("no, don't") or only add context. Still only context: a run that has
  suspended on an approval is not draining anything, so what the owner says
  becomes the next turn.

## Related work

- `packages/runtime/src/loop.ts`, `packages/web/src/chat/Composer.tsx`,
  `packages/gateway/src/telegram/surface.ts`.
