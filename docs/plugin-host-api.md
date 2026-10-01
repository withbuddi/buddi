---
title: The plugin host API
status: reference
updated: 2026-09-28
---

# The plugin host API

A plugin reaches buddi through one object, `ctx.buddi`. This page is the
design behind it: what it holds, what a plugin must declare to get more, what
the boundary really is, and how it is versioned. The method-by-method reference
is [plugins.md](plugins.md) §1.1 and §9b.

## 1. The problem it answers

A plugin could once reach core by three roads: the fields of `ToolContext`
(and its cousins `SourceContext`, `SentinelContext` and the page query
context), any function `@buddi/core` happened to export, and plain SQL
against `core.*` tables through the one shared pool. Only the first was
designed. The other two are where the risk sits: a plugin that can call
`createVault` can read every secret on the machine, buddi's own keys included,
and one that reads `core.events`, `core.actions` and `core.approvals` decides
for itself whether the owner already said yes.

"Whatever core exports" is not a contract a plugin author can rely on or an
owner can read at install, and owner secrets
([owner-secrets.md](owner-secrets.md)) cannot be built on a vault any plugin
can open. So plugins get one stable surface, `ctx.buddi`, and nothing else.

## 2. What each plugin uses

Every plugin in both repositories is on the host. The areas each one declares
(§5) are the whole of its reach beyond its own schema and directory:

| Plugin | Repository | `uses` |
| --- | --- | --- |
| template | buddi-plugins | none |
| memory | buddi | none |
| finance | buddi-plugins | `files:library` |
| artifacts | buddi | `files:library` |
| web | buddi | `http` |
| weather (example) | buddi | `http` |
| weather | buddi-plugins | `http`, `owner:notify` |
| calendar | buddi-plugins | `http`, `secrets` |
| browser | buddi | `secrets` |
| host | buddi | `files:library` |
| image | buddi-plugins | `accounts`, `files:library` |
| speech | buddi-plugins | `accounts`, `files:library` |
| developer | buddi-plugins | `files`, `secrets` |
| email | buddi | `files`, `proposals`, `schedule`, `secrets`, `owner:channel`, `owner:notify` |

The families registered in the gateway (goal, learning, schedule, reminders,
platform, canvas) are core's own surfaces over core's rows, not plugins, and
do not go through the host.

## 3. The shape

`ctx.buddi` is the host; the rest of `ToolContext` is the call. Facts about
this one call stay on the context (`agentId`, `conversationId`,
`toolUseId`, `provenance`, `signal`, `actionId`, `choices`,
`approvedEffect`, `suspend`, `ownerRequest`, `sessionTools`,
`delegationDepth`, `group`, `surface`, `nativeSearch`, `jobId`). Everything
the plugin reaches beyond its arguments is under `ctx.buddi`. The same
object is on `SourceContext`, `SentinelContext` and the query context, so a
source and a tool see one host.

Core builds one `ctx.buddi` per plugin at `register()`, bound to the
plugin's name, schema and declared areas. Pure helpers and types
(`localDateString`, `sha256Of`, `pageFile`, `QueryRefusal`,
`parseViewDescriptors`, `checkUrl`, the manifest types) live in a separate
entry point, `@buddi/core/plugin`, which holds nothing with state or I/O.
Core itself runs plugins on `CoreToolContext`, `CoreSourceContext` and
`CoreSentinelContext`, which `/plugin` never exports; tests import
`@buddi/core/testing`.

A manifest may carry a `register({ version, plugin, dir, channels? })` hook. It runs once
at `register()`, for a plugin that fixes something before any context exists;
`dir.legacyPath` names `<data>/<plugin>`, which browser and host used before
the host gave them a directory.

## 4. The areas

Seven are always present because they reach nothing beyond the plugin
itself. Eight must be declared (§5), and one member of an always-present
area, `owner.notify`, must be declared too.

### 4.1 Always present

```ts
interface BuddiHost {
  readonly version: string;            // '1.14'; see §7
  readonly plugin: string;             // this plugin's name
  log(line: string): void;             // operational log, scrubbed (owner-secrets §5)
  owner: OwnerArea; clock: ClockArea; db: DbArea; dir: DirArea;
  approvals: ApprovalsArea; pages: PagesArea; tools: ToolsArea;
  network: NetworkArea;
  http?: HttpArea; accounts?: AccountsArea; files?: FilesArea;
  memory?: MemoryArea; proposals?: ProposalsArea; schedule?: ScheduleArea;
  secrets?: SecretsArea; channels?: ChannelsArea;
}
```

