# buddi as an MCP server

Status: draft for the owner's review, 2026-09-21. Nothing here is built.

The Model Context Protocol is how Claude Code, Claude Desktop, Cursor and
the rest reach tools and data that live somewhere else. buddi already has
what a server needs: a tool registry with tiers and approvals, agents with
personas, conversations, memory and artifacts. This is the contract for
exposing them, so that "ask my buddi" works from any MCP client on the
owner's machine or tailnet, with the same sign-in and the same approvals
the dashboard has.

## 1. What is exposed

**Tools**, a curated set, not the whole registry:

- `buddi.ask` `{ agent, message, conversation? }`: talk to one of the
  owner's agents. Creates or continues a conversation exactly as the
  dashboard would, runs the turn, returns the agent's answer and the
  conversation id. Long turns report progress through MCP progress
  notifications. This one tool is most of the value: an MCP client does
  not need buddi's tools, it needs buddi's agents.
- `buddi.agents`: the roster with ids, handles, roles, availability.
- `buddi.remember` and `buddi.recall`: the memory plugin's note and search,
  attributed to the calling client.
- `buddi.artifacts.list` and `buddi.artifacts.read`: the owner's files.
- Plugin tools the owner allows: Settings → MCP has a checklist of installed
  plugins' `auto` tools that may be called directly (finance reads, email
  reads, web reads). `gated`, `draft` and `session` tools are never called
  directly through MCP; they run only inside `buddi.ask`, where the agent
  asks and the owner approves as today.

**Resources**: `buddi://agents/<id>` (the agent file, read-only),
`buddi://conversations/<id>` (a transcript, text form, hidden speakers
removed), `buddi://memory` (the owner's notes), `buddi://artifacts/<id>`.
Templates listed, contents on demand, changes announced with the
protocol's list-changed notifications.

**Prompts**: one per agent, the persona as a prompt template, so a client
can "be" the Concierge without going through buddi's runtime.

## 2. Transports and sign-in

- **stdio**: `buddi mcp` on the owner's machine. The client launches it;
  it connects to the running gateway over loopback with the dashboard's
  own token from the data directory. Local trust, as the CLI has today.
- **HTTP** (streamable HTTP, the current spec): `/mcp` on the gateway,
  reachable on loopback and, through Tailscale, on the tailnet. Sign-in is
  a bearer token the owner mints on Settings → MCP ("Add a client": a
  name, a token shown once, revocable). Tailscale sign-in also counts, so
  a client on a tailnet device needs no token. The token is stored hashed,
  like the extension's.
- Every call is attributed: the client's name appears in the conversation
  it created ("asked through Claude Code") and in the Activity page.

## 3. Approvals

A gated action inside `buddi.ask` pauses the turn and produces the same
approval card on the dashboard and Telegram. The MCP call waits, sending
progress notifications ("waiting for your approval on the dashboard"), and
resumes when the owner answers, or ends with the refusal. MCP clients do
not get their own approval channel: the owner approves where they already
do.

## 4. What is refused

Direct calls to gated tools; any tool of an agent held back or unbound;
resources of a conversation the owner has deleted; anything when the
installation is in recovery mode.

## 5. Settings → MCP

Enable; the clients list with names, last seen, revoke; the allowed
direct tools checklist; the stdio command and the HTTP address shown with
the words to paste into Claude Code and Claude Desktop.

## 6. Acceptance

1. `claude mcp add buddi -- buddi mcp` then "ask my finance advisor what is
   due before payday" from Claude Code answers through the advisor and the
   conversation appears on the dashboard, attributed.
2. A gated action asked through MCP waits for the dashboard approval and
   completes after it.
3. A revoked token or a disabled MCP answers the protocol's unauthorized
   error, and doctor shows the clients.
4. The tarball smoke adds an MCP client round trip over stdio.

## 7. Order of work

Server core with `buddi.ask`, agents and memory over stdio (one day); HTTP
with tokens and the Settings page (one day); resources, prompts and the
allowed-tools checklist (one day); reviews and the smoke.
