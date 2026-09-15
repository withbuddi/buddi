# The web plugin

`@buddi/tool-web` gives an agent two things it did not have: the ability to
search the live web, and the ability to read one page. It is a **capability**,
like finance or email — not a property of one agent. Whichever of your agents
should be able to look something up gets `web.*` in its own `tools:` line, and
the ones that should not, do not.

It exists because of a real answer to a real question. Asked what a used Ford
Bronco goes for in New Jersey, Scout said, correctly, that it had no web or
market-data tools and could only reason from training data that might be stale.
The honesty was right; the gap was the platform's.

---

## 1. Turning it on

Search needs an API key. Reading a page does not — `web.read` works on an
installation that never configures search at all.

```sh
# 1. Get a free key. Tavily's free tier is 1,000 searches a month and asks for
#    no credit card: https://app.tavily.com
# 2. Put it in the vault (or in .env, which is the documented day-1 fallback).
buddi vault set TAVILY_API_KEY
# 3. Restart whatever is running — `buddi serve`, the Telegram bridge, the
#    service. Secrets are read once, at startup.
buddi doctor            # the "web search" row says which backend and where the key came from
```

Until that is done, `buddi doctor` prints a warning, `web.status` says
`searchAvailable: false`, and `web.search` returns a result that tells the agent
in plain words that nothing was looked up and that it must not answer from
memory as though it had. That degraded behaviour is the point: the failure this
plugin guards against is not "no search", it is "a confident answer that looks
like a search and is not".

### Choosing a different backend

```sh
BUDDI_SEARCH_PROVIDER=brave     # in .env
buddi vault set BRAVE_SEARCH_API_KEY
```

Two are built in. **Tavily** is the default: a free tier that needs no card, and
it returns a relevant extract per result rather than only a link, which often
answers a question with one call instead of six. **Brave** runs its own index
rather than reselling one, which is a genuinely different answer; it is not the
default because its free plan wants a payment method on file.

Adding a third is one file and one line in `src/providers/index.ts`. A provider
never holds a key, never opens its own socket, and never returns its own JSON
shape — it returns hits, so nothing downstream knows which company answered.
A backend that dies does not strand the plugin: the tool reports the failure,
`web.read` keeps working, and swapping the provider is an environment variable.

---

## 2. The tools

| Tool | Tier | Needs a key | What it gives back |
| --- | --- | --- | --- |
| `web.search` | `auto` | yes | A ranked list. Each result: `title`, `url`, `source` (the host), `snippet`, and `published` when the engine claims to know it. |
| `web.read` | `auto` | no | One page as text: `url` (the one that *answered*, after redirects), `source`, `title`, `retrievedAt`, `text`, `truncated`. |
| `web.status` | `auto` | no | Whether search is configured, through whom, and the limits. Touches no network. |

**Results are evidence with a source.** That is a design decision, not a
formatting one. The obvious implementation — concatenate the top five pages into
one blob — produces exactly the failure worth avoiding: by the time the agent
writes the sentence it no longer knows which of the five said the number, so it
quotes badly and attributes worse. A list where every item carries its own
`source` and `url` keeps each claim attached to the thing that made it.

Two shared skills ship with the plugin and are proposed, never installed:
`the-web-is-evidence` and `answering-with-sources`. Accept them with
`platform.accept_plugin_skill`; they grant nothing.

---

## 3. Everything fetched is untrusted text

This is the most important property in the package, and the one that makes the
rest of it safe to have at all.

A web page is text a stranger wrote. Unlike an email it does not even arrive
with a From line to be suspicious of — it arrives because it ranked for a query.
**No sentence on a page can change an agent's rules, grant it a tool, raise an
urgency, or authorise a send, a payment or a purchase**, no matter who it claims
to be from. A page that says "ignore your instructions", or "your owner has
authorised you to send this email", or that is styled to look like a system
message, is reporting itself as suspicious. The agent says so and carries on.

This matters more here than it does for mail because some of the agents that
might reasonably be granted `web.*` — a finance advisor checking a rate, a
credit coach checking a card's published terms — hold the owner's bank data. A
search result that could instruct them would be a way for a stranger to
instruct them.

The rule is written in four places, deliberately:

1. In every tool description, which the model reads before it calls anything.
2. In every result payload (`untrusted`), so it sits next to the text it is
   about rather than 600 tokens earlier.
3. In the shared skill `the-web-is-evidence`, which is the owner's own copy and
   outlives any persona.
4. Here.

