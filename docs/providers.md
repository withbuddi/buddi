---
title: "Provider accounts"
status: reference
updated: 2026-09-26
---

# Provider accounts

Open **Settings → Model accounts** in the owner dashboard (`#/providers` still
redirects there). Each account is an independent named
connection, not a global preference. Add multiple accounts for the same provider,
then use `#/agents` to explicitly select an account and model for each agent.

Supported connections:

- Anthropic API key, using Anthropic's fixed endpoint.
- OpenAI API key, using OpenAI's fixed endpoint.
- OpenAI-compatible Chat Completions endpoint, with an API key or explicitly no key.
  Supply the API base including `/v1` or a custom path such as `/api/v1`. A bare host
  gains `/v1`. HTTPS is required except for loopback local servers. Compatible model
  names are not restricted to OpenAI prefixes. The selected model/server must support
  the capabilities used by the agent, especially tool calling and images.
  A model that turns images down (say, a text-only model on Ollama Cloud) does
  not stop the run: buddi sends that turn again with each screenshot replaced by
  a line of text, and sends no more pictures for the rest of the run. The run's
  events record it once, as `run.images-refused`.
- Previously configured Claude subscription/setup tokens, imported as legacy accounts.
  These are preserved, not promoted to refreshable OAuth connections. Token expiry and
  subscription renewal date are unknown. The extracted Chrome extension package is
  not loaded into the server.
- [Claude subscription sign-in](anthropic-oauth.md), with browser consent,
  code paste, and coordinated vault-backed token refresh. Uses the plan's
  monthly Agent SDK credits; after them, an API key.
- [ChatGPT subscription through Codex](codex-accounts.md), with native device
  sign-in. Requires the pinned Codex client on the host.

Both sign-ins are offered by default. `BUDDI_SUBSCRIPTION_SIGNINS=off` hides
both: the account kinds are refused and the wizard and Settings do not offer
them. Anything else, unset included, leaves them on.

**Context window.** Each account carries an optional "Context window" field,
stored in `core.provider_accounts.context_window_tokens`. It overrides the
built-in table of model windows for that endpoint, which is the only truth
available for a locally served model whose window is whatever `num_ctx` the
host was started with. [conversations.md](conversations.md) is what the number
is used for.

## Storage and migration

`core.provider_accounts` holds account metadata, revision and secret references.
`core.agent_provider_accounts` holds agent/account/model assignments. Keys stay in the
host vault. The UI never reads back saved values and never stores keys in browser
storage. Newly entered password fields are cleared on submission, including failures.

On its first start after the model accounts feature arrived, buddi imported the keys it
found in the environment and the vault as accounts (three legacy slots), and pinned every installed agent to its previously selected credential and model.
It references existing vault entries without copying values into SQL. Existing removal
markers remain disabled. An explicitly selected missing API key stays missing; it does
not switch to a subscription token. Missing slots can be filled later or removed when
unassigned. A marker prevents restarts from reimporting or rebinding accounts.

An imported account may read its explicitly named legacy environment variable if the
vault entry is absent. Replacing its credential creates an account-specific vault entry
and permanently removes that environment fallback for the account. The old legacy
vault entry is retained on replacement for compatibility/recovery, but the account no
longer uses it. Newly created accounts never read ambient environment credentials.

Once imported, account/model bindings in Postgres override agent-file provider/model
fields. Files still own persona, tools, language and turn budget. Newly installed agents
must be assigned an account; there is no silent default or cross-account fallback.

macOS uses Keychain by default. Windows/Linux use the AES-256-GCM file vault with
`BUDDI_VAULT_KEY` outside Postgres. A packaged install creates the key on its first run (a source checkout: `buddi init`).
Database backups alone cannot restore credentials; preserve the vault and its master
key separately. A locked vault fails closed.

## Account lifecycle

The dashboard can add, rename, replace API keys, test, disable, enable and remove
accounts. Provider/authentication type is immutable: create another account to change
it. Changing a keyed endpoint requires re-entering the credential for that destination.
Saving a default model does not silently change models pinned on existing agents.

