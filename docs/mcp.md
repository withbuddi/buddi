---
title: Using buddi from Claude Code
status: reference
updated: 2026-09-25
---

# Using buddi from Claude Code

`buddi mcp` runs buddi as an MCP server over stdio. Add it to Claude Code once:

```sh
claude mcp add buddi -- buddi mcp
```

Any other MCP client on this Mac works the same way: its command is `buddi mcp`.

Try: "which tools does @dev have, and which does its plugin suggest?", or "give
@dev the screenshot tool" and watch the card arrive on your phone.

## 1. Why

Set buddi up from Claude Code, or any MCP client on this Mac, instead of
clicking through the dashboard: grant a tool, move an agent to another account,
change a plugin setting, keep a proposal, ask an agent something. Everything
the dashboard can do as the owner is a route or an owner-side tool; this server
publishes that surface, with the same session and the same approvals.

## 2. The rule: an MCP client is a model, not the owner

A Claude Code session can be steered by whatever it reads. So:

- **Reads answer at once.** Listing and reading are side-effect-free and
  return what the dashboard would show. No secret ever leaves: provider keys,
  vault entries, OAuth tokens, database credentials and Telegram tokens are
  never in a result, only their labels and states. Credential fields, and
  anything shaped like a credential, come back as `[redacted]`.
- **Every write is an approval.** A write raises the ordinary approval card on
  the dashboard and on Telegram, headed "Requested through MCP (<client
  name>)", with the exact change as its envelope. The MCP call waits with
  progress notifications; approve with one tap and the call returns the
  result, reject and it says nothing changed. After 10 minutes it returns
  `{ pending: <action id> }` and the card stays open.
- **What stays hand-only stays hand-only.** The tools that create, change and
  remove agents' platform grants are refused here with the tool picker's
  sentence. Creating an agent is `buddi.ask` to your maker agent (Agent
  Father), whose own approval flow applies.

## 3. Transport and identity

`buddi mcp` (a CLI subcommand) speaks MCP over stdio. The client launches
it; it reaches the running service on the dashboard's loopback port with the
dashboard's own credential from the data directory, the way
`buddi dashboard --token` does. There is no HTTP transport and there are no
minted tokens.

It needs buddi running. If the service is down, every call answers with one
sentence saying so; `buddi service start` fixes it. With `BUDDI_WEB=0` there is
nothing to talk to.

The client's name from the MCP `initialize` handshake is recorded on every
write and on every `buddi.ask` conversation.

## 4. The tools

Named `buddi.<noun>_<verb>`, few and general rather than one per route.

Reads:

- `buddi.overview` — version, service state, agents with account/model and
  status, open approvals, open proposals, needs-you items.
- `buddi.agents_list`, `buddi.agent_read { agent }` — the agent's file
  (front matter and persona), its grant resolved, its skills (learned ones
  with version and provenance), its account binding, its delegates.
- `buddi.tools_list { agent? }` — every installed tool with plugin, tier and
  description; with `agent`, which are granted, which are core, and which
  its plugin template suggests since acceptance (the tool picker's data).
- `buddi.accounts_list` — provider accounts by label, kind and models.
- `buddi.pages_list`, `buddi.page_query { plugin, query, params }` — every
  plugin page's queries, through the `/api/pages` contract
  ([plugin-pages.md](plugin-pages.md) §3). A query marked `sensitive` is left
  out unless asked for.
- `buddi.proposals_list { state? }`, `buddi.activity { since?, kind? }`,
  `buddi.memory_list { agent? }`.

Writes, each an approval:

- `buddi.agent_update { agent, name?, handle?, description?, tools?, roles? }`
  — the Setup tab's save (`updateAgentFromOwner`), same refusals.
- `buddi.agent_engine { agent, account, model }` — the account selection.
- `buddi.default_agent { agent }`.
- `buddi.page_act { plugin, tool, input }` — a plugin page's write, through
  `POST /api/pages/<plugin>/act`, i.e. the plugin's owner tool.
- `buddi.proposal_decide { id, decision: keep|discard, edited?, reason? }`.
- `buddi.memory_edit { … }` — the Memory page's correct/forget.

Conversation:

- `buddi.ask { agent, message, conversation? }` — creates or continues a
  conversation exactly as the dashboard would, runs the turn with the agent's
  memory, tools and approvals, streams progress, and returns the answer and
  the conversation id. The conversation appears on the dashboard, and Activity
  records it as asked through MCP by the client. Pass the returned
  `conversation` id to continue it.

Resources and prompts: none.

## 5. End to end

1. `claude mcp add buddi -- buddi mcp`; "which tools does @dev have and
   which does its plugin suggest?" answers from `buddi.tools_list`.
2. "Give @dev the screenshot tool" produces one approval card on the
   dashboard and Telegram; tapping Approve changes the file, the MCP call
   returns the new grant, Activity says "through MCP (claude-code)".
3. Asking to grant `platform.create_agent` is refused with the tool
   picker's sentence.
4. No result anywhere contains a provider key or vault value. The test seeds
   known secrets and scans every read's output.
5. "Ask my finance advisor what is due before payday" runs through the
   advisor and the conversation shows on the dashboard, attributed.
