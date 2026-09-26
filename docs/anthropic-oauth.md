---
title: "Claude subscription sign-in"
status: reference
updated: 2026-09-26
---

# Claude subscription sign-in

A model account that signs in with your paid Claude plan instead of an API key.
You approve access in your browser, buddi keeps the tokens in its vault, and
agents assigned to the account think on your plan. It is a direct
authorization-code + PKCE flow, not a Claude Code runner or a device grant, and
no request-disguise or restriction-bypass mechanism is involved.

Since 15 June 2026 Anthropic gives paid Claude plans a separate monthly budget of
Agent SDK credits for third-party agents such as buddi: Pro $20, Max 5x $100,
Max 20x $200, Team and Enterprise $100–200 per seat. Credits do not roll over.
When they are spent, further use needs API billing, so add an API key account
for that. buddi cannot see how many credits remain.

Tokens refresh before use. A refresh that fails asks you to reconnect the
account; buddi does not retry a refresh token that may already be spent.

The sign-in is offered by default, in the setup wizard and in Settings → Model
accounts. `BUDDI_SUBSCRIPTION_SIGNINS=off` on the host hides it, together with
the ChatGPT sign-in.

## Use

Needs core migration 020, which `buddi init` and upgrades apply.

1. Open Provider accounts → Add account.
2. Choose **Claude subscription**. Give it a name and
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
requests already dispatched cannot be recalled. Hiding the sign-in
(`BUDDI_SUBSCRIPTION_SIGNINS=off`) prevents new login and credential use, but
still allows local disconnect/removal.

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
the owner test. On 2026-09-19 the owner signed in and assigned the account to
Garage; a Memory Recall tool call and an agent reply followed. The owner-reported Garage test verifies a live chat/tool round trip; live
model-list discovery for this new account and a real token refresh remain
unverified. Refresh has mocked and database concurrency coverage, not live-expiry
confirmation. There is no automatic paid verification request.
