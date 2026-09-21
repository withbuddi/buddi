# Telegram sees what the dashboard sees

Status: Proposed
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

## Next decision

Build after the remote hand lands. One day.

## Related work

- `packages/gateway/src/telegram/*`, `docs/browser.md`, the remote hand.
