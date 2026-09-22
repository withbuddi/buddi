# Plugin pages: a plugin's screens, as data

Status: specified 2026-09-22, not built. The proof of it is porting the Mail
page and Settings → Email to it and deleting their compiled-in versions.

## 1. The problem

The email plugin is a plugin for its tools, watchers and tables, and a
built-in for its screens: the Mail page, the rail entry and the Settings →
Email section are compiled into `packages/web` by name. That makes "plugin"
mean two things, and it means nobody else can ship a screen. This spec gives a
plugin one way to put a screen in the dashboard, with the same rule views
already follow: **a screen is data the page interprets; no plugin code runs
in the browser.**

## 2. Principles

- **Descriptors, not components.** A page is a tree of a small, fixed set of
  generic components, each bound to a plugin query for its data and to a
  plugin tool for its writes. The set is sized by what email and finance need
  and does not grow to fit one plugin's wish; a plugin that needs more serves
  its own app through the developer proxy (`developer.md`).
- **Reads are queries, writes are tools.** A query is a read-only function the
  plugin exports; it cannot write. A write is a tool call made as the owner.
  An `auto` tool executes; a `gated` tool yields an approval, and the page
  shows the approval card in place, choices and all. There is no third path,
  so everything the owner can do from a screen is something an agent could be
  granted, audited the same way.
- **Validated at the boundary.** Descriptors are parsed at `register()` like
  views: a bad one is a startup error naming the plugin, the page and the
  field. Query results are validated against the shape the descriptor names
  before they reach the browser.
- **Untrusted content stays text.** Everything a query returns is rendered as
  text nodes. No HTML, no markdown, no links except those the descriptor
  constructs from ids.
- **URLs for things.** A page has a route; an item in a list-detail page has a
  URL. The rail, the settings tabs and the browser history know nothing about
  the plugin except what the descriptor says.

## 3. The contribution

```ts
export interface PluginManifest {
  // …
  pages?: PageDescriptor[];
  queries?: PageQuery[];
}

export interface PageQuery {
  name: string;                       // 'threads', 'thread', 'accounts'
  params: z.ZodTypeAny;               // validated; unknown keys refused
  produce(params: unknown, ctx: ToolContext): Promise<unknown>;  // read-only
  /** Optional result shape; when given, the result is validated before it leaves. */
  result?: z.ZodTypeAny;
}

export interface PageDescriptor {
  id: string;                         // 'mail', 'settings' — unique in the plugin
  title: string;
  /** One read for the page itself; the data its top level is drawn against. */
  data?: QueryRef;
  /** Where it lives. `rail` gives it a rail entry; `settings` a settings tab. */
  place: 'rail' | 'settings';
  /** One of a pinned set the dashboard draws; never an arbitrary image. */
  icon?: 'mail' | 'money' | 'calendar' | 'people' | 'file' | 'chart' | 'bell' | 'plug' | 'key' | 'globe';
  /** Rail order among plugin entries; core places are fixed. */
  order?: number;
  body: Component[];
}
```

