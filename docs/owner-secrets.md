---
title: Secrets the agent can use but never see
status: reference
updated: 2026-09-25
---

# Secrets the agent can use but never see

The owner's passwords, tokens and keys live in the vault beside buddi's own.
An agent can ask for one to be used somewhere; it never gets to read it. This
page is how that works: the bindings that say where a value may go, the
plugins that deliver it, the scrubber that keeps it out of every text that
leaves core, and the Settings page where the owner manages it all.

## 1. The problem

Without a place for the owner's own keys, a site password is the last manual
step in every bank check, and a developer agent that needs an admin password
and an API token for a project has only bad places to put them: the
workspace's `.env`, the chat, the agent's memory. Each of those is somewhere an
agent reads. The rule that no agent handles a password holds for every kind of
secret, not only site logins.

Three rules hold throughout:

- **There is no read path.** No tool, area or page returns a value.
- **The approval shows where it goes.** The card names the destination the
  destination itself checked, never what the agent claimed.
- **MFA stays the owner's** unless the owner, per secret, chooses otherwise
  (§4, TOTP).

## 2. A secret is a value plus bindings

A secret is a name ("PNC password"), a value, and one or more **bindings**.
A binding says where the value may go:

- a **destination kind**, registered by a plugin (§3);
- a **target**, the exact place within that kind, checked by the
  destination;
- an **approval rule**: every time, first time only, or pre-approved.

A secret with no binding can be stored and cannot be used. A use that
matches no binding is refused before any card is drawn. Each kind states the
loosest rule it allows; the owner can always pick a stricter one.

## 3. Destinations

A destination is declared by a plugin through the host API
([plugin-host-api.md](plugin-host-api.md) §4.2): `kind`, `checkTarget`,
`describe`, `deliver`, `maxRule`. Every kind is named `<plugin>.<what>`, after
the plugin that answers for it; the registry enforces it. Core finds the
binding, asks the destination to check the target against the live world,
applies the rule, reads the vault and calls `deliver`. The value exists in core
and in that one `deliver` call, and nowhere else.

| Kind | Registered by | Target | Loosest rule |
| --- | --- | --- | --- |
| `browser.field` | browser (extension and Playwright backends) | exact origin (scheme, host, port), or a wildcard origin | pre-approved |
| `http.header` | core's `http` area | exact host and header name, HTTPS only | pre-approved |
| `developer.env` | developer, for `start` and `run` | workspace and variable name | pre-approved per workspace |
| `browser.native.type` | browser (macOS accessibility) | the app's bundle id | every time |
| `browser.form.data` | browser | exact or wildcard origin, and field | every time, every use logged |
| `<plugin>.account` | the plugin that owns the account | its account id | pre-approved |

- **Browser field fill.** The agent calls `secret.fill { name, ref }`. The
  backend reports the origin of the frame holding the field, not the top
  page and not the agent's claim. The tool reads the field the ref names and
  picks the kind from the field and from what the owner bound. A
  password-marked field is `browser.field`. A visible field is
  `browser.field` too when the owner bound the secret as `browser.field` to
  that field's origin, so a username goes in beside its password, and the
  card names the field ("the Username field on https://auth.wikimedia.org").
  Any other visible field is `browser.form.data`. So a password field never
  takes a form-data-only secret, and a card number bound as form data always
  goes through the every-time destination. A TOTP secret (§4) fills any
  field the ref names, because an authenticator field is rarely marked as a
  password. The extension uses the debugger's insertText, Playwright its
  `fill`. The result says "filled". `secret.list` tells the agent which
  names it may use and where each may go (kinds and targets, never a
  value), so it never has to ask the owner for a name.
- **Wildcard origins.** A site that signs in on a sister host (Wikipedia's
  page is `en.wikipedia.org`, its sign-in `auth.wikimedia.org`) is one
  binding, not two: a `browser.field` or `browser.form.data` origin may be
  `https://*.wikimedia.org`. The scheme is exact, the port is exact when
  given, and `*.` stands for one or more labels at the left of a fixed
  suffix, so it matches `auth.wikimedia.org` and `a.b.wikimedia.org` but not
  `wikimedia.org` itself. A `*` anywhere else, a bare `*`, and `*.` on a
  public suffix (`*.com`, `*.co.uk`, `*.github.io`, `*.pages.dev`) are
  refused. The browser plugin bundles a short list of public suffixes taken
  from the Public Suffix List and never fetches it. The card, the use log
  and `describe` name the real origin the field sits on, never the pattern.
- **HTTP request header.** A plugin passes `auth: { secret: name }` to
  `ctx.buddi.http.request`; core inserts the header after the host check.
  For API tokens.
- **Process environment.** `developer.start` and `developer.run` deliver
  every binding for their workspace into the child's environment, subject
  to each rule; the card on first use names the variables and the command.
  The value is never written to a file by buddi.
- **Native app typing.** `secret.type { name }` types into the focused
  field of the bound app. Weaker: an app's text field can show what was
  typed, and the accessibility API can only sometimes tell a secure field.
  Always a card.
