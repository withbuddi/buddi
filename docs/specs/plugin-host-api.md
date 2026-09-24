# The plugin host API

Status: spec written 2026-09-24, not started
Captured: 2026-09-24

## 1. The problem

A plugin reaches core by three roads today: the fields of `ToolContext`
(and its cousins `SourceContext`, `SentinelContext` and the page query
context), any function `@buddi/core` happens to export, and plain SQL
against `core.*` tables through the one shared pool. Only the first was
designed. The second and third grew as each plugin needed something, and
they are where the risk sits: the email plugin calls `createVault` and can
read every secret on the machine, buddi's own keys included; the image
plugin reads `core.events`, `core.actions` and `core.approvals` to decide
whether the owner already said yes.

Nothing in that is malicious. But "whatever core exports" is not a contract
a plugin author can rely on or an owner can read at install, and owner
secrets ([owner-secrets.md](owner-secrets.md)) cannot be built on a vault any
plugin can open. This spec gives plugins one stable surface, `ctx.buddi`,
and moves every plugin onto it.

## 2. What plugins reach today

Non-test sources only. "ctx" is every field read on the context a tool,
source, sentinel or query is handed; "imports" are value imports from
`@buddi/core` (types are free and not listed); "tables" are `core.*` tables
named in SQL. The tables are in migration order (§8): least reach first.

Across ten plugins, **six import core internals** (email, host, image,
artifacts, developer, browser), **four read core tables** directly (email,
image, finance, artifacts; host also names `core` as its own schema), and
**two import other buddi packages** (web imports `@buddi/runtime`, browser
imports `@buddi/tool-web`). The families registered in the gateway (goal, learning,
schedule, reminders, platform, canvas) are core's own surfaces over core's
rows, not plugins, and stay where they are.

### template (buddi-plugins)

| Reach | What |
| --- | --- |
| ctx | `db`, `log`, `actionId` |
| imports | none |
| tables | none |
| other | none |
| declares | tools, sources, network, description |

### memory

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `agentId`, `conversationId`, `group` |
| imports | none |
| tables | none |
| other | none |
| declares | tools (`memory.note`, `recall`, `forget`, preferences) |

### finance (buddi-plugins)

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `timezone`, `agentForRole` (sentinel) |
| imports | `localDateString` (pure) |
| tables | `core.artifacts`, joined to finance tables in the unprocessed-files sentinel |
| other | none |
| declares | tools, sentinels, missions, views, home, metrics, skills |

### artifacts

| Reach | What |
| --- | --- |
| ctx | `db` |
| imports | `getArtifact`, `listArtifacts`, `readArtifactBytes` |
| tables | `core.artifacts` (it owns no schema of its own) |
| other | none |
| declares | tools (`artifacts.list`, `describe`, `text`) |

### web

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `agentId`, `conversationId`, `nativeSearch` |
| imports | none from core |
| tables | none |
| other | `@buddi/runtime`: `defaultHttpTransport`, `createHttpTransport`, `parseSearchBackend`, `NATIVE_BACKEND_ID`, `SEARCH_BACKEND_VAR`; search keys from the environment |
| declares | tools, skills, network, description |

### browser

| Reach | What |
| --- | --- |
| ctx | `ownerId`, `agentId`, `conversationId`, `signal`, `ownerRequest`, `surface`, `delegationDepth` |
| imports | `resolveDataDir` |
| tables | none |
| other | `@buddi/tool-web`: `checkUrl`, `guardedLookup`, `DEFAULT_POLICY`; a `BrowserController` injected at the composition root |
| declares | tools (`browser.act`, `status`), network, description |

### host

| Reach | What |
| --- | --- |
| ctx | `db`, `ownerId`, `agentId`, `conversationId`, `signal`, `actionId`, `delegationDepth` |
| imports | `findToolPermission`, `assertApprovedEffect`, `saveArtifact`, `getArtifact`, `readArtifactBytes`, `resolveDataDir`, `sha256Of` |
| tables | declares `schema: 'core'` |
| other | a `HostService` injected at the composition root |
| declares | tools (`host.exec`, `status`, `stop`), description |

### image (buddi-plugins)

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `timezone`, `agentId`, `conversationId`, `signal`, `providerAccounts` |
| imports | `saveArtifact`, `getArtifact`, `readArtifactBytes` (called with `process.env`) |
| tables | `core.conversations`, `core.events`, `core.actions`, `core.approvals`, `core.artifacts` |
| other | `providerAccounts.resolve` hands it an HTTP account's key |
| declares | tools, pages, queries, views, agents, skills, network, description |

