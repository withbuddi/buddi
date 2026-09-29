---
title: "Connections: services your agents can use"
status: reference
updated: 2026-09-29
---

# Connections

A connection is a service that speaks MCP, the Model Context Protocol:
GitHub, Notion, Linear, Sentry, Atlassian, Stripe, or any remote MCP server.
You connect it once, sign in on the service's own page, read every tool it
brings, and give those tools to the agents you choose. From then on an agent
can search your issues or read a page the way it reads your mail: through a
tool with a name, a tier and an approval card when it changes something.

Connections live in **Settings → Connections**.

## Connect

"Connect a service" shows a card for each service with an official remote
server, **Another server** for any other address, and **I have a config**
for the block another MCP client takes. Connecting is four short screens.

1. **Address.** A card fills it in; Another server asks for an `https://`
   address. buddi opens the server, reads its name and what it offers, and
   finds out whether it wants you to sign in. Nothing else is sent.
2. **Sign in.** A service that answered without asking skips this screen.
   Otherwise there are up to three ways in, as a row of choices when more
   than one applies:

   - **Sign in**, when the service lets buddi register itself with its
     sign-in server (nothing is pre-registered anywhere, and there is no key
     to paste). buddi fetches the service's consent page first; your click
     opens it in a new tab. You say yes there. The page sends you back to
     your dashboard, `/connections/callback`, never to anyone else; that tab
     closes and the first one carries on. The sign-in only lands in the
     dashboard session that started it, and only once.
   - **Token**: a token you make on the service's site (GitHub's card links
     to the page). buddi opens the server with it and lists its tools before
     it keeps anything, so a token the service refuses ("GitHub did not
     accept that token.") is never stored. Kept, it is one of your secrets,
     bound to that server's host and header, and sent on every request as
     `Authorization: Bearer <token>`. The header's name and the words before
     the token can be changed for a service that wants another.
   - **Client id**, when the service does not let an app register itself:
     one you create in its developer settings, with the redirect address the
     screen shows. buddi asks for it before it opens anything; the button
     then opens the service's page.

   GitHub opens on Token, and Sign in is its first choice for the others.
   A server that wants no sign-in at all needs none of these.
3. **Review.** Every tool the server lists, one row each: the name buddi
   gives it, the server's own description, and its tier. Read it before you
   keep it: a connection brings nothing until you do. You also choose the
   connection's name here (`github`, say), which every one of its tools
   carries.
4. **Give.** "Give these tools to Buddi?", with your front desk ticked and
   your other agents listed. Yes writes `mcp.github.*` on each chosen agent's
   `tools:` line, through the same path Agent Father's changes take. You can
   also give them to nobody: the connection waits in Settings.

### I have a config

Paste the block another app uses, the standard
`{ "mcpServers": { "<name>": { "url": "https://…", "headers": { "Authorization": "Bearer …" } } } }`
or just one server's `{ "url": …, "headers": … }`. buddi fills the address
and the connection's name from it, and turns the header into the Token
choice: its name, its value as the token, and `Bearer ` or `Basic ` as the
words before it when the value starts with one. A placeholder such as
`${GITHUB_TOKEN}` is not a token: the screen asks for the token itself. The
box is emptied once it is read, and the value is never shown or logged.

It refuses what buddi cannot connect: a `command` (a server that runs as a
program on this computer), a `"type": "sse"` server (buddi speaks Streamable
HTTP), and a block that names several servers at once.

### From the terminal

`buddi connections` walks the same four steps, through the running buddi
(it says so and exits 3 when buddi is not running):

```
buddi connections add github --token --to buddi
buddi connections add https://mcp.example.com/mcp --name Example
buddi connections add --json '{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" } } }'
buddi connections list
buddi connections review github [--keep]
buddi connections give github --to buddi,ledger
buddi connections remove github
```

`add` takes a card (`github`, `notion`…), an `https://` address, or a
config block with `--json`. It signs in the way the card recommends:
`--token` asks for the token with the terminal's echo off (`--token-stdin`
reads it from a pipe), `--client-id` takes a client id, and otherwise it
prints the service's consent link. Open it in any browser; the page sends
you back to your dashboard and the command carries on (it waits ten minutes
at most). That sign-in belongs to the command rather than to a dashboard
tab, so it lands in whichever dashboard session the page opens in, still
once and only for you. Then it prints every tool with its tier and asks
"Keep these tools?" (`--keep` answers yes, `--slug` names the connection),
and asks which agents get them, your front desk first (`--to` answers,
`--to nobody` keeps it waiting). Every step goes through the dashboard's
own routes, so the result is the same as the screens'.

## What an agent gets

Each tool is named `mcp.<connection>.<tool>`: `mcp.github.search_issues`,
`mcp.notion.create_page`. An agent file grants a whole connection with
`mcp.github.*`, or one tool by its name.