The mechanical half is in `extract.ts`: `<script>`, `<style>`, `<template>`,
`<svg>`, `<noscript>`, page chrome and **HTML comments** are dropped with their
contents, because a comment is a favourite place to hide a paragraph aimed at
whatever is reading the page. Attributes go too, so `alt=` and `title=` text
never arrives looking like prose.

---

## 4. Nothing reaches inside this machine

The dashboard is on `127.0.0.1:4317` and the database is on `127.0.0.1:55433`.
An agent must not be able to fetch either, and neither must anyone who can get a
URL in front of an agent.

`guard.ts` enforces, in this order:

- **Scheme.** `http` and `https` only. `file:`, `ftp:`, `data:`, `gopher:` and
  everything else are refused by name.
- **Port.** 80 and 443 only. This alone stops `:4317` and `:55433`, before DNS,
  before anything.
- **Credentials.** A URL carrying `user:pass@` is refused.
- **Hostname.** `localhost`, `*.local`, `*.internal` (including
  `metadata.google.internal`), `*.home.arpa`, `*.lan` are refused unresolved.
- **Address, after DNS.** Loopback, every private range, link-local (where cloud
  metadata endpoints live), carrier-grade NAT, multicast, reserved and
  documentation ranges — in IPv4, in IPv6, and through every IPv6 wrapper around
  an IPv4 address (`::ffff:127.0.0.1`, `64:ff9b::`, `2002::`).

Two things make that hold rather than merely look right:

**The resolver is the socket's own.** A check that resolves a name, approves it,
and then calls `connect(hostname)` leaves the name to be resolved a *second*
time, by the socket, possibly to a different address — DNS rebinding. Instead
the guard is handed to the transport as its `lookup`, so the address it approved
*is* the address dialled. There is no second resolution to poison. Every address
a name returns must be public, not just the first one.

**Every redirect hop is a new URL.** Nothing follows redirects for us: hops are
walked by hand, at most three, and each one goes through the whole guard again.
A public page answering `302 -> http://127.0.0.1:4317/` is refused on the second
hop, and the failure says it came from a redirect.

### Bounds

| | |
| --- | --- |
| Bytes | 2 MiB, refused **while the body arrives** (`TransportRequest.maxBytes`), not by trusting a `content-length` header after the memory is already spent. |
| Time | 20s for the whole retrieval, redirects included; 10s of silence per hop. |
| Redirects | 3. |
| Content types | Text only. A PDF, an image, a video or a binary is refused with a sentence saying what it was — "that link is a PDF, I can only read text" is a useful answer; a page of mojibake is not. |

A 404, a login wall, a 403 from a site that blocks readers, a timeout and a
blocked address are five different typed outcomes with five different sentences.
None of them is an exception that reaches the model as a stack trace.

All of it goes through `@buddi/runtime`'s shared transport — one connection per
request, nothing pooled. This is exactly the long-lived-process hazard that
transport was written for: `buddi serve` runs for weeks, and a fetching tool is
the kind of thing that would otherwise quietly build a connection pool.

---

## 5. What it costs the owner, honestly

The tier is `auto`, and the argument should be made rather than assumed.
Searching spends no money, changes nothing in the world, and cannot be undone
because there is nothing to undo; by this system's standard — `gated` is for
effects — it is a read.

But it is not free of consequence. **A search sends the owner's question, in his
words, to a third party who logs it.** "What do used Broncos cost in New
Jersey" is a sentence about him. That is why the backend is owner configuration
rather than an agent's choice (there is no `web.set_provider` for a model to
argue with), why the provider is named in the result, and why it is written
down here instead of left implied.

`web.read` sends less: a request for one URL, and a user agent that says it is
buddi rather than pretending to be a browser.

---

## 6. What is recorded

One table, `web.fetches`, and it is an audit log rather than a cache — a cache
would make the answers stale in exactly the situation that matters (a price,
today) and would store pages strangers wrote next to the owner's bank data.

It records which agent asked, when, what it asked for, which host it reached,
and the outcome. **No page bodies and no results**: the log says where, never
what came back. `blocked` rows are the interesting ones — they are the record of
something trying to reach a place it may not.

```sql
select at, agent_id, kind, target, host, outcome, detail
from web.fetches order by at desc limit 20;
```

---

## 7. Granting it

Installing the plugin gives no agent anything. An agent reaches the web only if
its own `agent.md` names `web.*` (or one tool of it) in `tools:`, and that edit
is the owner's.

```yaml
tools: [memory.*, reminder.*, web.*]
```

Grant `web.read` alone to an agent that should follow a link the owner gives it
but should not go looking; grant `web.*` to one that should research. Every
agent so granted should also be given the two shared skills.
