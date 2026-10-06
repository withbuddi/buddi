---
title: "Plugin pages: a plugin's screens, as data"
status: reference
updated: 2026-09-25
---

# Plugin pages: a plugin's screens, as data

A plugin puts a screen in the dashboard by describing it. The Mail page and
Settings → Email are descriptors the email plugin contributes, and
`packages/web` names no plugin outside its redirect table. The how-to for
plugin authors is [plugins.md](plugins.md) §2.5a and §2.5b; this page is the
design.

## 1. The problem it answers

A plugin whose screens are compiled into `packages/web` by name is a plugin
for its tools, watchers and tables and a built-in for its screens. That makes
"plugin" mean two things, and it means nobody else can ship a screen. So a
plugin has one way to put a screen in the dashboard, with the same rule views
follow: **a screen is data the page interprets; no plugin code runs in the
browser.**

## 2. Principles

- **Descriptors, not components.** A page is a tree of a small, fixed set of
  generic components, each bound to a plugin query for its data and to a
  plugin tool for its writes. The set is sized by what email and finance need
  and does not grow to fit one plugin's wish; a plugin that needs more serves
  its own app through the developer proxy ([developer.md](developer.md) §12).
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
  /** Masked on the page until the owner asks (as a sensitive Home block); left out over MCP unless asked. */
  sensitive?: boolean;
}