- **Form data.** Card, account and tax numbers, into a named field on a
  bound origin. Always a card, and every use is logged with the field.

The extension backend is acceptable for fills: the value crosses a loopback
WebSocket to buddi's own paired extension, and the card shows the origin the
extension checked. No other route reaches the owner's signed-in Chrome.

## 4. Uses

- **Site logins.** `browser.field`, pre-approvable per origin: the username
  and the password are two secrets bound to the same origin, and the agent
  finds their names with `secret.list`.
- **API tokens.** `http.header` for plugins; `developer.env` for code the
  agent is writing.
- **Developer environment variables.** `developer.env`, which may be
  pre-approved per workspace, because the value only ever reaches the owner's
  own processes. A project's admin password and API token are two secrets
  bound to that workspace's `ADMIN_PASSWORD` and `API_TOKEN`, and its `.env`
  holds neither. `developer.write` and `developer.edit` refuse content that
  **contains a stored value**, whatever the file, and say to bind it instead.
  The file is never the test: agents write `.env` files with ordinary
  configuration all the time, and they keep doing so.
- **Plugin account credentials.** The email IMAP and SMTP passwords, and the
  model accounts' credentials. They live in the owner vault as secrets bound
  to `<plugin>.account`, pre-approved because the owner typed them on that
  plugin's own page, and they appear in Settings like any other. **This kind
  is the exception to "never held":** an IMAP connection keeps its password
  for hours, so `deliver` hands the value to the plugin's process for as long
  as its connection lives, and the use is recorded `held`. What protects it
  there is the scrub (§5) and the cleared environment (host API §6), not the
  no-read rule. The card and the Settings row say so in one line.
- **Database and service connection strings.** `developer.env` for a
  workspace's `DATABASE_URL`; `<plugin>.account` for a plugin's own service.
- **SSH and git credentials.** The design holds them as a `developer.git` kind
  targeting a remote URL, delivered through `GIT_ASKPASS` or an agent socket.
  It is not registered: the developer plugin has no push.
- **TOTP seeds.** A secret may be marked TOTP; its value is the seed and
  what is delivered is the current code, into the `browser.field`
  destination only. It merges the password and the second factor into one
  thing buddi holds, so it is the owner's explicit choice per secret, off by
  default, with that sentence on the setting. Every code generated is logged.

## 5. Output scrubbing

Every text that leaves buddi's core for a model, a log, the canvas,
Activity or Telegram is scrubbed for every stored value, and each match is
replaced by `‹secret:NAME›`. buddi's own keys are scrubbed the same way
under their own names. This is not a second line behind the destinations;
it is how a process that prints its environment, a page that echoes a
field, or an error that quotes a header stays safe.

One scrubber in core, `packages/core/src/secrets/scrub.ts`, applied at the
choke points every path already passes through:

1. `ToolRegistry.invoke` and `executeApproved`: the tool result and the
   error, before either is returned or recorded, and `executeApproved`'s
   recorded result. This covers process output (`developer.output`), page
   text (`browser.act`, `web.read`), every tool result and every thrown
   message.
2. `appendEvent`: every event payload, so Activity, the canvas, the
   transcript and the Telegram relay, which all read events, see only the
   scrubbed form. The transcript rows (`core.messages`) are scrubbed as they
   are written too: they are what a surface reads and what a backup takes.
3. The runtime loop, on the request assembled for the provider: the last
   step before a model, catching an owner message with a pasted secret.
4. `ctx.buddi.log` and the gateway's log sink.
5. The memory area and `createProposal`, so nothing scrubbed elsewhere is
   kept in a note or a skill.

A page query's answer is scrubbed as well (`packages/gateway/src/web/pages.ts`),
the same choke point as a tool result: a developer workspace's `.env` that a
value was written into before the rule answers with the marker. The scrubber is
primed once at boot (`createWiringAsync`), so the synchronous sinks — a
plugin's `buddi.log`, the serve loops — scrub from the first line.

**Matching.** One Aho-Corasick automaton over each value and its common
encodings: exact, URL-encoded (both `%20` and `+`), JSON-escaped, and
base64 in both alphabets at each of the three byte alignments (the stable
middle of the encoding, so a secret inside a longer base64 blob still
matches). One pass over the text, linear in its length, whatever the number
of secrets. The automaton is rebuilt when a secret is saved, renamed or
deleted. Values shorter than eight characters match only on token
boundaries, so a four-digit PIN does not blank every year in a page.
Screenshots are images and are not scrubbed; a filled password field shows
dots, and §3's native typing is always a card for that reason.

## 6. Settings → Keys and secrets

An entry, **Keys and secrets**, in the **Models and access** group, after
Model accounts and Computer & browser. It sits there because it answers the
same question as its neighbours, what agents may reach, and not You's, which
is about the owner and what buddi learned about them.

- **Add**: name, value (a password field), TOTP (off), and one or more
  bindings, each a kind, a target and a rule, the kinds offered being those
  the installed plugins register.
