# Provider accounts: remaining work

This is the completion checklist, not a claim that subscription sign-in exists.

## Delivered

- Named API-key and compatible-endpoint accounts; explicit account/model per agent.
- No automatic credential fallback; account edits checked against revision.
- Keys remain in the vault, not in account metadata, agent tools, or browser storage.
- Readable connection diagnostics distinguish test time from provider retry advice.
  A generic 429 does not prove subscription exhaustion. Retry-After is not a
  guaranteed reset time. Raw provider errors are not returned to the dashboard.

## Next: subscription runtime decision

Recommended: add native-client backends, starting with official Codex App Server.
Owner choice requested before implementing this architectural expansion.

Verified documentation:

- https://learn.chatgpt.com/docs/app-server documents managed ChatGPT browser/device
  login, cancel/logout, automatic refresh, account information and rate-limit reads.
- https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
  directs third-party applications to API authentication and permits end users to
  sign in through the unmodified Claude Code binary. Do not transplant the existing
  extension's custom Claude subscription token flow as a supported Buddi login.

The reusable extension package is browser-storage/text-completion oriented.
Its direct token endpoints are not a substitute for a supported native runtime.
API-key accounts and current legacy bindings must remain intact during this work.

## Acceptance checks before calling subscription support complete

- Distinct account backend/auth identity, with isolated credentials and sessions.
  Signing in/out of one account must not affect another or the owner's existing CLI.
- Dashboard start/cancel/reconnect/sign-out flows, bounded polling, stale-login
  protection, restart cleanup and explicit missing-client guidance.
- No credentials in SQL plaintext, URLs/logs, chat, tools or browser storage.
  Decide native credential storage explicitly; do not quietly bypass vault guarantees.
- Native runtime tool calls must pass through Buddi's existing grants and approvals.
  No native shell/file/browser backdoor; prove this with adversarial tests before use.
- Preserve conversation/tool-result semantics, images, cancellation and approval resume.
  Native model/tool capability mismatches must be explicit, not silently dropped.
- Account status and plan details only when supplied by the provider. Token expiry,
  subscription renewal, usage reset and last check are distinct concepts.
- Per-account refresh serialization; disabled/removed accounts cannot refresh or run.
- Tests across Dashboard, Telegram, CLI, delegates and scheduled runs; owner-assisted
  real sign-in only after the test harness passes. No automatic paid test requests.

## Later, separate work

- Long-running browser context compaction and no-progress recovery.
- Multi-agent groups.
- Cross-platform encrypted-Postgres credential storage decision and migration.