**owner.** `id: string`, `timezone: string`, `agentForRole(role): string |
undefined`, `hasAgent(id): boolean` (1.1), `protectedPaths: readonly
string[]`, `language(): Promise<string | undefined>` (1.5: the profile's
"Answer me in" as a tag like `fr` or `pt-BR`, `undefined` when blank or not
a language), and `notify(message)` (1.2) when the plugin declares
`owner:notify`. Never returns an agent's file, grant or provider.

**clock.** `now(): Date`, `today(): string` (the owner's local date).

**db.** `query<R>(sql, params?)` and `transaction<T>(fn: (tx) =>
Promise<T>): Promise<T>`; both answer `rowCount` beside `rows`. `query` is one
statement on the shared pool and sets no `search_path`, so a plugin names its
tables with its schema; `transaction` puts the plugin's schema first on the
`search_path`. §6 says what enforces the scope. Never a raw `Pool`, so a
plugin cannot `connect()` and change role.

**dir.** `path: string`: `<data>/plugins-data/<plugin>`, created on first
use. Never the data directory itself, where the file vault and the Files
library live.

**approvals.** `assert(ctx, envelope): void` (the approved-effect check),
`standing(tool): Promise<ToolPermission | null>` (for this plugin's own tools
only), and `approvedInConversation(tool, conversationId): Promise<boolean>`
(whether the owner already approved this tool in this conversation, own tools
only), and `decisionsInConversation(tool, conversationId):
Promise<{ envelope, state, choices? }[]>` (1.4: every card on that tool in this
conversation, so a tool that asks once per subject knows a yes from a no).
Never another plugin's actions.

**pages.** `previewPort(): number | undefined`, `previewUrl(name): string |
undefined`. Page descriptors and queries stay in the manifest; this is only
what a query or a tool asks of the host.

**tools.** (1.6) `register(definitions: ToolDefinition[]): void`,
`unregister(names: string[]): void`, `registered(): string[]`. Tools added
and removed while buddi runs, for a plugin whose tools are not known at boot:
a connection the owner makes at 3pm brings its tools without a restart
(Connections, the MCP client). Names must be in the plugin's own namespace
(`<plugin>.<what>`); the registry applies the checks a manifest's tools get
(name shape, tier and `tierFor`, `untrusted`, the input schema, no name twice),
and a batch is all or nothing. A plugin removes only what it added this way,
never a manifest tool and never another plugin's. After a change the gateway
reloads the agent catalog, so every agent's `tools:` grant is resolved again
before its next turn: `mcp.github.*` covers a tool added after the agent
loaded. Also on the `register` hook's host. A tool may describe its input with
a JSON Schema (`inputSchema`) instead of zod, validated with Ajv and
canonicalised into the approval envelope the same way (plugins.md §9).

**network.** (1.7) `declare(uses: { host, why }[]): void`,
`undeclare(hosts: string[]): void`, `declared(): { host, why, runtime }[]`.
The manifest's `network` is fixed at `register()`; a plugin that learns where
it talks while buddi runs declares those hosts here. They join the manifest's
in the one list the `http` area checks a request against, and the Plugins page
lists them under what leaves the machine from that moment: Connections
declares each connected service's host when the connection is made and takes
it back on disconnect. A host is a name or `*.name`, with a one-line `why`;
`undeclare` removes only what `declare` added. Also on the `register` hook's
host.

### 4.2 Declared

**owner:notify.** `ctx.buddi.owner.notify({ urgency, title, text?, link?,
dedupeKey?, agentId? }): Promise<{ id }>` tells the owner something
([notifications.md](notifications.md)). The kind is always `plugin` and the
plugin's name is on the row. A plugin picks an urgency (`now`, `today`,
`digest`), never a channel: the owner's settings pick that, so a plugin
cannot send anything through a channel the owner did not choose. Offers and
approval cards are core's and do not pass through. A `dedupeKey` collapses
only with the plugin's own messages.

