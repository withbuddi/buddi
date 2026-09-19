# Anthropic subscription login

Status: Accepted
Captured: 2026-09-19

Implementation: [Claude OAuth experiment](../anthropic-oauth.md).

## Problem / opportunity

Connect named Claude subscription accounts from the Dashboard and refresh their
credentials without manually pasting replacement setup tokens. Keep API-key,
legacy-token, and Codex accounts unchanged.

## Reference implementations inspected

- Vonzio: `packages/core-server/src/services/anthropic-oauth-service.ts` and
  `profile-service.ts` in the sibling Vonzio checkout.
- Wassup imports the shared `extension-ai-connect` background integration.
- Shared package: `src/background/anthropic-oauth.ts` and `index.ts`.

These implement authorization-code + PKCE with a consent page and a pasted
`code#state`, not a device-code grant. Vonzio uses a user-bound encrypted pending
login token; the extension stores pending state in Chrome session storage. Both
perform token exchange and refresh themselves. This inspection establishes what
the code does, not that the upstream flow currently succeeds for Buddi.

## Proposed boundary

- A small Node-compatible protocol module: PKCE, authorize URL, strict paste/state
  validation, exchange, refresh, bounded HTTP requests and sanitized errors.
  Inject fetch and clock; no database, Dashboard, Chrome, or agent dependencies.
- A gateway `AnthropicAccounts` service: pending login lifecycle, vault access,
  account/revision checks, and refresh coordination.
- New account auth kind `anthropic-oauth`, permitted only for Anthropic. Reuse the
  existing Anthropic runtime after resolving a valid access token server-side.
- Narrow integration with account schema/resolution, owner-protected routes,
  model discovery, connection tests, and the provider account form. Do not fork
  the runtime or build a general authentication framework.

## User experience

Create a named Anthropic subscription account, choose Connect Claude, open the
consent link, and paste the full returned code into that account's settings.
After a successful exchange and vault save, load the model picker. Assignment
remains explicit. Support cancel, reconnect, and local disconnect.

Show connection state and actual token expiry when known; never label expiry as
subscription renewal or infer plan/quota. Local disconnect removes Buddi's stored
credential; do not claim it revokes the upstream grant.

## Credential and concurrency requirements

- Store one versioned envelope containing access token, refresh token, actual
  expiry, and granted scopes in the existing vault. Postgres stores references
  and safe metadata only. Secrets must not reach chat, tools, logs, or browser
  persistence. The pasted code is transient input in the settings form.
- For the first version, keep bounded pending logins in gateway memory with a
  15-minute TTL, bound to the initiating owner session, account, and revision.
  Restart requires starting sign-in again; no new encrypted-state store needed.
- Separate random OAuth state from the PKCE verifier. Require the returned state;
  consume each attempt once, and invalidate it on cancel, reconnect, or account
  changes. Preserve an existing credential until reconnect succeeds.
- Use per-account in-process coordination plus a Postgres advisory lock for
  credential lifecycle operations. Re-read after acquiring the lock. Persist a
  rotated pair before returning it for use; do not hold the lock for a full chat
  generation or while the user is on the consent page.
- Route completion, model discovery, and connection testing through the same
  refresh-aware credential resolver. Coordinate disconnect/disable/removal with
  refresh so late completion cannot restore removed credentials.
- Record real expiry separately from the early-refresh margin. Validate token
  responses rather than inventing a provider expiry when absent.
- Handle invalid grants as reconnect-required. Bound transient failures and do
  not blindly replay ambiguous refresh requests or model turns. If rotation
  succeeds but secure persistence fails, surface a credential-recovery error.
- No fallback to another account, no implicit legacy-account conversion, and no
  changes to Buddi's tool grants or host approvals.

## Acceptance and rollout

Test PKCE/state mismatch, expiry, duplicate completion, cancellation/restart,
concurrent refresh across processes, vault failure, reconnect and removal races,
secret redaction, and both local/remote Dashboard authorization and CSRF. Verify
API-key and legacy-token regression coverage, model discovery, and shared
resolution for Dashboard, Telegram, CLI, and scheduled runs.

Gate the new login independently from the Codex experiment. First prove the
flow with mocked endpoints; then conduct one owner-assisted real sign-in and
explicitly requested test turn. Keep provider-specific request compatibility
separate from OAuth lifecycle code. A rejected grant or inference request is a
diagnostic, not permission to evade upstream restrictions.

## Next decision

Scope approved on 2026-09-19. Implementation updates the provider roadmap's earlier
decision to exclude this flow. Package extraction remains separate work.

## Related work

- [Provider roadmap](../provider-roadmap.md)
- [Reusable adapter idea](reusable-codex-adapter.md)
