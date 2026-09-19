# Codex App Server experiment

Branch: `experiment/codex-app-server`. Existing accounts and live bindings are unchanged.

## Current result

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

## Try the experiment

Set `BUDDI_CODEX_EXPERIMENT=1` on the gateway/CLI host, apply core migration 019,
build, and restart the service. The current development host has this enabled.
In Provider accounts, add **Codex — ChatGPT subscription (experimental)**, click
**Connect ChatGPT**, and complete the displayed device authorization yourself.
Then assign the account/model to an agent and send a test chat. Existing accounts
are never reassigned automatically. All surfaces use the same account resolver.

Owner-assisted device sign-in succeeded on the development host on September 19,
2026; the account reports connected, with no agent assignments at verification.
No paid model call was initiated by the implementation agent. A real chat/tool
round trip remains the final acceptance check. The host must have
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

## Subscription credentials and lifecycle

- Codex's official device flow handles login and refresh; no custom token endpoint.
- Durable credentials are in the existing Buddi vault under independent account
  references. No secret value is stored in Postgres, UI state, or logs.
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

Keep this experiment opt-in and separate from main until owner acceptance. Before
switching a running installation back to main, reassign agents away from Codex
accounts and remove those experimental accounts. There is no automatic migration
of a native subscription into an API-key provider.