**owner:channel.** `ctx.buddi.channels.register({ kind, describe(buddi),
can, deliver(message, buddi) }): () => void` (1.3) adds a way to reach the
owner that the plugin carries, kind `<plugin>.<what>`, listed in Settings →
Notifications beside Telegram and the system notification
([notifications.md](notifications.md)). The area is also on the `register`
hook's host, which is where a channel is normally registered. Core calls
`describe` and `deliver` from its routing, outside any context, so each is
handed the plugin's host built over the pool the composition root gave
(`configurePluginHost({ db })`); a process that gave none has no plugin
channels. `describe` answers `{ label, where? }`, or null when there is
nothing to carry a message now (no account), and the channel is then neither
listed nor picked. `deliver` gets the stored message: title, text, `link: {
route, url? }` (`url` only with a public origin), offers as labels; never an
approval's action id or an offer's prompt. It answers `{ id }` or `{ refused:
sentence }`, kept on the notification. A plugin's channel is never the default
over core's, and the owner still picks where each kind goes: the plugin
carries, it never routes. The email plugin's mail to yourself is the first
([email.md](email.md)).

**http.** `request(req: HttpRequest): Promise<HttpResponse>` on the shared
transport. Every plugin's requests pass the address guard: `checkUrl` in front
and `guardedLookup` as the socket's resolver, so this machine, its network and
ports other than 80 and 443 are refused, and a public name that answers with a
private address is refused where it is dialled. Redirects are not followed. A
request to a host not in the manifest's `network` is logged with the plugin's
name, and will be refused once every plugin declares its hosts. It is also
where an owner secret bound to a header is inserted (owner-secrets §3), so a
plugin that wants a token never holds it. Since 1.9 a secret may be the whole
address instead (`auth: { secret, as: 'url' }`, kind `http.url`): a private
link whose credential is its path, like a calendar's ICS address. The request
names only the host; core fetches the stored address once it is HTTPS on that
host and passes the address rules, GET only. Its binding's target is `{
plugin, host }`, the plugin filled in by the area, so only the plugin that
stored the link can fetch it; `secrets.put` accepts that one core kind from a
plugin that declares `http`. `checkUrl` lives in
`@buddi/core/plugin`; `guardedLookup` lives in core but not in `/plugin`, and
the gateway hands it to browser's proxy.

**accounts.** `list(): ProviderAccountListing[]`, `resolve(id, model,
signal?): Promise<ResolvedProvider>`, `generateCodexImage(id, { prompt,
references, size?, model?, signal? }): Promise<{ bytes, mime, revisedPrompt? }>`
(1.8), and `withCodexProfile(id, use, signal?)`, deprecated since 1.8 and kept
for compatibility. `generateCodexImage` is one picture from a ChatGPT
subscription: the gateway sends a Responses request to the Codex backend whose
one tool is the hosted `image_generation` (forced by `tool_choice`, or `auto`
with an instruction when the backend refuses that) and reads the
`image_generation_call` item's base64 `result` off the stream, under the
account's lock and refresh, so the token never reaches the plugin.
`resolve`, `generateCodexImage` and `withCodexProfile` are refused for an
account the owner has not bound to this plugin; the binding is what the owner picks on the plugin's
settings page, written through `accounts.bind(id)` from an `ownerOnly` tool.
`list` never returns a key.

**files.** The Files library.

```ts
interface FilesArea {
  save(input: { bytes: Buffer; mime: string; filename?: string;
                caption?: string; source?: ArtifactSource }): Promise<FileRow>;
  get(id: string): Promise<FileRow | null>;
  read(id: string): Promise<Buffer>;
  list(opts?: { since?: Date; before?: Date; kind?: string;
                sha256?: string; surface?: string;
                limit?: number }): Promise<FileRow[]>;
}
```

`createdBy` and the data directory are filled in by core. `FileRow` has no
`storagePath`, and says its `conversationId` only when that conversation
exists. Scope: a plugin sees files it saved and files handed into a
conversation its tool is running in. A manifest that declares
`files:library` sees every file, and the install card says so in those
words; a personal assistant that reads everything should say so. Files saved
before the host existed are attributed to the plugin their
provenance names.

**memory.** `recall(query, opts?): Promise<MemoryNote[]>` and
`note(text, opts?): Promise<{ id }>`, both as the calling agent and under
the same scope rules as `memory.recall` and `memory.note`. It is a type only:
no plugin reads memory from the outside, and the area exists so the first one
does not reach into the `memory` schema. When it is provided, it is the
memory plugin that provides it, through a port the composition root wires, so
core still imports no plugin.

**proposals.** `proposePolicy(ctx, input): Promise<CreateProposalResult>`
and `countOpen(): Promise<number>`. Core's policy proposal with the plugin's
name filled in ([learning.md](learning.md) §2), and the open count email's
Settings page shows. `proposePolicy` takes a nullable call and a `within`
transaction, and a policy handler's context carries the plugin's host. Never
another plugin's proposals.
Since 1.14 a plugin may also keep a rule itself, where its own rule allows
it without asking ([learning.md](learning.md) §4): `proposePolicy(ctx,
input, tx, { announce: false })`, write the rule in the same transaction,
then `keepItself(id, tx)`, recorded as decided by `auto`. `trackRecord(kind)`
is the owner's record with this plugin's rules of one `kind` (owner keeps
since their last discard, and whether that reaches five), `listOpen()` its
open cards, and `takeBack(id)` turns a kept one into the owner's discard (an
Undo on the plugin's page).

**schedule.** `enqueueRun(input)` and `remindersFor(key: { contextKey:
string; values: string[] }, days: string[]): Promise<{ value: string; day:
string }[]>` (which of these values already has a reminder on these days).
Never a reminder's text or another plugin's jobs.

**secrets.** The owner's secrets, used and never read by tools:
`registerDestination`, `use(name, kind, target)`, `list`, `put`, `rename`,
`rebind`, `delete`. `list` returns names and bindings that point at this
plugin's destinations, never values; `put` is for an `ownerOnly` tool storing
an account credential the owner typed.

A plugin that delivers secrets declares **destinations** in its manifest:
`{ kind, checkTarget(target, bound), describe(target), deliver(value,
target, ctx), maxRule }`. Core looks up the binding, calls `checkTarget`,
runs the approval rule, reads the vault and calls `deliver`. `deliver` is
the only code that ever receives a value, and only for a binding that names
its own kind. There is no `get`, and `createVault` is not reachable from a
plugin. A use of a `<plugin>.account` kind is recorded `held`: the plugin's
connection keeps the value for as long as it lives (email's mailbox
password), the one stated exception to "never held". The product is
[owner-secrets.md](owner-secrets.md).

## 5. Permissions

The manifest carries `uses: ('http' | 'accounts' | 'files' | 'files:library'
| 'memory' | 'proposals' | 'schedule' | 'secrets' | 'owner:notify' | 'owner:channel')[]`. Because the staged
install screen may not import anything, the same list goes in
`package.json` as `buddi.uses`; at load the two must match or the plugin
does not register, as `network` is compared with `buddi.md`.

The owner sees the list at install, beside the tools, the schema, the
timers and the hosts, one plain line each: "sends web requests", "uses a
model account you pick", "reads every file in your Files library",
"reads and writes memory as the agent that calls it", "proposes rules",
"starts agent runs by itself", "fills secrets you bind to it", "can send
you messages when you are away", "adds a way for buddi to reach you". An area
not declared is absent from `ctx.buddi`, so a call to it is a type error
and, at runtime, `undefined`. Adding an area in an upgrade is shown as a
change on the upgrade card.

## 6. Scope and the trust boundary

**Scope.** In every area a plugin sees its own data: its schema, its
directory, files it saved, its tools' approvals, its proposals, secrets
bound to its destinations, accounts bound to it. More only when the owner
binds it (a secret, an account) or the manifest declares it and the owner
accepted (`files:library`).

In `db`, scope is a rule, not a grant. Each plugin connecting as its own
Postgres role, `plugin_<name>`, with no grant on `core`, would give it teeth;
that needs `createrole` on every install path, which the bundled Postgres has
and a Homebrew or remote one may not, so it is not done. Until every install
path can grant it, the import test's `core.` table check below is the scope
rule for `db`.

**The boundary, plainly.** Plugins run inside buddi's process. `ctx.buddi`
is the supported path, not a sandbox: a plugin that wants to can `import`
a file by absolute path, read `process.env` or open a socket to Postgres.
What stands between a hostile plugin and the owner is the two install
approvals, the recorded integrity hash, and the owner reading the card.
What the host adds is that honest plugins have no reason to reach further,
so any reach is visible in review:

- `packages/gateway/src/plugin-imports.test.ts` walks every plugin source
  in `packages/tools/*` and fails on any import of `@buddi/core` other than
  `@buddi/core/plugin` (and `@buddi/core/testing` in tests), any
  `@buddi/runtime`, `@buddi/gateway` or `@buddi/tool-*`, and any `core.`
  table in a SQL string, naming the file, as `bundle.test.ts` does for the
  web package. buddi-plugins runs the same check from its root `pnpm test`
  (`scripts/check-plugin-imports.mjs`).
- For installed plugins, staging writes a `@buddi/core` whose only export is
  `./plugin`, re-exporting the running core's `dist/plugin`, so an import of
  an internal by package name fails to resolve. It is written, not linked,
  and not hashed. A directory install and `plugins dev` keep the checkout's
  own `link:`, whole.
- After boot the gateway deletes the mailbox passwords from `process.env`, and
  no plugin writes a password there. `DATABASE_URL`, `BUDDI_VAULT_KEY` and the
  provider, Telegram and search keys stay, each still read after boot;
  `packages/gateway/src/owner-secrets.ts` says by what.

**Not done: process isolation.** Running each plugin in its own worker
or process, with `ctx.buddi` as an RPC surface and its own database role,
would make the boundary real. It needs every area to be serialisable
(files as streams, `deliver` run in core with the destination's backend
reached over the bridge), and tools that hold handles (developer's child
processes, browser's driver) to live in the plugin's process. The areas are
designed so that move is possible later: every method is async and takes and
returns plain data.

## 7. Versioning

`ctx.buddi.version` is `major.minor`; this buddi is `1.14`
(`packages/core/src/plugin/version.ts`). A plugin declares the version it was
built against as `buddi.hostApi` in `package.json` (`"^1.0"`), and one that
asks for more than this buddi has is refused at stage time with both numbers.

1.10 adds no method: it is the first buddi that draws the `tiles` renderer
and Home glances (`placement: 'glance'`), and an older one refuses a
descriptor it cannot parse. A plugin contributing either asks for `^1.10`.

1.11 adds no method either: it is the first buddi that draws the `calendar`
page component (docs/plugin-pages.md §4). A plugin whose pages use one asks
for `^1.11`.

1.12 adds no method either: it is the first buddi that draws the `tabs`,
`hero` and `tiles` page components, a chart's `series`, and the `sun` and
`cloud` page icons (docs/plugin-pages.md §4). A plugin whose pages use any
of them asks for `^1.12`.

1.13 adds no method either: it is the first buddi that draws the
`series-panel` page component (docs/plugin-pages.md §4). A plugin whose pages
use it asks for `^1.13`.

1.14 adds `proposals.listOpen`, `keepItself`, `trackRecord` and `takeBack`,
and `proposePolicy`'s optional `{ announce }` (§4, proposals). A plugin that
keeps rules itself asks for `^1.14`.

A minor adds a method, an optional argument or an optional field on a
return; it never changes what an existing call does. A major removes or
changes something, and ships only after one release in which both shapes
exist and the old one logs its caller. [plugins.md](plugins.md) §9b lists each
method with the minor that introduced it, and `plugin-reference.test.ts`
checks that table against the interface as it does for `ToolContext`.

## 8. End to end

1. `plugin-imports.test.ts` passes, and fails naming the file when a plugin
   imports `createVault` or queries `core.events`.
2. A plugin with no `uses` gets a `ctx.buddi` with only the always-present
   areas; `ctx.buddi.secrets` is `undefined`.
3. Installing image shows "uses a model account you pick" and "keeps
   files in your Files library" on the card before its code runs.
4. The email plugin adds and removes a mailbox with no `createVault`
   import, and no mailbox password is in `process.env`.
5. A plugin declaring `buddi.hostApi: "^1.9"` is refused at stage time on a
   `1.2` host.

A tarball install of the scaffold has a known problem that predates the host:
it needs the `link:` devDependency removed, the peer resolution fixed and
`buddi.name` in the scaffold ([plugins.md](plugins.md) §8).
