# Extract a reusable Codex App Server adapter

Status: Proposed
Captured: 2026-09-19

## Problem / opportunity

Reuse Buddi's Codex integration in another backend or desktop project without
copying Buddi's gateway, database, or agent architecture. This would play a
similar reuse role to `extension-ai-connect`, but for Node.js applications rather
than browser extensions.

## Possible approach

After stabilizing the experiment, extract a focused package with Buddi as its
first consumer. Candidate responsibilities:

- Codex process lifecycle and RPC transport.
- Managed ChatGPT sign-in, reconnect, and refresh integration.
- Model discovery, turns, streamed events, and tool-request bridging.
- Cancellation, normalized errors, private credential staging, and cleanup.

Consumers supply credential storage and account coordination, conversation
history, tools, and approval policy. Buddi retains its database, agent personas,
memory, routing, Dashboard, Telegram, and permission decisions. Extraction must
preserve the existing isolation and tool-approval guarantees.

This is a proposed boundary, not a standalone package already available today.
Some account/session responsibilities currently live in Buddi's gateway.

## Open questions

- What is the smallest stable API needed by a second consumer?
- Which credential-store and cross-process locking hooks should consumers supply?
- How should supported Codex versions and protocol changes be managed?
- Should this begin as a workspace package before moving to a separate repository?
- What package name, license, and publishing scope should we use?

## Next decision

Stabilize the current adapter and identify a concrete second consumer. Then map
the reusable boundary and acceptance tests before approving extraction. Do not
expand it into a generic multi-provider framework without a demonstrated need.

## Related work

- [Codex experiment and contract](codex-app-server-experiment.md)
- [Provider accounts](../providers.md), [roadmap](../ROADMAP.md)
- Runtime: `packages/runtime/src/codex-app-server.ts`, `codex-session.ts`, and
  `codex-policy.ts`.
- Account integration: `packages/gateway/src/codex-accounts.ts`.
- Prior reuse example: sibling project `extension-ai-connect`.
