# Send while the agent works

Status: Proposed
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

## Open questions

- Where the interjection enters the loop safely: between tool calls, never
  inside one.
- Whether an interjection should be able to cancel a pending approval
  ("no, don't") or only add context.

## Next decision

Build after the remote-hand latency fix lands. A day: runtime interjection
point, queue on the conversation, composer and Telegram surfaces.

## Related work

- `packages/runtime/src/loop.ts`, `packages/web/src/chat/Composer.tsx`,
  `packages/gateway/src/telegram/surface.ts`.
