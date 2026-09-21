# Telegram sees what the dashboard sees

Status: Accepted
Captured: 2026-09-21

## Problem / opportunity

A conversation can move between Telegram and the dashboard in both
directions, but what it can show differs. Approvals reach Telegram; sight
does not: when an agent drives the browser or the computer, the phone gets
text and no picture, and there is no way in to take over.

## Possible approach

- After each `browser.act` (and each computer step), send the observation
  screenshot as a photo with a one-line caption: page title, the action,
  step n of max. Throttle to one photo per step, never per poll.
- A "Take over" button under that photo that is a deep link to the
  conversation's Browser tab on the dashboard, over the tailnet. With
  Tailscale sign-in the phone opens it signed in, and the remote hand is
  built for touch, so that is the take-over on a phone.
- The chat's other panels (tables, charts) keep their existing text
  rendering on Telegram; a photo of a canvas is a later step.

## Open questions

- Photo size and rate on a long session: cap at one every few seconds and
  skip unchanged pages?
- Where the deep link lands when the dashboard is not on the tailnet:
  the loopback address, with the words "open this on the computer".

## What was built

- `packages/gateway/src/telegram/browser-view.ts` — the photo per `browser.act`
  (throttled by observation id, withheld for a host or app outside the owner's
  allow lists), the "Take over" button, and the four `/browser` commands.
- `browserTabUrl` in `packages/gateway/src/web/config.ts` — the public origin
  when one is configured, loopback with a caption line otherwise.
- `?tab=browser` on the chat route, honoured once by `ChatPage`.
- `browserStoppedMessage` in the browser plugin: the refusal names
  `/browser resume` on Telegram and the Settings page elsewhere, from
  `ctx.surface`.

Panels other than the browser (tables, charts) keep their text rendering on
Telegram; a photo of a canvas is still a later step.

## Related work

- `packages/gateway/src/telegram/*`, `docs/browser.md`, the remote hand.