The tier comes from what the server says about the tool:

| The server says | The tier | What happens |
| --- | --- | --- |
| it only reads (`readOnlyHint`) | Runs on its own | The agent calls it. |
| it changes something, or says nothing | Asks you first | An approval card with the service, the tool and the exact arguments. You may remember the approval for that agent. |
| it destroys something (`destructiveHint`) | Asks you every time | An approval card, never remembered. |

A server that describes none of its tools gets a sentence at review saying
so, and every one of its tools asks first.

**Remembered approval.** A tool that asks you first can be lowered, for one
agent, to asking once: tick it on the Give screen (it applies to the agents
you ticked there), or on the agent's **Access** page under "Connection tools
that ask first". It is the same standing permission an approval card's
"Always" writes, and it is revoked the same way. A tool the server says
destroys something shows why it cannot be: it asks every time. Nothing is
ever lowered to running on its own.

What a tool answers is a message from a connected service, and buddi hands it
to the agent as that: data, never instructions. A picture it returns is shown
to the agent for that step and not kept; a link is a plain link.

## Tokens, and what leaves your machine

A connection's sign-in is kept in buddi's vault, one entry per connection
(`MCP_CONNECTION_…`), and renewed there when it runs out. It goes on the wire
only in the `Authorization` header of a request to that connection's own
address. A pasted token is one of your secrets (`MCP_TOKEN_…`, listed in
Settings → Secrets), bound to that connection's host and header; it goes
nowhere else. Deleting it there makes the connection ask to be reconnected. No agent, tool result, log or page ever sees it, and the output
scrubber knows it.

What leaves your machine for a connection:

- to the service's address: the opening handshake, the tool list, and each
  call an agent makes with its arguments;
- to the service's sign-in server: the registration, the code exchange after
  you said yes, and the renewals.

Only `https://` addresses are used, a request goes only to the exact host
you connected, and no redirect is followed. Which agent asked and in which
conversation stay on your machine, in the approval record.

Each connection's host is declared to buddi's network list the moment you
add it, the way a plugin's `network` is, and taken back when you disconnect:
**Settings → Plugins** lists it under the `mcp` plugin ("Talks to
mcp.notion.com, …"), beside every other host this installation reaches.

## Disconnect, reconnect, review again

- **Disconnect** says first which agents hold the connection's tools. Then it
  takes `mcp.<connection>.…` out of each of those agent files, removes the
  sign-in from the vault, and forgets the tools.
- **Reconnect** is the sign-in again, with the tools and the grants as they
  were. When a sign-in runs out without a way to renew it, or the service
  refuses it, the connection says **Needs reconnect**, and every one of its
  tools answers with one sentence saying so instead of running.
- **Review again** reads the server's list afresh; the connection keeps its
  name.

### When a server changes its tools

When a connection's session opens, and at most once an hour after that,
buddi lists the server's tools and compares them with what you reviewed
(each tool's name, description, input schema and annotations are hashed at
review). The same list: nothing happens. A different one:

- tools that are **new**, or whose description, schema or annotations
  **changed**, are not registered: no agent can call them, and a call already
  on its way answers one sentence saying the tool waits for your review;
- tools that are **unchanged keep working**;
- a tool the server **dropped** is removed with them;
- the connection says **Changed its tools**, and **Review again** is the
  primary button on its row.

The review screen then lists what changed (new, changed, gone) above the
tools, and marks each one. Keeping it hashes the new list and registers it.
A server that goes back to the list you reviewed is connected again without
a review.

### When it needs you

A connection that needs a sign-in again, or another review, says so in two
places besides its row: one line on **Home** under the greeting ("GitHub
needs you to sign in again.", "Notion changed its tools; review them."), each
linking to Settings → Connections, and the dot on **Settings** in the rail,
with the same dot on Connections in the settings list.

### When it does not answer

A connection that does not answer a call is **Unreachable**. buddi tries it
again in the background, 1, 5, 15 and 60 minutes after, then every hour, and
it is **Connected** again the first time it answers (or asks for a review,
when its list changed meanwhile, or a sign-in, when the service refuses the
old one). Its row says "Unreachable since <time>, retrying."

## Limits

- Remote servers only, over Streamable HTTP. A server that runs as a program
  on your computer (started with `npx`, `uvx` or a local address) is not
  supported: that is a program in your home directory, and buddi does not run
  one it cannot show you first.
- Tools only. A server's resources and prompts are not used.
- The cards' addresses were each checked on 2026-09-28 (the server answered
  with its sign-in challenge and its sign-in server's details). GitHub's
  sign-in server does not let an app register itself, so GitHub opens on a
  personal access token; a client id from a GitHub OAuth app you create
  still works.