### developer (buddi-plugins)

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `agentId`, `signal`, `protectedPaths`, `previewPort`, `actionId`, `choices`, `approvedEffect` |
| imports | `saveArtifact`, `pageFile`, `QueryRefusal` |
| tables | none |
| other | spawns with its own scrubbed child environment; no push (the git subcommand enum has none) |
| declares | tools, pages, queries, files, previews, views, metrics, agents, skills, network, description |

### email

| Reach | What |
| --- | --- |
| ctx | `db`, `now`, `timezone`, `agentId`, `conversationId`, `signal`, `actionId`, `choices`, `approvedEffect`, `log`, `enqueueRun` (source), `agentForRole` (sentinel) |
| imports | **`createVault`**, `proposePolicy`, `assertApprovedEffect`, `saveArtifact`, `sha256Of`, `localDateString`, `QueryRefusal` |
| tables | `core.artifacts`, `core.reminders`, `core.proposals` |
| other | writes each mailbox password into `process.env`, where every plugin can read it |
| declares | tools, sources, sentinels, metrics, pages, queries, policies |

## 3. The shape

`ctx.buddi` is the host; the rest of `ToolContext` is the call. Facts about
this one call stay where they are (`agentId`, `conversationId`,
`toolUseId`, `provenance`, `signal`, `actionId`, `choices`,
`approvedEffect`, `suspend`, `ownerRequest`, `sessionTools`,
`delegationDepth`, `group`, `surface`, `nativeSearch`, `jobId`). Everything
the plugin reaches beyond its arguments moves under `ctx.buddi`. The same
object is on `SourceContext`, `SentinelContext` and the query context, so a
source and a tool see one host.

Core builds one `ctx.buddi` per plugin at `register()`, bound to the
plugin's name, schema and declared areas. Pure helpers and types
(`localDateString`, `sha256Of`, `pageFile`, `QueryRefusal`,
`parseViewDescriptors`, `checkUrl`, the manifest types) move to a new entry
point, `@buddi/core/plugin`, which holds nothing with state or I/O.

## 4. The areas

Six are always present because they reach nothing beyond the plugin
itself. Seven must be declared (§5).

### 4.1 Always present

```ts
interface BuddiHost {
  readonly version: string;            // '1.0'; see §7
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
undefined`, `protectedPaths: readonly string[]`. Wraps `ownerId`,
`timezone`, `agentForRole` and `protectedPaths` as they are set today.
Never returns an agent's file, grant or provider.

