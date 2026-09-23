# Using buddi from Claude Code

Status: reference, 2026-09-23. Spec: [specs/mcp.md](specs/mcp.md).

`buddi mcp` runs buddi as an MCP server over stdio. Add it to Claude Code once:

```sh
claude mcp add buddi -- buddi mcp
```

Any other MCP client on this Mac works the same way: its command is `buddi mcp`.

## What to expect

- **It needs buddi running.** `buddi mcp` talks to the running service on the
  dashboard's loopback port, with the dashboard's own session. If the service is
  down, every call answers with one sentence saying so; `buddi service start`
  fixes it. With `BUDDI_WEB=0` there is nothing to talk to.
- **Reads answer at once.** `buddi.overview`, `buddi.agents_list`,
  `buddi.agent_read`, `buddi.tools_list`, `buddi.accounts_list`,
  `buddi.pages_list`, `buddi.page_query`, `buddi.proposals_list`,
  `buddi.activity` and `buddi.memory_list` return what the dashboard shows. No
  key, token, password or vault value is ever in a result: credential fields
  and anything shaped like a credential come back as `[redacted]`.
- **Every write is an approval.** `buddi.agent_update`, `buddi.agent_engine`,
  `buddi.default_agent`, `buddi.page_act`, `buddi.proposal_decide` and
  `buddi.memory_edit` raise the ordinary approval card on the dashboard and on
  Telegram, headed "Requested through MCP (claude-code)" with the exact change
  underneath. Claude Code shows progress while it waits; approve with one tap
  and the call returns the result, reject and it says nothing changed. After
  ten minutes it returns `{ pending: <action id> }` and the card stays open.
- **Hand-only stays hand-only.** Granting the tools that create, change or
  remove agents is refused with the tool picker's sentence. To create an agent,
  `buddi.ask` your maker agent (Agent Father).
- **`buddi.ask`** talks to one agent the way the dashboard chat does, with its
  memory, tools and approvals. The conversation appears on the dashboard, and
  Activity records it as asked through MCP by the client. Pass the returned
  `conversation` id to continue it.

Try: "which tools does @dev have, and which does its plugin suggest?", or "give
@dev the screenshot tool" and watch the card arrive on your phone.
