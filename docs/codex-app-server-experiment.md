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

The prototype is deliberately **not exported from the runtime package or wired
into provider account selection**. There is no Dashboard sign-in button yet.

## Live-use gate: native tool isolation

The installed binary still advertises `request_user_input` and the `skills`
namespace even with native shell, execution, browser, computer, apps, plugins,
image generation, delegation and host skill discovery disabled. The contract test
records that inventory; a passing inventory test does not mean the desired
Buddi-only allowlist has been achieved.

Rejecting an approval request or reacting to a native activity notification is not
sufficient proof that an internal read already performed by Codex was prevented.
Before owner data/sign-in can be enabled, establish a supported allowlist or an
enforced isolation boundary, including proving what the built-in skills reader can
access. Do not replace this requirement with a system-prompt instruction.

Other intentional limits:

- No exact per-completion `maxTokens` equivalent has been verified. Requests with
  this cap are rejected rather than quietly bypassing a cost/testing constraint.
- Usage is recorded when delivered but not advertised as reliably available for
  interrupted tool-proposal completions.
- PDFs and opaque provider blocks reject explicitly; image history translation has
  unit coverage, not a real vision-model test.
- Replay currently rejects history containing a tool no longer granted.
- Native account keyring separation, refresh, login/cancel/logout, disabled-account
  cancellation, and UI status still need implementation and verification.
- No credentials were migrated and no existing CLI login was reused.

## Repeat the offline checks

```sh
pnpm --filter @buddi/runtime exec vitest run src/codex-app-server.test.ts src/codex-rpc.test.ts
BUDDI_TEST_CODEX=1 pnpm --filter @buddi/runtime exec vitest run src/codex-installed.test.ts
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

Keep this experiment opt-in and separate from main until the gates are resolved.