export interface PageDescriptor {
  id: string;                         // 'mail', 'settings' — unique in the plugin
  title: string;
  /** One read for the page itself; the data its top level is drawn against. */
  data?: QueryRef;
  /** Where it lives. `rail` gives it a rail entry; `settings` a settings tab. */
  place: 'rail' | 'settings';
  /** One of a pinned set the dashboard draws; never an arbitrary image. */
  icon?: 'mail' | 'money' | 'calendar' | 'people' | 'file' | 'chart' | 'bell' | 'plug' | 'key' | 'globe' | 'sun' | 'cloud' | 'news'; // news: host API 1.27
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

A query may also answer with bytes rather than data: `pageFile({ body,
contentType, filename, disposition })` from core. The query route then streams
it — same session check, same parameter validation — instead of serialising
JSON, and the gateway, not the plugin, decides what is shown inline on the
dashboard's origin: text (always as `text/plain`), passive images and PDF, each
under a sandboxing CSP; anything else is an `application/octet-stream`
download. This is what the chat canvas's Files tab reads a workspace with
(`files` on the manifest names the queries; the developer plugin's workspace
browser is the one that uses it), and it is the only non-JSON answer the route
has.

Tools an owner may call from a page but no agent should see carry
`ownerOnly: true` (new `ToolDefinition` field, off by default): the registry
never lists them to a model. `email.add_account`, which stores a secret, is
one.

## 4. The components

Every component may carry `when` against the page's data to show or hide
itself, and `title`, `note` (one line under the title) and `empty` (the
sentence when there is nothing). Since host API 1.28 it may also carry
`where: 'local' | 'remote'`: drawn only in a browser on the computer buddi
runs on (127.0.0.1, localhost, ::1), or only anywhere else. `when` is a `Visibility`: `{ path, equals }`,
or `{ path, in: [...] }`, with `not: true` to invert — one condition rather
than one component per value. Paths are view paths (`views.ts`, `VIEW_PATH`).

```ts
type Component =
  | { kind: 'section'; title?: string; note?: string; actions?: Array<{ kind: 'link' | 'button' }>; body: Component[] }
  | { kind: 'notice'; text: string | ValueRef; tone?: Tone }
  | { kind: 'link'; label: string; to: RouteRef }
  /** A bar: `value` a fraction 0–1, or a count of bytes against `total`; `label` the line above; `done` the line instead of the bar once it is full. */
  | { kind: 'progress'; value: ValueRef; total?: ValueRef; label?: string | ValueRef; done?: string | ValueRef }
  /** A small inline chart of a query's rows: a line (default) or bars; `y` one path or up to four; `rows` left out when the answer is the array; `target` a dashed line, read from the answer.
      `series` instead of `y` and `type`: a line and bars together, each on its own scale, across the page's width. */
  | { kind: 'chart'; query: QueryRef; rows?: string; x: string; y?: string | string[]; type?: 'line' | 'bar'; series?: ChartSeries[]; label?: string; target?: ValueRef }
  | { kind: 'stats'; query: QueryRef; items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }> }
  | { kind: 'list'; query: QueryRef; rows: string; item: ListItem; select?: Selection; actions?: RowAction[]; bulk?: BulkAction[]; groupBy?: GroupBy; collapsed?: { label: string; rows: string } }
  /** A column may carry `pill: { tone }` — a state, in the tone the row names;
      an array value draws one pill per `{ value, tone }` item. */
  | { kind: 'table'; query: QueryRef; rows: string; columns: ColumnMap[]; actions?: RowAction[] }
  | { kind: 'detail'; query: QueryRef; fields: Array<{ label: string; value: ValueRef; unit?: Unit }>; body: Component[] }
  /** `columns`: fields to a row on a wide panel, 2 (default) or 3; the grid still drops to two, then one, as it narrows. */
  | { kind: 'form'; fields: Field[]; submit: ToolRef; initial?: QueryRef; drawer?: { title: string; button: string }; columns?: 2 | 3 }
  | { kind: 'search'; fields: Field[]; query: QueryRef; rows: string; results: ListItem; to?: RouteRef; count?: string; note?: string; auto?: true; reset?: true }
  | { kind: 'list-detail'; list: Component & { kind: 'list' }; param: string; selection?: 'route' | 'local'; detail: Component[] }
  /** The same sub-tree once per row, with that row as its data. */
  | { kind: 'repeat'; query: QueryRef; rows: string; key: string; body: Component[] }
  /** Dated events: week, month and list views behind a switch; the page adds `from` and `to` (YYYY-MM-DD, `to` exclusive) to the query. */
  | { kind: 'calendar'; query: QueryRef; events: string; map: CalendarMap; views?: Array<'week' | 'month' | 'list'>; default?: 'week' | 'month' | 'list'; hours?: [number, number] }
  /** The canvas tiles on a page: one card per item; `layout` grid (wraps), row (shares the width) or strip (scrolls sideways); `select` writes the picked item's `key` into page parameter `param`. */
  | { kind: 'tiles'; query: QueryRef; items: string; icon: { path: string } | { const: TileIcon }; value: string; label: string; lines?: string[]; tone?: string; layout?: 'grid' | 'row' | 'strip'; select?: { param: string; key: string } }
  /** A day in one panel: tabs across `series`, the chosen one an area (or bars) with its values written on it, over a strip of `tiles` drawn from the same `points`; one hover or pick marks both. */
  | { kind: 'series-panel'; query: QueryRef; points: string; x: string; series: SeriesPanelSeries[]; tiles: { icon: { path: string } | { const: TileIcon }; value: string; label: string; lines?: string[] }; labelEvery?: number }
  /** Now, large: a glyph, a big value and its word, and labelled facts beside; every path read in the query's answer. */
  | { kind: 'hero'; query: QueryRef; icon: { path: string } | { const: TileIcon }; value: string; title: string; facts: Array<{ label: string; path: string }> }
  /** Two to six views behind a switch at the right of a bar, only the chosen one drawn; `pick` a second switch at its left, written into a page parameter. */
  | { kind: 'tabs'; tabs: Array<{ id: string; label: string; body: Component[] }>; default?: string; pick?: TabsPick }
  | { kind: 'expand'; query: QueryRef; label: string | ValueRef; body: Component[] }
  /** One button, anywhere; its `ValueRef` args resolve against the row it stands in. */
  | { kind: 'button'; action: ToolRef }
  /** 1.28: one button opening a short menu; each item runs a tool or opens a drawer form of the page by its id. */
  | { kind: 'menu'; label: string; tone?: 'accent'; items: MenuItem[] }
  | { kind: 'approval'; path: string }          // an approval id in the data; draws ApprovalCard
  | { kind: 'artifact'; path: string; label: string }  // an artifact id; draws the download link
  /** 1.30: one email, read: header, sanitised HTML or text, quotes folded, files as rows. The data is a `PageMessage`. */
  | { kind: 'message'; path?: string; query?: QueryRef; folded?: Visibility; fetch?: ToolRef }
  | { kind: 'agent-offer'; agent: string; text: string; label: string }  // one of this plugin's proposed agents: a line and an accept button (the gated platform.accept_plugin_agent, card in place).
  | { kind: 'editor'; query: QueryRef; fields: Field[]; save: ToolRef; actions?: ToolRef[]; footnote?: string; readOnlyWhen?: Visibility; version: string }
  /** 1.27: a feed of stories (the News page): cards, group heads with See all, a ⋯ of ways out with Undo, a sheet per story. Rows are `StoryRow`s. */
  | { kind: 'stories'; query: QueryRef; rows: string; groups?: { param: string; label?: string }; ways?: StoryWay[]; ask?: { label: string; to: RouteRef; when?: Visibility }; edition?: { label: string; to: RouteRef; when?: Visibility }; param?: string; emptyStates?: StoriesEmpty[] };

// 1.27 additions elsewhere: PageDescriptor.actions (links and buttons in a rail page's head); notice look: 'quiet', icon, link, action;
// link tone: 'accent'; tabs param (the chosen tab in a page parameter); TabsPick look: 'chips' and add; ListItem logo, tag, status;
// RowAction menu, hint, group; GroupBy label and aside; a first notice's text read from the page's data is the page's intro.
// 1.28 additions elsewhere: ListItem swatch and choice; GroupBy asideTone and actions; a form drawer's id (button optional);
// a repeat's poll.finish; a calendar's count and sheet (CalendarSheet); `where` on every component; `menu` in a section's or a page's head; ArgRef { choice: true }.
// 1.30 additions elsewhere: section query and heading; ListItem strong and preview; ↑ ↓ and Enter in a list beside a reading pane.
interface PageMessage { id?: string; from: { name?: string | null; address: string }; to?: PageMessageAddress[]; cc?: PageMessageAddress[]; at?: string | null;
  html?: string | null; text?: string | null; snippet?: string | null; note?: string | null;
  attachments?: Array<{ name: string; size: number; mime: string; artifactId: string | null; contentId?: string | null; [key: string]: unknown }> }
interface RowChoice extends Omit<ToolRef, 'args' | 'confirm'> { value: string; options: RowChoiceOption[]; args: Record<string, ValueRef | { row: string } | { choice: true }> }
interface RowChoiceOption { value: string; label: string; when?: Visibility; disabledWhen?: Visibility; hint?: string }
interface MenuItem { label: string; hint?: string; when?: Visibility; action?: ToolRef; open?: string }
interface CalendarSheet { notes?: string; color?: string; mapHref?: string; open?: { label: string; href: string }; asks?: Array<{ label: string; text: string }> }
interface RepeatPoll { seconds: number; while: Visibility; finish?: { when: Visibility; action: Omit<ToolRef, 'args' | 'confirm'> & { args: Record<string, ValueRef | { row: string }> } } }
interface StoryRow { id: string; title: string; lead?: string; summary?: string; update?: string; url?: string; ago?: string; opinion?: boolean; languages?: string;
  mark?: { kind: 'told' | 'new'; text: string }; quiet?: boolean; outlets: Array<{ id?: string; name: string; logo?: string }>; group?: { id: string; name: string };
  kicker?: string; meta?: string; sources?: Array<{ title: string; url?: string; outlet: string; logo?: string; meta?: string }>; timeline?: Array<{ at: string; text: string; told?: boolean }> }
/** `{ row }` reads the story, `{ item }` the element of `each` ("Mute {name}" once per outlet); `hides` leaves `done` and `undo` in the card's place. */
interface StoryWay extends Omit<ToolRef, 'args'> { args: Record<string, ValueRef | { row: string } | { item: string }>; each?: string; hint?: string; group?: string; when?: Visibility; hides?: true; undo?: { tool: string; label: string; args: Record<string, ValueRef | { row: string } | { item: string }> } }
interface StoriesEmpty { when: Visibility; title: string | ValueRef; text?: string | ValueRef; warm?: true; actions?: Array<{ label: string; to?: RouteRef; set?: Record<string, string> }> }

interface Visibility { path: string; equals?: unknown; in?: unknown[]; not?: true }
/** A word about state; `tone` may itself be a path within the row. */
interface PillRef { value: ValueRef; tone?: Tone | ValueRef; labels?: Record<string, string>; tones?: Record<string, Tone> }  // labels: a slug's words; tones: per value
/** A select's options, read rather than written. */
interface OptionsFrom { query: QueryRef; rows: string; value: string; label: string; dependsOn?: string[] }

interface QueryRef { query: string; params?: Record<string, ValueRef | { param: string } | { route: string }> }
interface ToolRef { tool: string; label: string; args?: Record<string, ValueRef | { param: string } | { field: string } | { selected: true }>; tone?: 'accent' | 'danger'; confirm?: string; busy?: string; done?: string | ValueRef; pending?: string; placement?: 'leading'; then?: 'refresh' | 'close' | { route: RouteRef } }
/** Within the same plugin — or, the one exception, one agent's chat. */
type RouteRef = { page: string; item?: ValueRef } | { chat: ValueRef } | { proposals: true } | { href: ValueRef } // href: 1.27
interface ListItem { title: ValueRef; sub?: ValueRef; meta?: ValueRef[]; pill?: PillRef; pills?: PillRef[]; to?: RouteRef; images?: ImageRef[] | ImageList }
/** 1.27: a key of the plugin's own assets and the words it stands for; up to four slots. */
interface ImageRef { asset: ValueRef; label: ValueRef }
/** 1.27: the same, read from an array in the row (paths within one element). */
interface ImageList { from: string; asset: string; label: string }
interface Selection { key: string; disabledWhen?: Visibility }
/** Paths within an event row. `start`/`end`: ISO instants, or YYYY-MM-DD for all-day (`end` the day after); `tone`: a number, the calendar's index. */
interface CalendarMap { id: string; title: string; start: string; end: string; allDay?: string; calendar?: string; tone?: string; location?: string }
/** One series of a two-kind chart; the bars' scale is on the right, 0–100 with `unit: 'percent'`. */
interface ChartSeries { y: string; type: 'line' | 'bar'; label: string; unit?: 'percent' }
/** One tab of a series panel: `temp` fitted to the day with `°`, `percent` 0–100 with `%`, `speed` from zero. */
interface SeriesPanelSeries { id: string; label: string; y: string; unit?: 'percent' | 'temp' | 'speed'; kind: 'area' | 'bars' }
/** Which place, which account: the first option until the owner picks; with one option, nothing is drawn. */
interface TabsPick { param: string; label: string; options?: Array<{ value: string; label: string }>; optionsFrom?: OptionsFrom }
/** `label` and `confirm` may carry `{field}` placeholders read from the row. */
interface RowAction extends ToolRef { args: Record<string, ValueRef | { row: string } | { field: string }>; when?: Visibility; form?: RowActionForm }
/**
 * Ask first: the button opens a small sheet with these fields, Cancel and `submit`;
 * `{ field }` args read it. A refusal stays in the sheet; success closes it.
 * `openWhen` opens it by itself on the row where every named page parameter holds
 * (a literal, or `{ row }` for that row's field). A page's hash carries page
 * parameters after `?`: `#/settings/p.email.settings?account=<id>&set=password`.
 */
interface RowActionForm { title: string; fields: Field[]; submit: string; openWhen?: Record<string, string | { row: string }> }
/** `all` offers it over every enabled row when nothing is ticked. */
interface BulkAction extends ToolRef { args: Record<string, ValueRef | { selected: true }>; all?: true }
interface Field { name: string; label: string; type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'secret' | 'email' | 'date'; options?: Array<{ value: string; label: string }>; optionsFrom?: OptionsFrom; multiple?: boolean; required?: boolean; min?: number; max?: number; step?: number; hint?: string; from?: string; when?: Visibility; disabledWhen?: Visibility; action?: FieldAction }
/** A small icon button right after a single select: a tool run with the form's current, unsaved values. */
interface FieldAction { tool: string; label: string; icon?: 'play'; args?: Record<string, ValueRef | { param: string } | { field: string } | { selected: true }> }
/** A tool result's sound: `{ play: PagePlay, message?: string }`. */
interface PagePlay { mime: string /* audio/* */; data: string /* base64, ≤ 512 KB decoded */ }

// `when` and `disabledWhen` on a Field are asked of the form's own values
// first — a path naming a field reads what the owner has just typed — and of
// the loaded data otherwise. A field they hide or grey is neither required
// nor submitted: the owner said nothing about it.
// A select with `multiple: true` holds an array of the chosen values (empty
// for none) and submits it as one; `from` reads an array too. It is drawn as
// chips with an Add list; `max` caps how many it takes.
// A select's `action` draws a small icon button after it (its `label` is the
// button's name and tooltip). Pressing it calls the tool with `args` resolved
// as a submit's — `{ field }` reads what is on the form now, hidden and greyed
// fields left out — or, with no `args`, with the form's active values. Nothing
// is refreshed after, so the unsaved choices stay. It spins while the tool
// runs and is a stop button while a sound it returned plays.
//
// A sound: any page action — a button, a submit, a field's action — whose tool
// answers `{ play: { mime, data } }` has it played in the browser through one
// shared Audio element from a blob URL, revoked when it stops; nothing is
// stored and a second sound stops the first. `mime` must be `audio/*` and
// `data` base64 of at most 512 KB (`PAGE_PLAY_MAX_BYTES`), or it is ignored.
// The result's `message`, when there is one, is shown as the sentence.

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
| `select` field with `multiple` | (Speech) The languages you speak, several at once |
| `form` with `columns: 3` | (Speech) Speaking: Service and the two voices on one row |
| `progress` | (Speech) A model download: a bar and "7 of 252 MB · 2%", then "Installed, 252 MB" |
| `chart` | (Goals) A goal's values over its window as a line with the target dashed; a frequency goal's weeks as bars |
| select field with `action`, and `play` | (Speech) The play button beside the Voice: a sample said with the unsaved choices, heard in the browser |
| `calendar` | (Calendar) The rail page: the week's hours, the month's days, or the days as a list, from the linked calendars |
| `tabs` with `pick` | (Weather) The rail page: Home · Work at the left, Today · Week · 10 days at the right. (Mail) One tab and a pick: All · Needs a reply · Notifications over the conversations |
| `hero` | (Weather) Now: the sky's glyph, the temperature and its word; feels like, high and low, wind, rain, sunrise and sunset beside |
| `tiles` | (Weather) The next 24 hours as a strip; the week as a row whose picked day shows its hours below; ten days as a row |
| `series-panel` | (Weather) Today's next 24 hours, and the picked day's hours in Week: temperature, rain chance and wind as tabs over the hourly strip |
| `list` with `groupBy.actions`, `swatch` and `choice` | (Calendar) Settings: one list grouped by account, Sign in again and ⋯ Remove account… on each head, each calendar's colour and Not linked · Read · Read and change |
| `menu` with drawer ids | (Calendar) Add a calendar → Sign in with Google · Link with an app password · Paste a private link |
| `calendar` with `count` and `sheet` | (Calendar) The rail page: "12 events" beside the week, an event opening its sheet with Move or change… and Cancel… for the corner chat |
| `repeat` with `poll.finish` and `where` | (Calendar) The Google sign-in card: it finishes by itself when Google answers, the pasted address only from another computer |

A `chart` is small on purpose: a trend beside the numbers, drawn inline in
the dashboard's own colours, with two ticks a side, the first and last x
(and the middle one past four points), and a legend only for several series.
A row whose `y` is not a number is a gap in the line, not a zero; bars stand
on zero. A screen reader hears a sentence instead of the drawing: how many
points, from when to when, each series' latest, lowest and highest, and the
target. A chart with hover, zoom, annotations or many series is a canvas
view (`timeseries`), not a page component.

A `calendar` is the design kit's Calendar screen. **Week**: seven columns
from Monday, all-day events as chips at the top, timed ones as blocks placed
by the hour (side by side where they overlap) in a grid that scrolls through
the day with `hours` (7–21 unless it says) in view. **Month**: six weeks of
days, three events a day then "+N"; choosing a day lists it in a panel under
the grid. **List**: one panel per day for seven days, "Today · Mon 28 Sep",
with `empty` (default "Nothing.") on a day with nothing. ‹ Today › and the
range's name sit above; ←/→ move the range and T comes back to today. Times
are drawn in the owner's zone. `tone` picks one of four pinned colours
(modulo four). The page asks the calendar's query — that query alone, as a
`repeat`'s `poll` does — with `from` and `to` added to its parameters each
time the range changes, so the query must declare both: a descriptor whose
query does not is refused at load, and so is a `default` that is not one of
its `views`. The chosen view is remembered per page in the browser; with none
chosen a phone (under 720 px) opens on the list. Needs host API `^1.11`. Since host API 1.28, `count: true` writes how many events the range holds
beside its name, and `sheet` opens an event in a sheet of its own — when and
how long, its calendar and colour, the place linked out, the notes, a link to
it where it lives, and asks that open the corner chat with a request written
in — instead of listing its day under the week ([plugin-host-api.md](plugin-host-api.md) §7).

`tabs`, `hero`, `tiles` and a chart's `series` are the design kit's Weather
screen, and need host API `^1.12`. **`tabs`**: a bar with the pick's segment
at the left (drawn only when it has two options or more) and the tabs'
segment at the right; under it, the chosen tab's components and no others —
a tab not shown asks nothing. The pick writes its value into the page
parameter `param`, which a query below reads as `{ param }`; until the owner
picks, the parameter is unset and the query's own default answers, so the
first option should be what that default is. The chosen tab is not kept
across visits. A bar has two tabs or more, or — since host API 1.22 — one
tab and a pick: the bar is then the pick alone, at the left, a filter over the
one view (Mail's All · Needs a reply · Notifications); an older buddi refuses
a one-tab bar, so a plugin that draws one asks for `^1.22`. **`hero`**: a raised panel, the glyph and the big value side
by side with the `title` under them, and the facts in a row past a hairline;
a fact whose path answers nothing is left out. **`tiles`**: the canvas card
(`views.ts`), one per item, whose accessible name is the card read as one
sentence. `grid` wraps as on the canvas; in `row` and `strip` the card is
centred with the label on top — `row` shares the width between all the
cards, `strip` keeps each narrow and scrolls sideways. With `select`, each
card is a button that writes the item's `key` into page parameter `param`
and is marked while chosen; the first card is until the owner picks.
**`chart` with `series`**: one line and bars (or several of each), each
kind on its own scale — the line's on the left following its values, the
bars' on the right from zero, 0–100% when every bar series says `unit:
'percent'` — every point over its bar, an x label every few, across the
page's width, with a legend. A chart names `y` or `series`, never both, and
with `series` no `type`; a tab bar's `default` is one of its tabs. Each is
refused at load otherwise.

**`series-panel`** is the kit's day panel (`WxSeries`), and needs host API
`^1.13`. One raised panel with the component's `title` as its head; under it
a tab per series (drawn when there are two or more), the chosen series across
the width — `area` a line with a soft fill under it, `bars` a bar per point —
and under a hairline the strip of tiles, one per point, read with the same
paths as a `tiles`. The chart writes the point's own value above every
`labelEvery`-th point (3 by default) and an x label under the same ones. The
scale takes 3–4 ticks chosen so the values fill the height: fitted to the
range for `temp` (never from zero, so a 62° → 56° evening reads as the drop
it is), 0–100 for `percent`, from zero otherwise; values are written `20°`,
`70%` or bare. Hovering a point or a tile marks both with the same index —
the tile highlighted, a guide and a larger dot on the chart, the value
written — and a click pins it; from the strip, ←/→ move the pin and Home/End
go to the ends. The strip scrolls to keep the marked hour in view. A point
that draws no tile keeps its place, so a tile and its point never drift.
Series ids are the panel's own; one to four series, `labelEvery` 1–12.

**Pictures on a row and links out** (host API `^1.27`). A list item's
`images` draws small logos before its title, as the News page's story card
does: the first three overlapping, then who they are in words ("Reuters and
3 more"). Each picture is a key of the plugin's own assets
(`ctx.buddi.assets`, docs/plugin-host-api.md), drawn from buddi's
`/api/plugin-assets/<plugin>/<key>`, never from the outlet; a missing key or a
value that is not a key is a letter tile from its label. `{ href }` is the one
route out of buddi: an absolute `https:` address read from the data, opened in
a new tab with `noopener noreferrer` and an outside-link mark (↗); a value
that is not one is no link, and a tool's `then` never follows one by itself.
The page fetches nothing from it.

```ts
item: {
  title: { path: 'title' },
  to: { href: { path: 'url' } },
  images: { from: 'outlets', asset: 'logo', label: 'name' },
}
```

**A feed of stories** (`stories`, host API `^1.27`) is the kit's News page.
Cards in a grid three wide on a desk (one on a phone): the outlets' logos
stacked with "Reuters and 3 more" and the age on the head, the title in two
lines (italic for opinion), the lead in two, and quiet marks under it —
Opinion, `languages`, and `mark` as "✓ Told you · this morning" or an accent
"• New since this morning"; a `quiet` card is drawn flatter. Rows that carry
`group` are drawn under one head per group with See all, which writes the
group's id into page parameter `groups.param`; one group the parameter already
names has no head. The ⋯ (a bottom sheet on a phone) lists `ways` in order,
with a hairline and a small heading between groups; an `each` way is drawn
once per element ("Mute Reuters", "Mute Le Monde"). A way that `hides` gives
the card's place to its `done` sentence and its `undo` button for eight
seconds, where the card stood. A card opens the story's sheet (kept in page
parameter `param`, `story` by default): `kicker` as its title, the title, the
`summary`, the `update` in an accent box under `mark`, the quiet `meta` line
ending with `edition`'s link, Sources (logo, the article's title linked out,
its line), How it moved (`timeline`, the last step marked), and at its foot
the first hiding way, Less of this… (the other ways) and `ask` as the primary.
With no row, the first of `emptyStates` whose `when` holds of the answer is
drawn (warm for a first time), its actions going somewhere or setting page
parameters ("Show all"). Loading draws the cards' skeleton.

**A row's choice, a group's head, a menu, a card that finishes by itself**
(host API `^1.28`) are Settings → Calendar's. A list item's `choice` draws a
segment on the row's right — two to four options, the one at `value` in the
row chosen; an option is left out where its `when` does not hold and greyed
where its `disabledWhen` does, its `hint` the reason on hover and for a
screen reader. Picking another runs the tool with `{ choice: true }` as the
picked value (a choice never asks first: picking is the decision, and a
gated tool still raises its card); the pick shows at once, the control is
busy while the tool runs, and a refusal puts the old choice back with its
sentence above the list. On a phone the segment takes the row's width under
the name. `swatch` leads the row with its colour (a hollow dot for none).
`groupBy.actions` are row actions on the group's head, read against its first
row — buttons on the right, then a ⋯ for the ones marked `menu` — and
`groupBy.asideTone` paints the aside `warning` or `critical`. A `menu` is one
button (the accent with `tone`) whose items run a tool or open a drawer form
of the same page by its `drawer.id`; such a drawer needs no button of its own,
and the page parameter `open=<id>` opens it too
(`#/settings/p.calendar?open=paste`). A menu in a section's head says what its
tool answered under the head. A `repeat`'s `poll.finish` runs its tool once,
by itself, for the first row of an answer where `finish.when` holds — the
`busy` line drawn in place of the rows while it runs — then does its `then`;
a failure is said there and not retried for that row. With `where: 'remote'`
on the pasted-address form, the sign-in card is one button where the loopback
can answer and two steps where it cannot:

```ts
{ kind: 'repeat', title: 'Sign in with Google', query: { query: 'sign_in' }, rows: 'rows', key: 'id',
  poll: { seconds: 2, while: { path: 'waiting', equals: true },
          finish: { when: { path: 'state', equals: 'received' },
                    action: { tool: 'calendar.google_finish', label: 'Finish signing in', busy: 'Reading your calendars…', args: { id: { row: 'id' } } } } },
  body: [/* the waiting line, Continue to Google ↗, Cancel; a form with `where: 'remote'` */] }
```

**A message, read** (host API `^1.30`) is the Mail page's reading pane. A
`message` component draws one `PageMessage`: the sender's initial in a face,
"Name <address>", the time in the owner's format and zone, and "to …" that
opens To and Cc; then the body. `html` is sanitised again in the browser
before a node is drawn — parsed by `DOMParser` into an inert document and
walked into React elements from an allow-list (no scripts, styles, forms,
frames, media or event attributes; links http(s) and mailto only, opening in a
new tab with `noopener noreferrer`; a safe subset of inline style with every
`url(…)` refused). A remote picture is not an `<img>` at all until the owner
presses Show images, which is remembered per sender in this browser (and
undone with Hide pictures from this sender); a tracking pixel (1×1 or hidden)
is never drawn; a `cid:` picture is drawn from the attachment whose
`contentId` it names once that file is in the library. With no HTML, `text` is
drawn with its http(s) links. Quoted earlier messages — Gmail's
`gmail_quote`, `blockquote type=cite`, Outlook's reply header, `>` lines with
their "On … wrote:" line, an "Original Message" separator — fold behind
"··· earlier message", and a quote inside a quote folds again. Attachments are
file rows; one with an `artifactId` opens its library entry, one without has
`fetch`, its arguments read against that attachment. Caps: HTML over 600,000
characters is not parsed (the text is drawn), 5,000 elements, 32 levels deep
(deeper keeps its text), text over 200,000 characters is cut with a line.
With `query`, the row is only the header and the whole message is read when
it is drawn open; `folded` draws it as one line (face, name, snippet, time)
while it holds of the row. A `section` may read a `query` and draw its body
against the answer, with `heading` read from it in place of `title`; a list
item's `strong` draws the title heavier while it holds (unread) and `preview`
is one faint line under the row; ↑ and ↓ move through a list beside a reading
pane and Enter opens the focused row.

```ts
{ kind: 'section', title: 'Conversation', query: { query: 'thread', params: { id: { param: 'thread' } } }, heading: { path: 'subject' },
  body: [{ kind: 'repeat', query: { query: 'thread', params: { id: { param: 'thread' } } }, rows: 'messages', key: 'id',
           body: [{ kind: 'message', query: { query: 'message', params: { id: { path: 'id' } } }, folded: { path: 'folded', equals: true },
                    fetch: { tool: 'email.fetch_attachment', label: 'Fetch', args: { message: { path: 'messageId' }, index: { path: 'index' } } } }] }] }
```

Not in the set, on purpose: free layout, custom styling, embedded HTML beyond
a `message`'s sanitised body, client-side logic beyond `when`. A plugin that
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

**A page reads again when its plugin writes.** When any run (chat, Telegram,
a mission) finishes one of a plugin's tools and it worked — a `tool.result`
with `ok`, or an `effect.succeeded` for a gated tool the owner approved — the
attention stream (`/api/chat/attention/stream`) carries `pages.changed
{ plugin }`. A tool belongs to the plugin that registered it, or to the plugin
whose family prefixes its name (`finance.record_balance`), so a tool registered
for one run counts too; core tools and other plugins' tools say nothing. An
open `PluginPage` of that plugin asks every query again, half a second after
the last frame of a burst, keeping its last answer up meanwhile; a page that is
not mounted asks nothing. No plugin change is needed. Home's widgets do not go
through page queries and keep their own refresh.

## 6. What core keeps

The rail's core places, the settings' core sections, the Watchers page (a
core page fed by sentinels), Plugins, Home. A plugin adds beside them, never
inside them; `home` blocks and `views` remain the way into Home and the canvas.

## 7. The proof

1. **The engine is generic.** Core types, validation, the registry's
   `pages()`/`queries()`, the three gateway routes, `ownerOnly` tools, and the
   generic `PluginPage` with every component are exercised by a synthetic test
   plugin that uses each component once
   (`packages/core/src/pages/__fixtures__/demo.ts`, with its own DB tests and
   page tests).
2. **Email is a plugin like any other.** Its `queries` cover threads, thread,
   message, drafts, accounts, policies and watcher settings; its `ownerOnly`
   tools cover add/remove account, the owner's own rule, bulk policies and
   save/discard draft, thin over the plugin's store functions. Send and fetch
   are **not** among them: the page invokes the gated `email.send` and the
   `auto` `email.fetch_attachment`, because a page proposing a send is
   proposing exactly what an agent would. There is no `Mail.tsx`, no email
   route in the gateway, no `Mail` rail entry and no `email` settings section
   in core. The only email names in `packages/web` and
   `packages/gateway/src/web` are in tests of the generic engine that use
   email's descriptor as a fixture.
3. **The author's guide says so.** [plugins.md](plugins.md) §2.5a treats pages
   and settings as contributions; what a plugin cannot have is code in the
   page.

## 8. Guarantees

- The Mail page and Settings → Email are drawn from descriptors, with a URL
  per thread.
- `grep -ri email packages/web/src --exclude-dir=__fixtures__` finds nothing
  outside tests and the documented redirect table (`routes.ts`, which maps the
  hashes the owner's bookmarks and Telegram's links still carry) — plus
  `'email'` as a *field type* in the component set, which is a shape rather
  than a plugin.
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
    does not create such a role.
- The act route invokes only the tools a plugin's own pages name
  (`registry.pageTools`), at 60 writes a minute per session.
- `owner` and `room` are reserved agent ids, so nothing can become a second
  principal behind the id a page's writes are recorded under. An installation
  that already had an agent by one of those names still boots: the file is
  held back and shown on the Agents page, out of every roster, handle map,
  delegation list and default.
