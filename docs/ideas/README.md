# Future ideas

A lightweight backlog for possibilities worth remembering, not a commitment to
implement them. Keep ideas in the repository so they stay available across
conversations and can be reviewed alongside the code. When we accept an idea it
moves to [`docs/specs/`](../specs/); when it is actually built, it is folded
into the matching page under [`docs/`](../) and this file is deleted.

## Index

| Idea | Status | Summary |
| --- | --- | --- |
| [Reusable Codex adapter](reusable-codex-adapter.md) | Proposed | Extract the backend integration into a package other projects can consume. |
| [Voice](voice.md) | Proposed | Voice notes on Telegram, press-to-talk and read-aloud on the dashboard. |
| [buddi as an MCP server](mcp.md) | Idea, parked | Expose buddi's own agents over MCP; parked, not pursued. |

Moved on: [owner secrets](../specs/owner-secrets.md) was accepted and is now a
spec; the Codex App Server experiment shipped behind `BUDDI_CODEX_EXPERIMENT` and
is now reference at [codex-accounts.md](../codex-accounts.md).

## How to use this folder

- Copy [the template](_template.md) into a descriptive `kebab-case.md` filename
  and add it to the index.
- Capture the problem, rough approach, open questions, and next decision. A few
  paragraphs are enough; speculative ideas do not need implementation plans.
- Use statuses: **Proposed**, **Exploring**, **Accepted**, **Deferred**, or
  **Dropped**. Keep the index and the idea's status in sync.
- When we agree to implement an idea, move its file to `docs/specs/` and mark
  it accepted there; track execution against the roadmap, not a checklist here.
- Once an accepted idea is actually built, fold what it describes into the
  matching reference page under `docs/` and delete both the spec and this
  entry. See [`docs/ROADMAP.md`](../ROADMAP.md) for what is built and what is
  in progress.
- Keep deferred/dropped ideas with a brief reason so we remember the decision.
- Never include secrets, tokens, or private user data.

Architecture decision records serve a different purpose: they document decisions
we actually made and why. This folder is for possibilities before that point.
