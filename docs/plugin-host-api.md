---
title: The plugin host API
status: reference
updated: 2026-09-25
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
| browser | buddi | `secrets` |
| host | buddi | `files:library` |
| image | buddi-plugins | `accounts`, `files:library` |
| developer | buddi-plugins | `files`, `secrets` |
| email | buddi | `files`, `proposals`, `schedule`, `secrets` |

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

A manifest may carry a `register({ version, plugin, dir })` hook. It runs once
at `register()`, for a plugin that fixes something before any context exists;
`dir.legacyPath` names `<data>/<plugin>`, which browser and host used before
the host gave them a directory.

## 4. The areas

Six are always present because they reach nothing beyond the plugin
itself. Seven must be declared (§5), and one member of an always-present
area, `owner.notify`, must be declared too.

### 4.1 Always present

```ts
interface BuddiHost {
  readonly version: string;            // '1.1'; see §7
  readonly plugin: string;             // this plugin's name
  log(line: string): void;             // operational log, scrubbed (owner-secrets §5)
  owner: OwnerArea; clock: ClockArea; db: DbArea; dir: DirArea;
  approvals: ApprovalsArea; pages: PagesArea;
  http?: HttpArea; accounts?: AccountsArea; files?: FilesArea;
  memory?: MemoryArea; proposals?: ProposalsArea; schedule?: ScheduleArea;
  secrets?: SecretsArea;
}
```

**owner.** `id: string`, `timezone: string`, `agentForRole(role): string |
undefined`, `hasAgent(id): boolean` (1.1), `protectedPaths: readonly
string[]`, and `notify(message)` (1.2) when the plugin declares
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
only). Never another plugin's actions.

**pages.** `previewPort(): number | undefined`, `previewUrl(name): string |
undefined`. Page descriptors and queries stay in the manifest; this is only
what a query or a tool asks of the host.

### 4.2 Declared

**owner:notify.** `ctx.buddi.owner.notify({ urgency, title, text?, link?,
dedupeKey?, agentId? }): Promise<{ id }>` tells the owner something
([notifications.md](notifications.md)). The kind is always `plugin` and the
plugin's name is on the row. A plugin picks an urgency (`now`, `today`,
`digest`), never a channel: the owner's settings pick that, so a plugin
cannot send anything through a channel the owner did not choose. Offers and
approval cards are core's and do not pass through. A `dedupeKey` collapses
only with the plugin's own messages.

**http.** `request(req: HttpRequest): Promise<HttpResponse>` on the shared
transport. Every plugin's requests pass the address guard: `checkUrl` in front
and `guardedLookup` as the socket's resolver, so this machine, its network and
ports other than 80 and 443 are refused, and a public name that answers with a
private address is refused where it is dialled. Redirects are not followed. A
request to a host not in the manifest's `network` is logged with the plugin's
name, and will be refused once every plugin declares its hosts. It is also
where an owner secret bound to a header is inserted (owner-secrets §3), so a
plugin that wants a token never holds it. `checkUrl` lives in
`@buddi/core/plugin`; `guardedLookup` lives in core but not in `/plugin`, and
the gateway hands it to browser's proxy.

**accounts.** `list(): ProviderAccountListing[]`, `resolve(id, model,
signal?): Promise<ResolvedProvider>`, `withCodexProfile(id, use, signal?)`.
`resolve` and `withCodexProfile` are refused for an account the owner has not
bound to this plugin; the binding is what the owner picks on the plugin's
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
before the host existed are attributed (migration 042) to the plugin their
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
| 'memory' | 'proposals' | 'schedule' | 'secrets' | 'owner:notify')[]`. Because the staged
install screen may not import anything, the same list goes in
`package.json` as `buddi.uses`; at load the two must match or the plugin
does not register, as `network` is compared with `buddi.md`.

The owner sees the list at install, beside the tools, the schema, the
timers and the hosts, one plain line each: "sends web requests", "uses a
model account you pick", "reads every file in your Files library",
"reads and writes memory as the agent that calls it", "proposes rules",
"starts agent runs by itself", "fills secrets you bind to it", "can send
you messages when you are away". An area
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

`ctx.buddi.version` is `major.minor`; this buddi is `1.2`
(`packages/core/src/plugin/version.ts`). A plugin declares the version it was
built against as `buddi.hostApi` in `package.json` (`"^1.0"`), and one that
asks for more than this buddi has is refused at stage time with both numbers.

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
