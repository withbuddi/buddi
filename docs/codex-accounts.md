---
title: "Codex ChatGPT accounts"
status: reference
updated: 2026-09-25
---

# Codex ChatGPT accounts

Codex ChatGPT accounts are built and live behind `BUDDI_CODEX_EXPERIMENT=1`; they
are off unless the flag is set. This page is the reference for what the adapter
does, what it deliberately refuses, and what is still missing. Existing accounts
and live bindings are unchanged by turning the flag on. See
[providers.md](providers.md) for the account model all provider accounts share.

## What is built

The protocol prototype implements Buddi's `RuntimeProvider` interface. Installed
`codex-cli 0.155.0` has been tested against a loopback fake Responses server, without
login, real credentials, model calls, or charges. Both text and a two-completion
tool round trip pass against the actual binary.

- NDJSON initialization and experimental dynamic tools.
- One ephemeral native thread and child per completion; no process waits through
  a Buddi approval pause. No app-server history becomes the system of record.
- `thread/inject_items` carries real message roles, tool call IDs, tool results and
  image data URLs. `turn/start` with empty input continues the injected history.
- Dynamic tool requests return neutral proposals. The child closes before the
  caller can dispatch the proposal through Buddi. No native tool result is answered.
- Cancellation, deadlines, process exit, malformed frames and native server requests
  fail closed. Raw stderr and provider error bodies are not surfaced.
- Configured child environments exclude ambient provider keys and use a distinct
  native profile. This is not a proven operating-system sandbox.

## Turning it on

Set `BUDDI_CODEX_EXPERIMENT=1` on the gateway/CLI host, apply core migration 019,
build, and restart the service. The current development host has this enabled.
In Settings → Model accounts, add **Codex — ChatGPT subscription (experimental)**, click
**Connect ChatGPT**, and complete the displayed device authorization yourself.
Then assign the account/model to an agent and send a test chat. Existing accounts
are never reassigned automatically. All surfaces use the same account resolver.

Owner-assisted device sign-in succeeded on the development host on September 19,
2026. Scout is assigned to `gpt-5.6-terra` at the owner's request; a live greeting
and a clock-tool proposal/result round trip succeeded through the subscription.
Those diagnostic model calls used the subscription allowance. `gpt-5` was rejected
by this account and is no longer prefilled for new Codex accounts. Unsupported
model errors now direct the owner to agent settings without exposing raw responses.
The host must have
`codex-cli 0.155.0`; different versions fail closed until
their tool contract is tested. Windows is currently blocked pending private-folder
ACL validation; Linux code paths have not been exercised on this macOS host.

## Native tool isolation

The installed binary still advertises `request_user_input` and the `skills`
namespace even with native shell, execution, browser, computer, apps, plugins,
image generation, delegation and host skill discovery disabled. The adapter now
checks effective configuration, refuses configured active MCP servers, disables
every discovered skill **in its disposable profile only**, and verifies that all
remain disabled before starting a model turn. No user skill file is changed.

Rejecting an approval request or reacting to a native activity notification is not
sufficient proof that an internal read already performed by Codex was prevented.
The installed-binary tests now exercise both skill authorities (empty catalogs),
an arbitrary-path read (rejected), an injected local skill (not sent to the model),
and a direct native exec request (unsupported, no sentinel file contents returned).
Native question requests are rejected. Environment/capability roots are empty;
actual Buddi tool proposals still go through the normal runtime grants/approvals.
This is a verified configuration contract for the pinned binary, not a general
operating-system sandbox or a claim about future Codex versions.

The internal `code_mode_host` dispatcher must remain enabled for modern-model
dynamic tool calls. Disabling it let text chat succeed but returned a tool-host
disabled result instead of reaching Buddi. Native code mode, shell, browser and
computer features remain disabled; the installed-binary inventory, skill-read
and shell-isolation checks pass with the dispatcher enabled.

## Subscription credentials and lifecycle

### Account model pickers

Saved, connected accounts offer model dropdowns in **Edit account** and agent
account assignments. Codex uses its native `model/list`; HTTP accounts use their
own `/models` endpoint (Anthropic uses `/v1/models`). Lists are account-scoped,
cached in memory for 60 seconds, and invalidated on account revision changes.
**Refresh models** bypasses the cache; concurrent requests are coalesced. Native
discovery uses the same account lock, vault staging, refresh and cleanup as chat,
but never creates a thread or model turn. Pagination, response size and duration
are bounded. Errors are sanitized, and the endpoint requires owner/CSRF/origin
checks and returns no-store responses.

