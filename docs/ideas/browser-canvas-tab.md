# One pinned Browser tab while an agent drives the browser

Status: Proposed
Captured: 2026-09-21

## Problem / opportunity

While an agent works in the browser, every `browser.act` call opens its own
tab on the right panel: a dozen "Browser · Act" tabs, each showing one
input and "Completed: yes". The tab that matters, "Browser", which shows the
live screenshot and the observation the agent is acting on, is not the one
in front. The owner has to hunt for it, and by the time it is found the
agent has moved on. Seen on 2026-09-21 with the Finance Advisor signing in
to a bank through the owner's Chrome.

## Possible approach

- A browser session owns one canvas tab, "Browser", pinned to the front for
  as long as the session is alive: the latest screenshot, the URL and title,
  the step the agent is on, and the last few actions as a short list.
- `browser.act` and `browser.status` calls do not open tabs of their own
  while that tab exists; their rows in the chat stay, and clicking one
  highlights that step in the Browser tab rather than opening a new one.
- A failed act shows its reason in the Browser tab's step list, in red.
- When the session closes, the Browser tab stays with the last screenshot
  and is no longer pinned.
- The same shape serves computer mode and the delegate view (docs: the
  delegation task on branch `delegation` builds a live view for another
  agent's run; the Browser tab is the same idea for a browser session).

## Open questions

- Does the canvas already have a notion of a pinned or singleton tab, or is
  every tab a tool result today (`packages/web/src/canvas/registry.tsx`)?
- The screenshot is in the observation result; is it streamed while the
  run is alive, or only after each call returns?

## Next decision

Do it right after the delegation batch, since the delegate view establishes
the "live view of something else" pattern the Browser tab needs.

## Related work

- `packages/web/src/canvas/*`, `packages/web/src/chat/browser.ts`
- `docs/browser.md`