**clock.** `now(): Date`, `today(): string` (the owner's local date). Wraps
`now` and `localDateString`.

**db.** `query<R>(sql, params?): Promise<{ rows: R[] }>` and
`transaction<T>(fn: (tx) => Promise<T>): Promise<T>`. Connected with
`search_path` set to the plugin's schema. It wraps the shared pool today;
§6 says what enforces the scope. Never a raw `Pool`, so a plugin cannot
`connect()` and change role.

**dir.** `path: string`: `<data>/plugins-data/<plugin>`, created on first
use. Wraps the `resolveDataDir(env)` joins in browser and host. Never the
data directory itself, where the file vault and the Files library live.

**approvals.** `assert(ctx, envelope): void` (today's
`assertApprovedEffect`), `standing(tool): Promise<ToolPermission | null>`
(today's `findToolPermission`, for this plugin's own tools only), and
`approvedInConversation(tool, conversationId): Promise<boolean>` (the image
plugin's query over `core.events`, `actions` and `approvals`, moved into
core, own tools only). Never another plugin's actions.

**pages.** `previewPort(): number | undefined`, `previewUrl(name): string |
undefined`. Wraps `previewPort`. Page descriptors and queries stay in the
manifest; this is only what a query or a tool asks of the host.

### 4.2 Declared

**http.** `request(req: HttpRequest): Promise<HttpResponse>`. The shared
transport from `@buddi/runtime`, so web's import goes. A request to a host
not in the manifest's `network` is logged with the plugin's name in the
first version and refused once every plugin declares its hosts. It is also
where an owner secret bound to a header is inserted (owner-secrets §3), so a
plugin that wants a token never holds it.

**accounts.** `list(): ProviderAccountListing[]`, `resolve(id, model,
signal?): Promise<ResolvedProvider>`, `withCodexProfile(id, use, signal?)`.
Today's `providerAccounts`, unchanged in shape. `resolve` and
`withCodexProfile` are refused for an account the owner has not bound to
this plugin; the binding is what the owner picks on the plugin's settings
page, written through `accounts.bind(id)` from an `ownerOnly` tool. `list`
never returns a key.

**files.** The Files library.

```ts
interface FilesArea {
  save(input: { bytes: Buffer; mime: string; filename?: string;
                source?: ArtifactSource }): Promise<FileRow>;
  get(id: string): Promise<FileRow | null>;
  read(id: string): Promise<Buffer>;
  list(opts?: { since?: Date; before?: Date; kind?: string;
                limit?: number }): Promise<FileRow[]>;
}
```

Wraps `saveArtifact`, `getArtifact`, `readArtifactBytes` and
`listArtifacts`; `createdBy` and the data directory are filled in by core.
`FileRow` has no `storagePath`. Scope: a plugin sees files it saved and
files handed into a conversation its tool is running in. A manifest that
declares `files: 'library'` sees every file, and the install card says so in
those words. Finance and artifacts need `library`.

**memory.** `recall(query, opts?): Promise<MemoryNote[]>` and
`note(text, opts?): Promise<{ id }>`, both as the calling agent and under
the same scope rules as `memory.recall` and `memory.note`. The memory plugin
provides it through a port the composition root wires, as browser's bridge
is wired, so core still imports no plugin. No plugin reads memory from the
outside today; the area exists so the first one does not reach into the
`memory` schema.

**proposals.** `proposePolicy(ctx, input): Promise<CreateProposalResult>`
and `countOpen(): Promise<number>`. Wraps core's `proposePolicy` with the
plugin's name filled in, and the count email's Settings page reads from
`core.proposals`. Never another plugin's proposals.

**schedule.** `enqueueRun(input)` (today's `SourceContext.enqueueRun`) and
`remindersFor(key: { contextKey: string; values: string[] }, days:
string[]): Promise<{ value: string; day: string }[]>` (email's read of
`core.reminders`, generalised to one context key). Never a reminder's text
or another plugin's jobs.

**secrets.** The owner's secrets, used and never read by tools.

```ts
interface SecretsArea {
  // Ask to deliver a bound secret into one of this plugin's destinations.
  use(ctx: ToolContext, req: { name: string; destination: string;
       target: unknown }): Promise<{ done: true } | { pending: string } |
       { refused: string }>;
  // Names and bindings that point at this plugin's destinations. No values.
  list(): Promise<SecretListing[]>;
  // For an ownerOnly tool storing an account credential the owner typed.
  store(name: string, value: string, binding: Binding): Promise<void>;
  remove(name: string): Promise<boolean>;
}
```

A plugin that delivers secrets declares **destinations** in its manifest:
`{ kind, checkTarget(target, bound), describe(target), deliver(value,
target, ctx), maxRule }`. Core looks up the binding, calls `checkTarget`,
runs the approval rule, reads the vault and calls `deliver`. `deliver` is
the only code that ever receives a value, and only for a binding that names
its own kind. There is no `get`. Wraps the `Vault` port; `createVault` is no
longer reachable from a plugin. The product is
[owner-secrets.md](owner-secrets.md).

## 5. Permissions

The manifest gains `uses: ('http' | 'accounts' | 'files' | 'files:library'
| 'memory' | 'proposals' | 'schedule' | 'secrets')[]`. Because the staged
install screen may not import anything, the same list goes in
`package.json` as `buddi.uses`; at load the two must match or the plugin
does not register, as `network` is compared with `buddi.md` today.

The owner sees the list at install, beside the tools, the schema, the
timers and the hosts, one plain line each: "sends web requests", "uses a
model account you pick", "reads every file in your Files library",
"reads and writes memory as the agent that calls it", "proposes rules",
"starts agent runs by itself", "fills secrets you bind to it". An area
not declared is absent from `ctx.buddi`, so a call to it is a type error
and, at runtime, `undefined`. Adding an area in an upgrade is shown as a
change on the upgrade card.

## 6. Scope and the trust boundary

**Scope.** In every area a plugin sees its own data: its schema, its
directory, files it saved, its tools' approvals, its proposals, secrets
bound to its destinations, accounts bound to it. More only when the owner
binds it (a secret, an account) or the manifest declares it and the owner
accepted (`files:library`).

`db` gets real teeth in step 4 of §9: each plugin connects as its own
Postgres role, `plugin_<name>`, which owns its schema and has no grant on
`core`. Until then scope in `db` is a rule, and the import test below
catches the cross-schema reads that exist.

**The boundary, plainly.** Plugins run inside buddi's process. `ctx.buddi`
is the supported path, not a sandbox: a plugin that wants to can `import`
a file by absolute path, read `process.env` or open a socket to Postgres.
What stands between a hostile plugin and the owner is the same as today:
the two install approvals, the recorded integrity hash, and the owner
reading the card. What this spec adds is that honest plugins have no reason
to reach further, so any reach is visible in review:

- `packages/gateway/src/plugin-imports.test.ts` walks every plugin source
  in `packages/tools/*` and fails on any import of `@buddi/core` other than
  `@buddi/core/plugin` (and `@buddi/core/testing` in tests), any
  `@buddi/runtime`, `@buddi/gateway` or `@buddi/tool-*`, and any `core.`
  table in a SQL string, naming the file, as `bundle.test.ts` does for the
  web package. buddi-plugins runs the same check from its root `pnpm test`.
- For installed plugins, the `@buddi/core` link made at install points at a
  package whose only export is `@buddi/core/plugin`, so an import of an
  internal by package name fails to resolve.
- After boot the gateway deletes `DATABASE_URL`, `BUDDI_VAULT_KEY` and every
  known secret from `process.env`, and the email plugin stops writing
  passwords there.

**Out of scope: process isolation.** Running each plugin in its own worker
or process, with `ctx.buddi` as an RPC surface and its own database role,
would make the boundary real. It needs every area to be serialisable
(files as streams, `deliver` run in core with the destination's backend
reached over the bridge), and tools that hold handles today (developer's
child processes, browser's driver) to live in the plugin's process. The
areas are designed so that move is possible later: every method is async
and takes and returns plain data.

## 7. Versioning

`ctx.buddi.version` is `major.minor`, starting at `1.0`. A plugin declares
the version it was built against as `buddi.hostApi` in `package.json`
(`"^1.2"`), and one that asks for more than this buddi has is refused at
stage time with both numbers.

A minor adds a method, an optional argument or an optional field on a
return; it never changes what an existing call does. A major removes or
changes something, and ships only after one release in which both shapes
exist and the old one logs its caller. docs/plugins.md §9 lists each
method with the minor that introduced it, and `plugin-reference.test.ts`
checks that table against the interface as it does for `ToolContext`.

## 8. Migration

One plugin per commit, in §2's order: template, memory, finance, artifacts,
web, browser, host, image, developer, email. Each commit is mechanical:
replace a context field or an import with the `ctx.buddi` call that wraps
it, move a `core.*` read behind the area method named in §4, add `uses` to
the manifest and `package.json`, and keep every test passing unchanged
except for the fixture that builds the context. No refactors, no renames,
no behaviour changes; anything else noticed goes on a list.

The old `ToolContext` fields stay, marked deprecated, until the last plugin
has moved. The series ends with: the deprecated fields removed; the import
test turned on; the `@buddi/core` install link narrowed; and
docs/plugins.md rewritten around `ctx.buddi` (§1's "what a plugin is",
§6's secret rule, and §9's `ToolContext` table split into "the call" and
"the host").

## 9. Order of work

1. `@buddi/core/plugin` with the pure helpers; the `BuddiHost` type; core
   builds it per plugin from today's fields; always-present areas, `files`,
   `accounts`, `proposals`, `schedule`, `http`; `uses` parsed and matched;
   the install and upgrade cards list areas (two days).
2. The plugin migrations, one commit each (two days for the ten; email and
   image carry most of it).
3. `secrets` with destinations and the vault behind it, enough for email's
   mailbox passwords to move off `createVault` and out of `process.env`
   (one day; the rest is owner-secrets).
4. The ban: the import test in both repositories, the narrowed install
   link, the environment cleared after boot, per-plugin Postgres roles
   (one day).
5. docs/plugins.md rewritten, `plugin-reference.test.ts` extended (one day).

About a week.

## 10. Acceptance

1. `plugin-imports.test.ts` passes, and fails naming the file when a plugin
   imports `createVault` or queries `core.events`.
2. A plugin with no `uses` gets a `ctx.buddi` with only the always-present
   areas; `ctx.buddi.secrets` is `undefined`.
3. Installing image shows "uses a model account you pick" and "keeps
   files in your Files library" on the card before its code runs.
4. The email plugin adds and removes a mailbox with no `createVault`
   import, and no mailbox password is in `process.env`.
5. As `plugin_finance`, `select * from core.agents` fails with a permission
   error.
6. A plugin declaring `buddi.hostApi: "^1.9"` is refused at stage time on a
   `1.0` host.
7. Every plugin in both repositories passes its tests after its migration
   commit with only its context fixture changed.

## 11. Open questions

- Should `files` scope default to "own and handed in" as written, or is the
  whole library the honest default for a personal assistant?
- `memory`: ship the area empty until a plugin needs it, or build it in
  step 1?
- Per-plugin Postgres roles need `createrole` on the owner's database; is
  that acceptable on every install path (Homebrew, the app bundle)?
