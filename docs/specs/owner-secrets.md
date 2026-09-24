# Secrets the agent can use but never see

Status: spec written 2026-09-24, not started. Depends on the `secrets` area
of [plugin-host-api.md](plugin-host-api.md) §4.2.
Captured: 2026-09-21, rewritten 2026-09-24

## 1. The problem

buddi keeps its own keys in a vault, and the owner's keys have nowhere to
go. The site password is the last manual step in every bank check. Worse,
on 2026-09-23 the local admin password and a 64-character API token for the
cour des comptes app were written into the workspace's `.env`, into the
chat, and into an agent's memory, because the developer plugin had no other
way to give a process a secret. The rule that no agent handles a password
must hold for every kind of secret, not only site logins.

Three rules carry over from the first version of this spec and do not
change:

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

A destination is declared by a plugin through the host API: `kind`,
`checkTarget`, `describe`, `deliver`, `maxRule`. Core finds the binding,
asks the destination to check the target against the live world, applies
the rule, reads the vault and calls `deliver`. The value exists in core and
in that one `deliver` call, and nowhere else.

| Kind | Registered by | Target | Loosest rule |
| --- | --- | --- | --- |
| `browser.field` | browser (extension and Playwright backends) | exact origin (scheme, host, port) | pre-approved |
| `http.header` | core's `http` area | exact host and header name, HTTPS only | pre-approved |
| `developer.env` | developer, for `start` and `run` | workspace and variable name | pre-approved |
| `native.type` | browser (macOS accessibility) | the app's bundle id | every time |
| `form.data` | browser | exact origin and field | every time, every use logged |
| `<plugin>.account` | the plugin that owns the account | its account id | pre-approved |

- **Browser field fill.** The agent calls `secret.fill { name, ref }`. The
  backend reports the origin of the frame holding the field, not the top
  page and not the agent's claim. A password-kind secret goes only into a
  field the page marks as a password. The extension uses the debugger's
  insertText, Playwright its `fill`. The result says "filled".
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

## 4. Uses

- **Site logins.** `browser.field`, pre-approvable per origin.
- **API tokens.** `http.header` for plugins; `developer.env` for code the
  agent is writing.
- **Developer environment variables.** `developer.env`. The cour des
  comptes password and token become two secrets bound to that workspace's
  `ADMIN_PASSWORD` and `API_TOKEN`, and the `.env` lines are deleted.
  `developer.write` refuses content containing any stored value and says to
  bind it instead.
- **Plugin account credentials.** The email IMAP and SMTP passwords today;
  messengers and model accounts as they are added. They move into the owner
  vault as secrets bound to `<plugin>.account`, pre-approved because the
  owner typed them on that plugin's own page, and they appear in Settings
  like any other.
- **Database and service connection strings.** `developer.env` for a
  workspace's `DATABASE_URL`; `<plugin>.account` for a plugin's own service.
- **SSH and git credentials.** Named here so the design holds them: a
  `developer.git` kind targeting a remote URL, delivered through
  `GIT_ASKPASS` or an agent socket. Not built: the developer plugin has no
  push today, and this lands with push.
- **TOTP seeds.** A secret may be marked TOTP; its value is the seed and
  what is delivered is the current code, into `browser.field` only. It
  merges the password and the second factor into one thing buddi holds, so
  it is the owner's explicit choice per secret, off by default, with that
  sentence on the setting. Every code generated is logged.

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
   error, before either is returned or recorded. This covers process output
   (`developer.output`), page text (`browser.act`, `web.read`), every tool
   result and every thrown message.
2. `appendEvent`: every event payload, so Activity, the canvas, the
   transcript and the Telegram relay, which all read events, see only the
   scrubbed form.
3. The runtime loop, on the request assembled for the provider: the last
   step before a model, catching an owner message with a pasted secret.
4. `ctx.buddi.log` and the gateway's log sink.
5. The memory area and `createProposal`, so nothing scrubbed elsewhere is
   kept in a note or a skill.

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

A new entry, **Keys and secrets**, in the **Models and access** group, after
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
- Each row shows its bindings, **last use** (when, which agent, which
  destination and target) and a link to its use log.
- Every write is an `ownerOnly` tool: no model sees it, as with email's
  add-account today.

## 7. Storage

The vault buddi already uses: the macOS keychain, or the file vault
elsewhere. The value is stored under `owner-secret:<id>`, so a rename never
touches the vault. Names, bindings and uses are rows, never values:

- `core.secrets`: id, name (unique), totp, created_at, updated_at.
- `core.secret_bindings`: secret, kind, target jsonb, rule, first approved
  at.
- `core.secret_uses`: secret, kind, target, agent, conversation, action,
  outcome, at.

**Migrating what plugins hold today.** The email plugin's per-mailbox
entries (`secretNameFor(address)`, and `GMAIL_APP_PASSWORD` for the first
account) move to owner secrets bound to `email.account`, and the plugin
stops copying them into `process.env`. Provider account credentials (the
Anthropic and Codex `secretRef` entries) become owner secrets bound to
`accounts.provider`; the gateway reads them through the same area. buddi's
own keys (`KNOWN_SECRETS`) stay under their names, are not bindable, and are
scrubbed. The migration runs once at start, is idempotent, and deletes an
old entry only after the new one reads back.

## 8. Threats

- **A phishing origin.** The binding is an exact origin, compared by the
  destination with the origin the backend reports for the field's own
  frame. A look-alike host, one spelled in punycode, or the right site in a
  frame on the wrong one is refused before any card. The card shows the
  checked origin, so the owner is never the check.
- **A prompt-injected agent filling into the wrong field.** The field must
  be on the bound origin; a password goes only into a password field; a
  use outside a binding is refused. For kinds where a field could echo
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

## 9. Acceptance

1. The owner stores "PNC password" bound to `https://www.pnc.com`,
   pre-approved; the Finance Advisor signs in without the value appearing
   in any tool result, event, log, model request or memory note.
2. The same fill on a look-alike origin is refused with no card.
3. The cour des comptes workspace starts with its admin password and token
   from two secrets; its `.env` holds neither; `developer.output` and a
   deliberate `env` print show `‹secret:…›`.
4. A tool result containing a stored value URL-encoded or base64-encoded
   reaches the model scrubbed.
5. Existing mailboxes keep polling after migration with no password in
   `process.env`.
6. A TOTP secret delivers a code only after the owner turned TOTP on for it.
7. The use log shows every use with agent, destination and target.

## 10. Open questions

- History: the cour des comptes values are already in events and a memory
  note. On save, should buddi search events, memory and workspace files for
  the new value, report where it was found, and offer to scrub them?
- Should `developer.env` allow pre-approved, or at most first time per
  workspace?
- Should buddi's own keys be listed read-only on the page, or stay on
  System?
- Is the extension backend acceptable for fills, given the value crosses the
  local WebSocket to the extension?

## 11. Order of work

After the host API's `secrets` area (plugin-host-api.md §9 step 3):

1. Tables, the scrubber at the five choke points, and its tests (one day).
2. `browser.field` with `secret.fill` on both backends, the approval card
   with the checked origin (one day).
3. `developer.env`, the `.env` write refusal, the cour des comptes case
   (half a day).
4. Settings → Keys and secrets (one day).
5. Plugin credentials migrated: email, then provider accounts (half a day).
6. `http.header`, `native.type`, `form.data`, TOTP, two reviewers on the
   whole (one day).

About five days.

## Related work

- `packages/core/src/vault`, `packages/extension/src/commands.ts` (`fill`
  refuses password fields today), [browser.md](../browser.md),
  [plugin-host-api.md](plugin-host-api.md).
