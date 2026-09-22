# buddi as an MCP server

Status: idea, parked 2026-09-21

The Model Context Protocol is how Claude Code, Claude Desktop, Cursor and
the rest reach tools and data that live somewhere else. buddi already has
what a server needs: a tool registry with tiers and approvals, agents with
personas, conversations, memory and artifacts. This is the contract for
exposing them, so that "ask my buddi" works from any MCP client on the
owner's machine or tailnet, with the same sign-in and the same approvals
the dashboard has.

## 1. What is exposed: one tool

`buddi.ask` `{ agent, message, conversation? }`: talk to one of the owner's
agents from an MCP client. It creates or continues a conversation exactly
as the dashboard would, runs the turn with the agent's memory, tools and
approvals, and returns the answer and the conversation id. Long turns
report progress through MCP progress notifications. The conversation
appears on the dashboard, attributed to the client ("asked through Claude
Code").

Nothing else. Plugin tools are not exposed directly: a second agent system
running the owner's bank tools without buddi's persona, memory and
projection rules is exactly the setup that gives stale answers. Resources
and prompts are protocol completeness nobody has asked for.

## 2. Transport: stdio only

`buddi mcp` on the owner's machine; the client launches it and it reaches
the running gateway over loopback with the dashboard's own token from the
data directory. No HTTP transport, no minted tokens, until a client on
another device is actually wanted.

## 3. Approvals

A gated action inside `buddi.ask` pauses the turn and produces the usual
approval card on the dashboard and Telegram; the MCP call waits with a
progress notification and resumes when the owner answers.

## 4. Acceptance

`claude mcp add buddi -- buddi mcp`, then "ask my finance advisor what is
due before payday" from Claude Code answers through the advisor and the
conversation appears on the dashboard, attributed. One day.
