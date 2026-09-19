# Future ideas

A lightweight backlog for possibilities worth remembering, not a commitment to
implement them. Keep ideas in the repository so they stay available across
conversations and can be reviewed alongside the code.

## Index

| Idea | Status | Summary |
| --- | --- | --- |
| [Reusable Codex adapter](reusable-codex-adapter.md) | Proposed | Extract the backend integration into a package other projects can consume. |
| [Anthropic subscription login](anthropic-subscription-login.md) | Proposed | Contained account-level OAuth login and refresh, using the existing Anthropic runtime. |

Existing tracked work remains in the [provider roadmap](../provider-roadmap.md);
link to it instead of duplicating its checklist here.

## How to use this folder

- Copy [the template](_template.md) into a descriptive `kebab-case.md` filename
  and add it to the index.
- Capture the problem, rough approach, open questions, and next decision. A few
  paragraphs are enough; speculative ideas do not need implementation plans.
- Use statuses: **Proposed**, **Exploring**, **Accepted**, **Deferred**, or
  **Dropped**. Keep the index and the idea's status in sync.
- When we agree to implement an idea, mark it Accepted and link its implementation
  plan or issue. Track execution there, not in two competing checklists.
- Keep deferred/dropped ideas with a brief reason so we remember the decision.
- Never include secrets, tokens, or private user data.

Architecture decision records serve a different purpose: they document decisions
we actually made and why. This folder is for possibilities before that point.