- **Rename**, **rebind** and **delete**. Rebinding to a looser rule or a new
  target is the owner's own action on the page, never a tool.
- The value is **never shown again** after save. "Replace value" is the only
  way to change it.
- **On save, buddi looks for the value where it may already be**: events,
  the transcript, and memory notes and preferences, skipping a place that is
  not installed. It reports each place found and offers to scrub them, one
  tap. Learned skills are clean by construction (a proposal's payload is
  scrubbed when it is created, before it can become a skill). The files under
  a bound workspace are the developer plugin's to scan, and its
  `developer.write` and `developer.edit` refuse a stored value from then on.
- buddi's own keys are listed at the bottom, read-only, by name and last
  use, so the page shows everything the vault holds. They cannot be bound
  or replaced from here.
- Each row shows its bindings, **last use** (when, which agent, which
  destination and target) and a link to its use log.
- Every write is an `ownerOnly` tool: no model sees it, as with email's
  add-account.

## 7. Storage

The vault buddi already uses: the macOS keychain, or the file vault
elsewhere. The value is stored under `owner-secret:<id>`, so a rename never
touches the vault. Names, bindings and uses are rows, never values:

- `core.secrets`: id, name (unique), totp, created_at, updated_at.
- `core.secret_bindings`: secret, kind, target jsonb, rule, first approved
  at.
- `core.secret_uses`: secret, kind, target, agent, conversation, action,
  outcome, at.

`held` uses are swept after 30 days. A credential read by its own plugin (a
mail poll, a model call) is one row each, thousands a week; the hourly
proposal loop deletes `held` rows older than a month. Delivered, pending,
refused and failed rows are the owner's audit log and are never swept.

**What plugins and accounts hold.** The email plugin's per-mailbox entries
(`secretNameFor(address)`, and `GMAIL_APP_PASSWORD` for the first account) are
owner secrets bound to `email.account`, and the plugin never copies them into
`process.env`. Provider account credentials (the Anthropic and Codex
`secretRef` entries) are owner secrets bound to `accounts.provider`. The
gateway reads a provider account's credential through a recorded
`accounts.provider` use on the run path; the `configured` computation on
reload reads the vault directly, because a use row per account per reload is
noise, and nothing outside the gateway's own code reaches it. The OAuth
adapters (Codex, Claude) keep their secret-name API and read through a
translating vault: the names they ask for resolve onto the owner secrets, so a
refresh lands under the same `owner-secret:<id>` without the adapters learning
the storage scheme. buddi's own keys (`KNOWN_SECRETS`) stay under their names,
are not bindable, and are scrubbed.

An installation that kept these credentials the old way is migrated once at
start. The migration is idempotent and deletes an old entry only after the new
one reads back.

## 8. Threats

- **A phishing origin.** The binding is an exact origin, compared by the
  destination with the origin the backend reports for the field's own
  frame. A look-alike host, one spelled in punycode, or the right site in a
  frame on the wrong one is refused before any card. The card shows the
  checked origin, so the owner is never the check. A wildcard binding
  (§3) keeps this: its suffix is fixed and never a public suffix, so
  `https://*.wikimedia.org` matches only hosts that end in `.wikimedia.org`,
  which only Wikimedia can create. It widens the binding to every host the
  owner of that suffix runs, which the owner chose by typing the pattern.
- **A prompt-injected agent filling into the wrong field.** The field must
  be on the bound origin; a password field takes only a secret bound to
  that origin; a use outside a binding is refused. A secret bound to an
  origin may go into a visible field there, which the site itself controls;
  what the page echoes back is scrubbed (§5). For kinds where a field could echo
  the value (native typing, form data), every use is a card showing the
  field.
- **A process echoing its environment.** Output scrubbing (§5) replaces the
  value in `developer.output`, the tool result and the event. The value is
  never written to `.env`, and writing it there is refused.
- **A plugin trying to read.** There is no `get`. `deliver` receives a value
  only for a binding naming its own kind. `createVault` is not reachable
  from a plugin (host API §6) and no secret stays in `process.env`. A
  plugin is in-process, so a hostile one could still reach the keychain
  itself; install approval is the guard, as for everything else a plugin
  could do.

## 9. End to end

1. The owner stores "PNC password" bound to `https://www.pnc.com`,
   pre-approved; the Finance Advisor signs in without the value appearing
   in any tool result, event, log, model request or memory note.
2. The same fill on a look-alike origin is refused with no card.
3. A developer workspace starts with its admin password and token from two
   secrets; its `.env` holds neither; `developer.output` and a deliberate
   `env` print show `‹secret:…›`.
4. A tool result containing a stored value URL-encoded or base64-encoded
   reaches the model scrubbed.
5. Mailboxes keep polling with no password in `process.env`.
6. A TOTP secret delivers a code only after the owner turned TOTP on for it.
7. The use log shows every use with agent, destination and target.

## Related

- `packages/core/src/vault`, `packages/extension/src/commands.ts`,
  [browser.md](browser.md), [plugin-host-api.md](plugin-host-api.md).