Assignments reload the shared catalog for new Dashboard, Telegram, delegated and
scheduled runs. Existing runs retain their selected account/model. Editing or disabling
an account causes its next model call to stop with a clear restart-turn message, rather
than silently rerouting or using an old credential. Requests already dispatched cannot
be recalled. Use **Refresh status** after unlocking a vault or changing accounts from
another process.

Removal is refused while an agent remains assigned; reassign those agents or disable
the account instead. Removal first disables and marks the account as being deleted,
then removes the stored credential and account metadata. If vault deletion fails, the
account remains disabled and cannot be re-enabled; unlock the vault and retry removal.
This does not revoke keys at their issuer, erase backups, or delete retained legacy
credential copies that are no longer referenced by this account.

**Test connection** is an explicit owner action and may incur a small charge. It sends
only a fixed short prompt, no history, files or tools. It has a 15-second timeout and
no HTTP-status retries. Responses report safe connection/auth/rate-limit status, never
raw provider errors or credentials. A result for an edited account is discarded.

## API and CLI

Owner-only routes inherit session, Origin, CSRF, body-size and no-store protections:

- `GET /api/provider-accounts`
- `POST /api/provider-accounts/save`
- `POST /api/provider-accounts/:id/test`
- `POST /api/provider-accounts/:id/remove` with the displayed `revision`
- `POST /api/agents/:id/account` with `accountId` and `model`

Edits also require the displayed account revision to prevent stale overwrites. Global
provider/credential mutation endpoints return 410 when account management is active.
These operations are not exposed as agent tools.

`buddi agents` and `buddi agents show <handle>` read the account-aware catalog.
`buddi agents set <handle> --account <id> --model <model>` changes a binding;
`--model` alone changes the model on its current account. `--provider` is refused after
migration because it is ambiguous. `buddi agents test <handle>` uses the assigned account.
Restart other running processes after a standalone CLI edit, or refresh Settings →
Model accounts. Dashboard edits take effect in its shared serving process immediately.

The account/domain layer is portable. OAuth and native-client credentials are
resolved server-side; agent tools never receive the credential envelopes.

## Subscription support: what "complete" means

Two subscription sign-ins exist — [Claude](anthropic-oauth.md) and
[ChatGPT through Codex](codex-accounts.md) — and both are offered by default.
This is the checklist a subscription backend is held to:

- **Isolated identity.** A distinct account backend and auth identity, with
  isolated credentials and sessions. Signing in or out of one account must not
  affect another, or the owner's own CLI login.
- **The whole lifecycle in the dashboard.** Start, cancel, reconnect and sign
  out, with bounded polling, stale-login protection, cleanup after a restart,
  and explicit guidance when the native client is missing.
- **No credential anywhere it does not belong.** Not in SQL plaintext, not in
  URLs or logs, not in chat, tools or browser storage. Native credential
  storage is an explicit decision, never a quiet bypass of the vault's
  guarantees.
- **Native tool calls go through buddi.** Every tool call from a native runtime
  passes buddi's existing grants and approvals. No native shell, file, browser
  or computer backdoor, proven with adversarial tests before use.
- **Semantics preserved.** Conversation and tool-result semantics, images,
  cancellation and approval resume all survive. A model or tool capability the
  native runtime lacks is reported explicitly, never silently dropped.
- **Status only when the provider supplies it.** Token expiry, subscription
  renewal, usage reset and last-check are four different things and are not
  inferred from one another. A generic 429 does not prove subscription
  exhaustion, and `Retry-After` is not a guaranteed reset time.
- **Serialized refresh.** Per-account refresh serialization; a disabled or
  removed account can neither refresh nor run.
- **Tested on every surface.** Dashboard, Telegram, CLI, delegates and
  scheduled runs. Owner-assisted real sign-in only after the harness passes,
  and no automatic paid test requests.