Refreshing never changes the selected model. Unlisted selections stay visible;
**Custom model…** supports compatible endpoints, unsupported list APIs and custom
IDs. New accounts still need an initial model entered manually before saving and
connecting, since no authenticated account exists to query yet. A listed model
is not a guarantee that every Buddi tool or modality is supported.
Live model discovery was verified on the development host for the configured
Claude subscription token, OpenAI API-key account, and Codex ChatGPT account.
No model completion was sent by those checks.

### Credential handling

- Codex's official device flow handles login and refresh; no custom token endpoint.
- Durable credentials are in the existing Buddi vault under independent account
  references. No secret value is stored in Postgres, UI state, or logs.
- Subscription envelopes are normalized to single-line JSON before persistence.
  Existing multiline credentials returned as hexadecimal by macOS Keychain are
  decoded and validated in the Codex credential loader only; ordinary API keys
  are never interpreted as hex. This fixes the first Scout chat's vault-read
  failure without requiring another device sign-in.
- Each operation uses a newly created private 0700 profile/workspace, with a 0600
  staged native credential file. No normal CLI profile/keyring login is reused.
- Close the native child, validate refreshed credentials, save to the vault, then
  remove the directory. Marked private orphan directories with dead processes are
  cleaned on the next native-session start. A hard crash can leave a private
  temporary file until that cleanup; a refresh interrupted by a crash may require
  reconnecting. Temporary files are not a permanent plaintext credential store.
- Login has a five-minute Buddi deadline, cancellation, stale-event checks, and
  redacted failure state. Polling stops when no login is pending or its deadline
  passes. A cancelled/failed reconnect preserves the old vault credential.
- PostgreSQL advisory locks serialize refresh across Dashboard, Telegram and CLI
  processes. Model completions wait up to two minutes without holding idle DB
  clients; control actions report busy if another process owns the account.
- Account revision/enabled state is checked before work and credential persistence.
  Local disable/disconnect cancels and drains work before changing credentials.
  Disconnect removes Buddi's credential; it does not revoke the subscription at
  OpenAI or affect the owner's regular Codex login.

Other intentional limits:

- No exact per-completion `maxTokens` equivalent has been verified. Requests with
  this cap are rejected rather than quietly bypassing a cost/testing constraint.
- Usage is recorded when delivered but not advertised as reliably available for
  interrupted tool-proposal completions.
- PDFs and opaque provider blocks reject explicitly; image history translation has
  unit coverage, not a real vision-model test.
- Replay currently rejects history containing a tool no longer granted.
- Plan/remaining-quota UI is not implemented. Renewal and token-expiry fields stay
  unknown. Do not interpret the app's API-cost/token totals as subscription billing;
  tool-proposal usage reporting is incomplete.
- No credentials were migrated and no existing CLI login was reused.
- The image plugin reaches a Codex account through `ToolContext.providerAccounts`
  `withCodexProfile`: the same vault read, account lock, private profile, scrubbed
  child environment and refresh-save as a completion, but the plugin runs its own
  `codex exec` with only native image generation on (shell, exec, web search,
  browser, MCP, apps and plugins off). It does not check the pinned App Server
  version: it does not use the App Server protocol.

## Repeat the offline checks

```sh
pnpm --filter @buddi/runtime exec vitest run src/codex-app-server.test.ts src/codex-rpc.test.ts
BUDDI_TEST_CODEX=1 pnpm --filter @buddi/runtime exec vitest run src/codex-installed.test.ts src/codex-session.test.ts
pnpm --filter @buddi/gateway exec vitest run src/codex-accounts.test.ts
```

The second command requires the installed `codex` executable and creates fresh
temporary profiles/workspaces. It uses a local fake model with authentication
disabled and ephemeral credential storage. It never loads the owner's Codex profile.
The native process owns its HTTP transport; Buddi's production HTTP boundary is
unchanged. The inbound loopback server exists only in tests.

## Basis

- Official protocol: https://learn.chatgpt.com/docs/app-server
- Configuration: https://learn.chatgpt.com/docs/config-file/config-reference
- Installed schema generated with
  `codex app-server generate-ts --out <temporary-directory> --experimental`.

The flag stays opt-in: the pinned-binary contract above is verified for one Codex
version and nothing else. Before turning the flag off on a running installation,
reassign agents away from Codex accounts and remove those accounts. There is no
automatic migration of a native subscription into an API-key provider.
