# Conversation context budget follows the model, not a fixed cap

Status: Proposed
Captured: 2026-09-21

## Problem / opportunity

A conversation is projected to the model under a fixed budget of about 80k
tokens, whatever the model's own window is. A chat that drives the browser or
the computer fills that in a few steps: every observation is a page tree plus
a screenshot, and every `browser.act` result carries both. Once the budget is
spent, earlier turns fall out of the projection and the agent no longer knows
what it was doing: it re-observes, repeats a step, or asks the owner again.

The models we bind have windows between 128k and 1M tokens. A cap set for the
smallest of them wastes most of what the others could hold, and the cost of
the cap lands exactly on the conversations that need history most.

## Possible approach

- Find where the cap lives (`packages/runtime/src/projection.ts` is the
  projection; the number and its rationale are not written next to it) and
  write the rationale down first. If it was chosen for cost or latency rather
  than for a window, say so, because those want a different fix.
- Make the budget a property of the bound model: each provider adapter knows
  the window of the models it serves, or the account records it, and the
  projection takes a fraction of it (leave room for the answer and the
  system context).
- Spend the budget better before spending more of it: tool results that
  carry a screenshot or a page tree are evidence for one step, not for the
  whole conversation. Keep the latest observation whole and reduce earlier
  ones to one line each (URL, title, what was clicked), the way a person
  remembers a browsing session. The transcript keeps everything; only the
  projection shrinks.
- When the projection must drop turns, drop them behind a short written
  summary of what was done so far and what the current task is, rather than
  silently. The agent then keeps its task even after a long session.

## Open questions

- Where exactly is 80k enforced, and is it one place or several (runtime
  projection, gateway run loop, provider adapter)?
- Do the adapters know their models' windows today, or does that need a
  field on the account?
- Is the cap also protecting against cost on metered accounts? Then the
  per-model budget wants an owner setting next to the model choice.
- How much of a browser conversation is screenshots by bytes, and does
  dropping older screenshots alone solve most of it?

## Next decision

Measure one real browser conversation: tokens per step, what share is
observations, and at which step the agent first loses the task. That decides
between raising the budget per model and compacting observations, or both.
Smallest next step: the rationale comment next to the constant, and a log
line when the projection drops turns, so the loss becomes visible.

## Related work

- `packages/runtime/src/projection.ts` (the projection and its truncation of
  large tool results).
- `docs/browser.md`, `docs/computer-use.md` (what an observation holds).