Routes: a rail page is `#/p/<plugin>/<page>`; an item inside a list-detail is
`#/p/<plugin>/<page>/<itemId>`. A settings page is a tab
`#/settings/p.<plugin>` (or `#/settings/p.<plugin>.<page>` when a plugin has
several) — the `p.` prefix is what keeps a plugin called `memory` off the core
section's own hash. The gateway
serves the descriptors at `GET /api/pages` (session-gated), the queries at
`GET /api/pages/<plugin>/<query>?<params>` (each param validated by the
query's schema), and writes at `POST /api/pages/<plugin>/act` with
`{ tool, args }`: the tool is invoked through the registry with
`agentId: 'owner'`, and the response is either the tool's result or
`{ approvalId }` for a gated tool. Only the tools this plugin's own pages name
may be invoked, at 60 writes a minute per session, and CSRF as every other
write. A gated tool's `then` is held until the approval has actually
executed — nothing has happened yet when the card appears.

Tools an owner may call from a page but no agent should see carry
`ownerOnly: true` (new `ToolDefinition` field, off by default): the registry
never lists them to a model. `email.add_account` (which stores a secret) is
the first one.

## 4. The components

Every component may carry `when: { path, equals }` against the page's data to
show or hide itself, and `title`, `note` (one line under the title) and
`empty` (the sentence when there is nothing). Paths are view paths (`views.ts`,
`VIEW_PATH`).

Every component may carry `when`, `title`, `note` and `empty`. `when` is a
`Visibility`: `{ path, equals }`, or `{ path, in: [...] }`, with `not: true` to
invert — one condition rather than one component per value.

```ts
type Component =
  | { kind: 'section'; title?: string; note?: string; body: Component[] }
  | { kind: 'notice'; text: string | ValueRef; tone?: Tone }
  | { kind: 'link'; label: string; to: RouteRef }
  | { kind: 'stats'; query: QueryRef; items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }> }
  | { kind: 'list'; query: QueryRef; rows: string; item: ListItem; select?: Selection; actions?: RowAction[]; bulk?: BulkAction[]; groupBy?: GroupBy; collapsed?: { label: string; rows: string } }
  | { kind: 'table'; query: QueryRef; rows: string; columns: ColumnMap[]; actions?: RowAction[] }
  | { kind: 'detail'; query: QueryRef; fields: Array<{ label: string; value: ValueRef; unit?: Unit }>; body: Component[] }
  | { kind: 'form'; fields: Field[]; submit: ToolRef; initial?: QueryRef; drawer?: { title: string; button: string } }
  | { kind: 'search'; fields: Field[]; query: QueryRef; rows: string; results: ListItem; to?: RouteRef; count?: string; note?: string; auto?: true }
  | { kind: 'list-detail'; list: Component & { kind: 'list' }; param: string; selection?: 'route' | 'local'; detail: Component[] }
  /** The same sub-tree once per row, with that row as its data. */
  | { kind: 'repeat'; query: QueryRef; rows: string; key: string; body: Component[] }
  | { kind: 'expand'; query: QueryRef; label: string | ValueRef; body: Component[] }
  /** One button, anywhere; its `ValueRef` args resolve against the row it stands in. */
  | { kind: 'button'; action: ToolRef }
  | { kind: 'approval'; path: string }          // an approval id in the data; draws ApprovalCard
  | { kind: 'artifact'; path: string; label: string }  // an artifact id; draws the download link
  | { kind: 'editor'; query: QueryRef; fields: Field[]; save: ToolRef; actions?: ToolRef[]; footnote?: string; readOnlyWhen?: Visibility; version: string };

interface Visibility { path: string; equals?: unknown; in?: unknown[]; not?: true }

interface QueryRef { query: string; params?: Record<string, ValueRef | { param: string } | { route: string }> }
interface ToolRef { tool: string; label: string; args?: Record<string, ValueRef | { param: string } | { field: string } | { selected: true }>; tone?: 'accent' | 'danger'; confirm?: string; busy?: string; placement?: 'leading'; then?: 'refresh' | 'close' | { route: RouteRef } }
interface RouteRef { page: string; item?: ValueRef }        // within the same plugin
interface ListItem { title: ValueRef; sub?: ValueRef; meta?: ValueRef[]; pill?: { value: ValueRef; tone?: Tone }; to?: RouteRef }
interface Selection { key: string; disabledWhen?: Visibility }
interface RowAction extends ToolRef { args: Record<string, ValueRef | { row: string }> }
interface BulkAction extends ToolRef { args: Record<string, ValueRef | { selected: true }> }
interface Field { name: string; label: string; type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'secret' | 'email' | 'date'; options?: Array<{ value: string; label: string }>; required?: boolean; min?: number; max?: number; step?: number; hint?: string; from?: string; disabledWhen?: Visibility }
```

What each one is for, in email's terms:

| Component | Email uses it for |
| --- | --- |
| `repeat` | Mail: a thread's messages, each an `expand` with its own body and its own attachment |
| `button` | Mail: Fetch this attachment — and, once it has an id, the `artifact` link in its place |
| `list-detail` | Mail: threads on the left (or above on a phone), one thread's URL on the right; `selection: 'local'` for a second level inside it |
| `search` | Mail: the search field with its filters, results linking to a thread |
| `list` with `collapsed` | Drafts under a thread, older drafts folded |
| `expand` | A message's body, fetched when opened |
| `editor` | A draft: fields, Save with the `updatedAt` version, Discard and Send as actions |
| `approval` | The send's approval card, with the alias select |
| `artifact` | A fetched attachment's download link |
| `form` with `drawer` | Add an account, Add a rule |
| `list` with `select` + `bulk` | Applied and proposed policies: keep or revoke many |
| `form` with `initial` | The Watchers block: five numbers, one Save |
| `table` | The accounts list with their state and a remove action (with `confirm`) |
| `stats` | Counts at the top of a settings page |

Not in the set, on purpose: free layout, custom styling, charts (those are
canvas views), embedded HTML, client-side logic beyond `when`. A plugin that
needs those serves its own app.

## 5. The dashboard side

One generic `PluginPage` in `packages/web` reads `/api/pages`, adds rail
entries after the core places and settings tabs after the core sections,
and draws a descriptor with the existing `ui/` primitives (Section, Stack,
Table, Sheet, Toolbar, Button, Notice, Pill, Input, Select, Textarea,
ApprovalCard). Data loads per component through the query route; a write
calls the act route and then does what `then` says. Design rules hold: tokens
only, primary action right-aligned, hairlines between stacked sections,
phone width works.

## 6. What core keeps

The rail's core places, the settings' core sections, the Watchers page (a
core page fed by sentinels), Plugins, Home. A plugin adds beside them, never
inside them; `home` blocks and `views` remain the way into Home and the canvas.

## 7. The proof, and the order of work

1. Core types, validation, the registry's `pages()`/`queries()`, the three
   gateway routes, `ownerOnly` tools, and the generic `PluginPage` with every
   component, exercised by a synthetic test plugin that uses each component
   once (its own DB tests and page tests).
2. Port email: `queries` for threads, thread, message, drafts, accounts,
   policies, watcher settings; `ownerOnly` tools for add/remove account, set
   policy, bulk policies, save/discard/send draft, fetch attachment (thin over
   the existing store functions); the two descriptors; then delete `Mail.tsx`,
   the email parts of `Email.tsx`, the email routes in the gateway, the `Mail`
   rail entry and the `email` settings section. The only email names left in
   `packages/web` and `packages/gateway/src/web` are in tests of the generic
   engine that happen to use email's descriptor as a fixture.
3. `docs/plugins.md` §2.5a rewritten: pages and settings are contributions;
   the "not available" list shrinks to code-in-the-page.

## 8. Acceptance

- The Mail page and Settings → Email look and behave as today, from
  descriptors, with a URL per thread.
- `grep -ri email packages/web/src --exclude-dir=__fixtures__` finds nothing
  outside tests.
- A second plugin (the synthetic one) gets a rail entry and a settings tab
  with no change to `packages/web`.
- A descriptor with a typo fails plugin load with the path to the field.
  So does one that is not a screen: components nested deeper than 12, more than
  400 nodes, more than 64 KB, or an object that contains itself. A descriptor
  that *reuses* an object — the same action on two rows — is not a cycle and
  loads.
- A query cannot write, and **Postgres** is what says so: the `ToolContext` it
  receives has a pool wrapper that runs every statement inside
  `begin isolation level repeatable read read only; set local
  statement_timeout = '5s'; … rollback`. That refuses `insert`/`update`/
  `delete`/`create`/`select … into`/`nextval`/large-object writes *including
  inside a volatile function the plugin wrote itself*. A textual scanner stays
  in front of it as a cheap pre-filter — first keyword `select` or `with`, no
  second statement, no `into`, no locking clause — but it is not the boundary,
  because no lexical scan can decide whether `select plugin.f()` writes.
  - Two things a read-only transaction does not cover, and they are limits
    rather than bugs: `pg_read_file` and `pg_terminate_backend` write no rows.
    The answer to those is a Postgres role without those grants, which is how
    an installation that runs third-party plugins should be configured; buddi
    does not create such a role today.
- The act route invokes only the tools a plugin's own pages name
  (`registry.pageTools`), at 60 writes a minute per session.
- `owner` and `room` are reserved agent ids, so nothing can become a second
  principal behind the id a page's writes are recorded under.
