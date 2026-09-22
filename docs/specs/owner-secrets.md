# Secrets the agent can use but never see

Status: spec, accepted, not started
Captured: 2026-09-21

## Problem / opportunity

buddi keeps its own keys in a vault. The owner's site passwords are the
last manual step in every bank check: the agent reaches the sign-in page
and hands over. The rule that no agent handles a password has held all
day and must keep holding.

## Possible approach

- The owner stores a secret once, named ("PNC password"), bound to a site
  origin, in the same vault buddi already has.
- A gated tool `secret.fill { name, field }` asks to fill that secret into
  a field the agent names by ref. On approval the gateway sends the value
  straight to the browser backend (the extension's debugger insertText,
  Playwright's fill); the value never enters a tool result, the transcript,
  the model context, a log, or the canvas. The tool result says only
  "filled".
- The first use on a site is approved by the owner with the origin shown;
  later uses on the same origin can be pre-approved per secret. A fill on
  any other origin is refused before the approval card.
- No read tool exists. There is no way for an agent to obtain the value.

## Open questions

- MFA stays the owner's: the phone code is typed through the remote hand.
- Does the owner want the secrets in the system keychain or in buddi's
  file vault? The same choice buddi's own keys already make.
- What the approval card must say so that a phished page (same look, other
  origin) is refused by the origin check, not by the owner's eye.

## Next decision

Design note reviewed by two reviewers before code. Two days to build.

## Related work

- `packages/core/src/vault`, `packages/extension/src/commands.ts`
  (`fill` refuses password fields today), [browser.md](../browser.md).
