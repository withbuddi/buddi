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
server, and **Another server** for anything else. Connecting is four short
screens.

1. **Address.** A card fills it in; Another server asks for an `https://`
   address. buddi opens the server, reads its name and what it offers, and
   finds out whether it wants you to sign in. Nothing else is sent.
2. **Sign in.** When the service asks for a sign-in, buddi registers itself
   with the service's sign-in server (nothing is pre-registered anywhere, and
   there is no key to paste), then opens the service's own consent page in a
   new tab. You say yes there. The page sends you back to your dashboard,
   `/connections/callback`, never to anyone else; that tab closes and the
   first one carries on. The sign-in only lands in the dashboard session
   that started it, and only once.

   A few services do not let an app register itself. Then the screen says so
   in one sentence and asks for a client id you create in the service's
   developer settings, with the redirect address it shows.
3. **Review.** Every tool the server lists, one row each: the name buddi
   gives it, the server's own description, and its tier. Read it before you
   keep it: a connection brings nothing until you do. You also choose the
   connection's name here (`github`, say), which every one of its tools
   carries.
4. **Give.** "Give these tools to Buddi?", with your front desk ticked and
   your other agents listed. Yes writes `mcp.github.*` on each chosen agent's
   `tools:` line, through the same path Agent Father's changes take. You can
   also give them to nobody: the connection waits in Settings.

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
address. No agent, tool result, log or page ever sees it, and the output
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
  sign-in server does not let an app register itself, so connecting GitHub
  asks for a client id from a GitHub OAuth app you create, with the redirect
  address the screen shows.
