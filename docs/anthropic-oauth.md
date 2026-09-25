---
title: "Claude OAuth experiment"
status: reference
updated: 2026-09-25
---

# Claude OAuth experiment

Developed on `feature/anthropic-oauth`. The owner reported successful sign-in and
assignment to Garage on 2026-09-19; the supplied Dashboard screenshot shows a
successful Memory Recall tool call followed by an agent reply.
This is a direct authorization-code + PKCE flow based on the sibling Vonzio and
extension-ai-connect implementations, not a Claude Code runner or device grant.
Upstream acceptance can change; a successful token exchange does not guarantee
that inference will be accepted. No new request-disguise or restriction-bypass
mechanisms were added to the existing Anthropic runtime.

## Enable and use

Apply core migration 020, set `BUDDI_ANTHROPIC_OAUTH_EXPERIMENT=1` on the serving
host and any standalone CLI processes using these accounts, build, and restart.
The independent Codex experiment flag is unchanged.

1. Open Provider accounts → Add account.
2. Choose **Anthropic — Claude subscription (experimental)**. Give it a name and
   initial model, then save. It does not accept pasted API keys or setup tokens.
3. Choose **Connect Claude**, open the consent link, and approve with the intended
   Claude account. Paste the entire returned `code#state` in the account card.
4. Choose **Complete Claude sign-in**. Edit the connected account to load its model
   list, then explicitly assign it to an agent. No bindings change automatically.
5. Test connection or send an agent message only when ready to use the subscription
   allowance. Model discovery itself does not send a model prompt.

Consent happens in the owner's browser, including over the remote Dashboard; no
callback server on the host, local Claude install, or remote browser control is
required. Use the same Dashboard session to finish. Never paste the code in chat.

## Boundaries and lifecycle

- `runtime/anthropic-oauth.ts`: PKCE/state validation, code parsing, bounded shared
  HTTP transport, token exchange and refresh; injectable transport/clock.
- `gateway/anthropic-accounts.ts`: ephemeral attempts and vault token lifecycle.
- `gateway/provider-accounts.ts`: account revisions, cross-process locking,
  refresh-aware resolution for chat, model discovery, and connection tests.
- All owner routes use the existing session, origin, CSRF, body-limit and no-store
  protections. Login links are returned only to the initiating Dashboard session.

Pending attempts are bounded, single-use and expire after 15 minutes. Restart,
cancel, another login, or account edits invalidate them. Failed reconnect keeps
the old stored credential. Login lifecycle actions increment the account revision,
so an active agent run may require a new turn afterward.

Each account has an independent vault reference containing a compact, versioned
envelope: access token, refresh token, scopes, actual expiry, and rotation state.
No token, verifier, or pasted code goes into SQL, logs, chat, or browser storage.
Expiry is validated from the response; subscription renewal and quota are unknown.

Refresh starts within five minutes of expiry. PostgreSQL advisory locks serialize
credential operations across processes, not full model generations. The credential
is reloaded under the lock, and rotation is persisted before use. Before sending
refresh, a durable `refreshing` marker is stored. If refresh fails ambiguously,
the process crashes, or the new pair cannot be saved, subsequent use requires
reconnect rather than replaying a potentially consumed refresh token. Even a
transient refresh failure therefore may require reconnect in this first version.

Disconnect removes Buddi's credential, invalidates pending login attempts, and
does not revoke the grant at Anthropic. Disable/removal coordinate with refresh;
requests already dispatched cannot be recalled. Disabling the experiment prevents
new login and credential use, but still allows local disconnect/removal.

API keys and legacy setup tokens retain their existing behavior. No automatic
fallback or conversion occurs. Agent permissions, tools, Codex, and memory are
unchanged. There is no new background refresh daemon or credential database.

## API

`POST /api/provider-accounts/:id/anthropic/{login,complete-login,cancel-login,logout}`
requires the current `revision`. Completion additionally requires `attemptId` and
`code`. Attempts belong to the requesting owner session.

## Verification

Mocked protocol and lifecycle tests cover PKCE, state, expiry, malformed responses,
redaction, single-use attempts, restart/cancel, vault failures and interrupted
rotation. Database tests cover account gating, credential resolution, two service
instances racing to refresh, disconnect during rotation, and disabling pending
login. Web tests cover controls, transient code clearing, and route protections.

Build, typechecks, workspace tests, and the generic-install check passed before
the owner test. Migration 020 and the experiment flag are enabled on the development
host. The owner-reported Garage test verifies a live chat/tool round trip; live
model-list discovery for this new account and a real token refresh remain
unverified. Refresh has mocked and database concurrency coverage, not live-expiry
confirmation. There is no automatic paid verification request.
