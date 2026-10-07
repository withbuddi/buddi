/**
 * Plugin pages — a plugin's screens, as data.
 *
 * `docs/plugin-pages.md`. A plugin already tells the dashboard how to
 * *draw a tool result* (`views.ts`); this tells it how to draw a whole screen:
 * a rail entry, or a settings tab, made of a small fixed set of generic
 * components. The rules are the ones views already follow, and they are the
 * reason this is worth having at all:
 *
 *  1. **Descriptors, not components.** A page is a tree of `Component`s, each
 *     bound to a plugin *query* for its data and to a plugin *tool* for its
 *     writes. It is serialised to JSON and handed to the browser. No plugin
 *     code runs in the page, and an installation without the plugin ships
 *     none of its screen.
 *  2. **Reads are queries, writes are tools.** A `PageQuery` is a read-only
 *     function the plugin exports — it is handed a `ToolContext` whose `db` is
 *     the read-only wrapper below, so "cannot write" is enforced rather than
 *     promised. A write is a tool call made as the owner: an `auto` tool
 *     executes, a `gated` one yields an approval the page draws in place.
 *     There is no third path, so everything the owner can do from a screen is
 *     something an agent could be granted, audited the same way.
 *  3. **Validated at the boundary.** Descriptors are parsed at `register()`,
 *     like views: a typo is a startup error naming the plugin, the page and
 *     the field path, rather than a blank panel nobody can explain.
 *  4. **Untrusted content stays text.** Everything a query returns is drawn as
 *     text nodes. No HTML, no markdown, no link except the ones a descriptor
 *     constructs from ids.
 *
 * The component set is sized by what email and finance need and does not grow
 * to fit one plugin's wish. A plugin that needs free layout, custom styling or
 * client-side logic serves its own app through the developer proxy
 * (`docs/developer.md`).
 */
import type { Pool, PoolClient } from 'pg';
import { z, type ZodTypeAny } from 'zod';
import type { CoreToolContext, ToolContext } from './tools.js';
import type { PageFile as PluginPageFile } from './plugin/page-file.js';
import {
  columnMapSchema,
  toneSchema,
  unitSchema,
  tileIconSchema,
  valueRefSchema,
  viewPathSchema,
  type ColumnMap,
  type TileIcon,
  type Tone,
  type Unit,
  type ValueRef,
} from './views.js';

/**
 * The agent id a write from a page is made under.
 *
 * Not a model and not a plugin: the owner, pressing a button on their own
 * dashboard. It is what the action ledger records, what a gated tool's
 * approval is asked of, and what `ownerOnly` checks.
 */
export const OWNER_AGENT_ID = 'owner';

/** A page id, and the `<page>` of its route. */
export const PAGE_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** A query name, as the descriptor and the query route spell it. */
export const PAGE_QUERY_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A field, a page parameter, a tool argument's key.
 *
 * Looser than a query name on purpose: these are the names of a *tool's*
 * arguments, and a tool's zod schema is written in this repository's own
 * camelCase (`everyMinutes`, `accountId`). Forcing snake_case here would make
 * every descriptor rename what it is about to send.
 */
export const PAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/**
 * A read a page makes.
 *
 * `produce` is handed a `ToolContext` whose `db` refuses anything that is not
 * a `select` (see `readOnlyPool`), so a query that tried to write fails loudly
 * on the statement rather than quietly succeeding.
 */
export interface PageQuery {
  /** 'threads', 'thread', 'accounts'. Unique within the plugin. */
  name: string;
  /** The parameters, validated before `produce` sees them; unknown keys are refused. */
  params: ZodTypeAny;
  /** Read, and only read. */
  produce(params: unknown, ctx: ToolContext): Promise<unknown>;
  /** Optional result shape; when given, the result is validated before it leaves. */
  result?: ZodTypeAny;
  /**
   * Balances, pay, anything the owner would not want read over a shoulder —
   * as a Home block's `sensitive`. The dashboard masks every section that
   * reads it until the owner asks, and masks it again when the window loses
   * focus; `buddi mcp` leaves its data out unless asked with
   * `includeSensitive`.
   *
   * Or, since host API 1.31, the values only: a list of paths into the
   * answer (`['netWorth', 'accounts[].balance']`, `[]` meaning every item of
   * an array). The page then draws its whole structure and masks just those
   * values — `••••` until the owner presses Show amounts — and `buddi mcp`
   * hands the answer over with those values replaced. Marked here rather than
   * on each component because one line then covers every place the value is
   * drawn (a stat, a list's meta, a table cell, a form), and the gateway can
   * redact the answer by the same paths without reading any layout.
   */
  sensitive?: boolean | string[];
}

/**
 * A path a query marks sensitive (host API 1.31): dotted field names, each
 * optionally followed by `[]` for "every item", or a leading `[]` when the
 * answer itself is a list. `total`, `accounts[].balance`, `[].amount`.
 */
export const SENSITIVE_PATH = /^(?:\[\]\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\])*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])*)*$/;

/** At most this many sensitive paths on one query. */
export const SENSITIVE_PATHS_MAX = 32;

type MaskStep = { key: string } | { each: true };

function maskSteps(path: string): MaskStep[] {
  const steps: MaskStep[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\])*)$/.exec(part);
    if (!match) continue;
    if (match[1]) steps.push({ key: match[1] });
    for (let i = 0; i < (match[2] ?? '').length / 2; i++) steps.push({ each: true });
  }
  return steps;
}

function maskAt(node: unknown, steps: MaskStep[], mask: unknown): unknown {
  if (node === undefined || node === null) return node;
  const [step, ...rest] = steps;
  if (step === undefined) return mask;
  if ('each' in step) return Array.isArray(node) ? node.map((item) => maskAt(item, rest, mask)) : node;
  if (typeof node !== 'object' || Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, step.key)) return node;
  return { ...(node as Record<string, unknown>), [step.key]: maskAt((node as Record<string, unknown>)[step.key], rest, mask) };
}

/**
 * A query's answer with every value at one of `paths` replaced by `mask`.
 * The answer itself is never changed: what is cloned is only the way down to
 * a masked value. An absent or null value stays as it is.
 */
export function maskSensitiveValues(data: unknown, paths: readonly string[], mask: unknown): unknown {
  let out = data;
  for (const path of paths) out = maskAt(out, maskSteps(path), mask);
  return out;
}

/** The icons the dashboard draws. A pinned set, never an arbitrary image. */
export type PageIcon =
  | 'mail'
  | 'money'
  | 'calendar'
  | 'people'
  | 'file'
  | 'chart'
  | 'bell'
  | 'plug'
  | 'key'
  | 'globe'
  | 'sun'
  | 'cloud'
  // Since host API 1.27: a folded newspaper.
  | 'news';

/** One screen: where it lives, and what is on it. */
export interface PageDescriptor {
  /** 'mail', 'settings' — unique in the plugin. */
  id: string;
  title: string;
  /** Where it lives. `rail` gives it a rail entry; `settings` a settings tab. */
  place: 'rail' | 'settings';
  /** One of a pinned set the dashboard draws; never an arbitrary image. */
  icon?: PageIcon;
  /** Rail order among plugin entries; core places are fixed. */
  order?: number;
  /**
   * One read for the page itself, resolved once. Its answer is the data the
   * top of `body` is drawn against — which is what makes a `when` outside any
   * component that fetched something mean anything at all.
   */
  data?: QueryRef;
  /**
   * The page head's right (since host API 1.27): up to three links or buttons,
   * drawn against `data` — the News page's Sources and Latest edition. The
   * last one carrying `tone: 'accent'` is the primary, rightmost. A rail page
   * only; a settings tab has no head of its own.
   */
  actions?: SectionAction[];
  body: Component[];
}

/* ------------------------------------------------------------------ *
 * The references a descriptor is made of
 * ------------------------------------------------------------------ */

/**
 * Where a query's parameter comes from: a literal or a path into the page's
 * own data (`ValueRef`), a named page parameter — the item of a list-detail,
 * a field of the search above it (`{ param }`) — or a part of the route
 * itself (`{ route }`).
 */
export type ParamRef = ValueRef | { param: string } | { route: 'plugin' | 'page' | 'item' };

/** A read, and what to ask it for. */
export interface QueryRef {
  /** A `queries` name this plugin contributes. */
  query: string;
  params?: Record<string, ParamRef>;
}

/**
 * Where a tool argument comes from. `{ field }` is a form or editor field on
 * the screen; `{ row }` is a field of the row an action sits on; `{ selected }`
 * is the list's current selection, as an array of its `key` values; `{
 * choice }` is the option a row's choice was just moved to (1.28).
 */
export type ArgRef =
  | ValueRef
  | { param: string }
  | { field: string }
  | { row: string }
  | { selected: true }
  | { choice: true };

/**
 * Where a link goes: another page of this same plugin, or one agent's chat.
 *
 * `{ page }` is the rule it has always been — never another plugin, never a
 * core screen. `{ chat }` is the one exception, and it is narrow on purpose:
 * it names an **agent id read out of the data**, and the dashboard turns it
 * into that agent's conversation. A goal belongs to the agent that holds it
 * and the only useful thing to do about one is to go and say so, which is a
 * sentence no page of the `goal` plugin can be. It is a *conversation*, not a
 * core page with state of its own: the widest thing a plugin can do with it is
 * open a chat the owner already has in their rail.
 *
 * `{ proposals: true }` is the second, as narrow: the owner's Proposals inbox
 * (docs/learning.md), filtered to *this* plugin's rules. A plugin that
 * proposes policies through core has its proposals there, not on its own
 * page, and the only useful thing its page can say about them is where they
 * are. It names no plugin: the dashboard fills in the one drawing the page.
 *
 * `{ href }` (since host API 1.27) is the one road out of buddi: an `https:`
 * address **read out of the data** — the article a story card is about —
 * opened in a new tab with `noopener noreferrer` and an outside-link mark.
 * A value that is not an absolute `https:` URL is no link at all. It is a
 * link the owner follows, never a request the dashboard makes: nothing is
 * fetched, previewed or embedded from it.
 */
export type RouteRef = { page: string; item?: ValueRef; params?: Record<string, ValueRef> } | { chat: ValueRef } | { proposals: true } | { href: ValueRef };

/** A write: a tool of this plugin, invoked as the owner. */
export interface ToolRef {
  /** A tool this plugin contributes. */
  tool: string;
  /** The button's words. */
  label: string;
  args?: Record<string, ArgRef>;
  tone?: 'accent' | 'danger';
  /**
   * One sentence the owner must confirm first. `{count}` in it is replaced by
   * the size of the selection, for a bulk action over many rows.
   */
  confirm?: string;
  /** The label while it is running: "Saving…", "Proposing…". */
  busy?: string;
  /**
   * What the page says once it has worked: "Saved.", or a `ValueRef` read out
   * of the tool's own result ("Queued for 9:00."). A gated tool says it after
   * the approval executed, because that is when it is true.
   */
  done?: string | ValueRef;
  /**
   * For a **gated** tool: one sentence drawn above its approval card while the
   * card waits — "Nothing has been sent. …". It says what the button did not
   * do yet; it is gone once the owner has decided.
   */
  pending?: string;
  /**
   * `leading` puts this action at the *left* of its toolbar, with a spacer
   * after it — Discard on the left, then Save, then Send on the right. The
   * primary action stays rightmost, which is the house rule.
   */
  placement?: 'leading';
  /**
   * What the page does after it succeeds. Refreshes its queries by default.
   * For a **gated** tool nothing has happened yet, so `then` is held and
   * applied only once the owner's approval has executed successfully.
   */
  then?: 'refresh' | 'close' | { route: RouteRef };
}

/**
 * A tool on one row: its arguments may read that row, and so may its words.
 *
 * `label` and `confirm` may carry `{fieldName}` placeholders, filled from the
 * row — "Remove {address}?" asks about the thing in front of the owner rather
 * than about "this account".
 */
export interface RowAction extends ToolRef {
  /** `{ field }` names a field of `form`, and only when there is one. */
  args: Record<string, ValueRef | { row: string } | { field: string }>;
  /** Offered only on the rows where this holds: Fetch, until there is a file. */
  when?: Visibility;
  /**
   * Ask for something first: the button opens a small sheet with these fields,
   * Cancel and `submit`, and the tool runs from there. A failure stays in the
   * sheet with its sentence; success closes it.
   */
  form?: RowActionForm;
  /**
   * In the row's ⋯ menu rather than on the row (since host API 1.27): the
   * ways out of a source — Mute, Remove — that would crowd it as buttons.
   * `hint` is the quiet line under the item; `group` a small heading above it.
   */
  menu?: true;
  hint?: string;
  group?: string;
}

/**
 * The small form a row action opens — Settings → Email's "Set password".
 *
 * `title` may carry `{fieldName}` placeholders, filled from the row.
 * `openWhen` opens it by itself on the row where every named page parameter
 * holds: a literal, or `{ row }` for that row's own field. With
 * `{ account: { row: 'id' }, set: 'password' }`, a link ending
 * `?account=<id>&set=password` lands with that row's form open.
 */
export interface RowActionForm {
  title: string;
  fields: Field[];
  /** The submit button's words: "Test and save". */
  submit: string;
  openWhen?: Record<string, string | { row: string }>;
}

/** A tool over a selection: its arguments may read it. */
export interface BulkAction extends ToolRef {
  args: Record<string, ValueRef | { selected: true }>;
  /**
   * With nothing ticked, offer it on **every** row the owner may act on —
   * "Keep all 12" — instead of a button that does nothing. `{count}` in the
   * label and the confirmation is that number.
   */
  all?: true;
}

/**
 * A small word about state, on a row.
 *
 * `tone` may itself be a path: a row that already carries `"critical"` says
 * so, and the descriptor does not have to enumerate every value a column can
 * hold in order to colour it.
 */
export interface PillRef {
  value: ValueRef;
  tone?: Tone | ValueRef;
  /** The words for a value: a state's slug as the owner reads it ("waiting-on-me" → "Waiting on you"). */
  labels?: Record<string, string>;
  /** A tone per value, over `tone`: the descriptor says which states catch the eye. */
  tones?: Record<string, Tone>;
}

/**
 * One small picture on a list row (since host API 1.27): a key of the
 * plugin's own `assets` (`ctx.buddi.assets.put`), read out of the row, and
 * the words it stands for. The dashboard draws the stored PNG from buddi,
 * never from anywhere else, and a letter tile from `label` when the key is
 * missing or the asset is gone.
 */
export interface ImageRef {
  asset: ValueRef;
  label: ValueRef;
}

/**
 * Pictures read from an array in the row (since host API 1.27): `from` is
 * the path to the array, `asset` and `label` paths within one element. The
 * first three are drawn overlapping, and the rest are counted in words
 * ("Reuters and 3 more").
 */
export interface ImageList {
  from: string;
  asset: string;
  label: string;
}

/** Up to this many fixed image slots on a list row. */
export const LIST_IMAGES_MAX = 4;

/** One line of a list: what it says, and where it goes. */
export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: PillRef;
  /** Several, when one word is not the whole state of a row. */
  pills?: PillRef[];
  to?: RouteRef;
  /**
   * Small pictures before the title, from the plugin's assets: up to four
   * fixed slots, or `{ from, asset, label }` over an array in the row. Since
   * host API 1.27; an older buddi refuses the descriptor.
   */
  images?: ImageRef[] | ImageList;
  /**
   * One picture leading the row, larger — an outlet's logo on a source row
   * (since host API 1.27). A letter tile from `label` when the key is missing.
   */
  logo?: ImageRef;
  /** A short word after the title, in small capitals: a language ("FR"). Since 1.27. */
  tag?: ValueRef;
  /**
   * One sentence under the row, in the tone it names: what is wrong with it
   * and since when ("Failing since Tue 08:00: …"). Nothing is drawn for an
   * empty value. Since 1.27.
   */
  status?: { text: ValueRef; tone?: Tone | ValueRef };
  /**
   * Path within the row to a `#rrggbb` colour, drawn as a small dot leading
   * the row — a calendar's own colour beside its name. A row whose value is
   * empty gets a hollow dot, so the names still line up; anything that is not
   * a plain hex colour is drawn as empty. Since 1.28.
   */
  swatch?: string;
  /**
   * One choice of two to four, drawn as a segment on the row's right: what
   * agents may do with a calendar — Not linked · Read · Read and change.
   * Since 1.28.
   */
  choice?: RowChoice;
  /**
   * The title drawn heavier while this holds of the row: a conversation with
   * mail the owner has not read yet. Since 1.30.
   */
  strong?: Visibility;
  /**
   * One faint line under the rest of the row, cut to one line: what a
   * message opens with. Since 1.30.
   */
  preview?: ValueRef;
}

/**
 * A row's segmented choice (since host API 1.28). The row's value at `value`
 * is the option drawn as chosen; picking another runs the tool with `{
 * choice: true }` as the picked option's value and `{ row }` reading the row,
 * then refreshes. The pick shows at once and goes back if the tool refuses.
 * `label` is the control's name for a screen reader, with `{field}`
 * placeholders read from the row ("What agents may do with {name}").
 */
export interface RowChoice extends Omit<ToolRef, 'args' | 'confirm'> {
  value: string;
  options: RowChoiceOption[];
  args: Record<string, ValueRef | { row: string } | { choice: true }>;
}

/** One option of a row's choice: left out where `when` does not hold, greyed where `disabledWhen` does, `hint` saying why. */
export interface RowChoiceOption {
  value: string;
  label: string;
  when?: Visibility;
  disabledWhen?: Visibility;
  hint?: string;
}

/**
 * One item of a `menu` (since host API 1.28): a tool, or `open`, the `id` of
 * a drawer form on the same page, which it opens in its sheet. `hint` is the
 * quiet line under the item's words.
 */
export interface MenuItem {
  label: string;
  hint?: string;
  when?: Visibility;
  action?: ToolRef;
  open?: string;
}

/**
 * Where a calendar finds each event's parts: paths within one row.
 *
 * `start` and `end` are ISO instants for a timed event, drawn in the owner's
 * zone, or `YYYY-MM-DD` dates for an all-day one (`end` the day after its
 * last, as in iCalendar). `allDay` says which when the row carries a flag;
 * `tone` a number, the calendar's index, picks one of four colours;
 * `calendar` names it for the screen reader and the row.
 */
export interface CalendarMap {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay?: string;
  calendar?: string;
  tone?: string;
  location?: string;
}

/**
 * How tiles lie: `grid` wraps as the canvas does, `row` shares the width
 * between all of them (a week, ten days), `strip` keeps each narrow and
 * scrolls sideways (the hours of a day).
 */
export type TilesLayout = 'grid' | 'row' | 'strip';

/**
 * One series of a two-kind chart: a line or bars, each on its own scale.
 * The line's scale is on the left and follows its values; the bars' is on the
 * right, from zero, and `unit: 'percent'` fixes it at 0–100 and writes `%`.
 */
export interface ChartSeries {
  y: string;
  type: 'line' | 'bar';
  label: string;
  unit?: 'percent';
}

/**
 * One series of a `series-panel`: a tab over the chart. `unit` says how its
 * values are written and scaled — `temp` fitted to the day's range with `°`,
 * `percent` 0–100 with `%`, `speed` from zero as a bare number.
 */
export interface SeriesPanelSeries {
  id: string;
  label: string;
  y: string;
  unit?: 'percent' | 'temp' | 'speed';
  kind: 'area' | 'bars';
}

/** The strip under a `series-panel`'s chart: one tile per point, paths read within the point. */
export interface SeriesPanelTiles {
  icon: { path: string } | { const: TileIcon };
  value: string;
  label: string;
  lines?: string[];
}

/** One tab of a `tabs`: its words, and what it shows. */
export interface PageTab {
  id: string;
  label: string;
  body: Component[];
}

/**
 * The choice at the left of a `tabs` bar — which place, which account —
 * written into the page parameter `param`, which any query below reads as
 * `{ param }`. The first option is chosen until the owner picks; with one
 * option or none there is no choice, and nothing is drawn.
 */
export interface TabsPick {
  param: string;
  /** The group's accessible name: "Place". */
  label: string;
  options?: Array<{ value: string; label: string }>;
  optionsFrom?: OptionsFrom;
  /**
   * `chips` (since host API 1.27) draws the choices as a row of chips that
   * wraps — and scrolls sideways on a phone — instead of a segment: for a
   * pick with many options, the News page's topics.
   */
  look?: 'segment' | 'chips';
  /** A quiet last chip that goes somewhere: "+ Topic" to the source manager. Chips only. */
  add?: { label: string; to: RouteRef };
}

/** Rows the owner may tick, and the ones they may not. */
export interface Selection {
  /** Path within a row to the value an action is given. */
  key: string;
  /** Rows the owner may not tick — and which a bulk action never receives. */
  disabledWhen?: Visibility;
}

/** Split a list into named groups by one field. */
export interface GroupBy {
  key: string;
  labels?: Record<string, string>;
  /**
   * Path within a row to the group's words, read from its first row, for
   * groups the descriptor cannot list (an owner's own topics). Since 1.27;
   * `labels` wins where it names the key.
   */
  label?: string;
  /** Path within a row to a quiet line beside the group's head ("6 sources"). Since 1.27. */
  aside?: string;
  /** Path within a row to the aside's tone, `warning` or `critical` ("Sign-in ran out"). Since 1.28. */
  asideTone?: string;
  /**
   * Actions on the group's head, at its right, read against the group's first
   * row: `{ row }` arguments, `when`, `confirm` and `menu` as a row's
   * (Sign in again; ⋯ Remove account…). Since 1.28.
   */
  actions?: RowAction[];
}

/** One control on a form, a search or an editor. */
export interface Field {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'secret' | 'email' | 'date';
  options?: Array<{ value: string; label: string }>;
  /**
   * A select that takes several choices: its value is an array of the
   * chosen options' values, empty meaning none. On a `select` only; `max`
   * caps how many it takes.
   */
  multiple?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** Path into the `initial` (form) or `query` (editor) result this starts from. */
  from?: string;
  /**
   * Where a select's options come from, when they are not a fixed list: a
   * query, read when the form opens and again whenever one of `dependsOn`
   * changes. That is how "the mailbox, then its conversations" is one form.
   */
  optionsFrom?: OptionsFrom;
  /**
   * Shown only while this holds — and it is asked of the form's *own values*
   * as much as of the data behind it: a path that names a field on this form
   * reads what the owner has just typed, so one control can reveal another
   * without a round trip. Everything else resolves against the loaded data.
   */
  when?: Visibility;
  /** Drawn, but not editable, on the same terms as `when`. */
  disabledWhen?: Visibility;
  /**
   * A small icon button right after a select, that runs a tool with the
   * form's **current, unsaved** values: Settings → Speech's play button
   * beside the voice. On a single `select` only. See `FieldAction`.
   */
  action?: FieldAction;
}

/**
 * A tool a field offers beside itself: try the choice before saving it.
 *
 * `args` are resolved as a form's submit's are — `{ field }` reads what is
 * on the form now, hidden and greyed fields left out — and when there are no
 * `args` the form's active values are sent as they stand. Nothing is
 * refreshed afterwards: the owner's unsaved choices stay where they are. A
 * result carrying `play` (`PagePlay`) is played in the browser; the button
 * spins while the tool runs and is a stop button while the sound plays.
 */
export interface FieldAction {
  /** A tool this plugin contributes. */
  tool: string;
  /** The button's accessible name and tooltip: "Play a sample". */
  label: string;
  /** The glyph it draws; `play` also means "this answers with a sound". */
  icon?: 'play';
  args?: Record<string, ArgRef>;
}

/**
 * The result convention for a sound: any page action — a button, a form's
 * submit, a field's action — whose tool answers `{ play: { mime, data } }`
 * has that audio played in the browser through one shared player, from a
 * blob URL, and nothing is stored. `data` is base64, at most
 * `PAGE_PLAY_MAX_BYTES` once decoded; `mime` an `audio/*` type. A `message`
 * beside it, when there is one, is shown as the action's sentence.
 */
export interface PagePlay {
  mime: string;
  /** Base64. */
  data: string;
}

/** The most audio a `play` result may carry, decoded. */
export const PAGE_PLAY_MAX_BYTES = 512 * 1024;

/** A select's options, read from a query rather than written in the descriptor. */
export interface OptionsFrom {
  query: QueryRef;
  /** Path to the array of rows in the answer. */
  rows: string;
  /** Path within a row to the value a choice submits… */
  value: string;
  /** …and to the words the owner reads. */
  label: string;
  /**
   * Field names whose current value is sent as a parameter of the same name,
   * and whose change re-reads the options. An empty one is left out.
   */
  dependsOn?: string[];
}

/**
 * A condition over the data, and the only logic a descriptor may carry.
 *
 * `equals` is one value, `in` is a set of them — "status is edited **or**
 * proposed" is one condition rather than one component per value — and `not`
 * inverts whichever was given. Exactly one of `equals` and `in` is required:
 * a bare path would have meant "show where this is undefined", which is a
 * sentence nobody meant to write.
 */
export interface Visibility {
  path: string;
  equals?: unknown;
  in?: unknown[];
  /** Invert the test. */
  not?: true;
}

/** What every component may carry. */
export interface ComponentCommon {
  /** Show this only while this holds of the data the component is drawn with. */
  when?: Visibility;
  title?: string;
  /** One line under the title. */
  note?: string;
  /** The sentence shown when there is nothing. */
  empty?: string;
  /**
   * Show this only where the dashboard is opened: `local`, a browser on the
   * computer buddi runs on (its address is 127.0.0.1, localhost or ::1), or
   * `remote`, anywhere else — over the tailnet, from a phone. What a sign-in's
   * pasted-address fallback needs: the loopback answer only reaches a browser
   * on this computer. Since 1.28.
   */
  where?: 'local' | 'remote';
}

/**
 * One story, as a `stories` component reads it (since host API 1.27). Every
 * value is text the plugin already formatted in the owner's words and zone;
 * logos are keys of the plugin's own assets.
 */
export interface StoryRow {
  image?: { key: string; caption?: string; credit?: string; outlet: string; url: string };
  id: string;
  title: string;
  /** Source labels supplied by the plugin for the text actually displayed. */
  titleAttribution?: string;
  summaryAttribution?: string;
  updateAttribution?: string;
  /** Two lines on the card: the update, when the story has one since it was told. */
  lead?: string;
  /** The sheet's paragraph; `lead` when left out. */
  summary?: string;
  /** What is new since it was told, in the sheet's accent box under `mark.text`. */
  update?: string;
  /** The best article, linked out from the sheet's title. */
  url?: string;
  /** "4 h ago". */
  ago?: string;
  opinion?: boolean;
  /** "EN · FR", "FR"; nothing for English alone. */
  languages?: string;
  /** `told`: a quiet check and the words; `new`: an accent dot and the words. */
  mark?: { kind: 'told' | 'new'; text: string };
  /** Told, and nothing since: the card is drawn quieter. */
  quiet?: boolean;
  outlets: Array<{ id?: string; name: string; logo?: string }>;
  group?: { id: string; name: string };
  /** The sheet's title line: the topic. */
  kicker?: string;
  /** The sheet's quiet line: "First seen 06:10 · 4 sources · told you this morning". */
  meta?: string;
  sources?: Array<{ title: string; url?: string; outlet: string; logo?: string; meta?: string }>;
  timeline?: Array<{ at: string; text: string; told?: boolean }>;
}

/**
 * One way out of a story (since host API 1.27): an item of its ⋯ menu.
 * `{ row }` arguments read the story, `{ item }` the element of `each`.
 */
export interface StoryWay extends Omit<ToolRef, 'args'> {
  args: Record<string, ValueRef | { row: string } | { item: string }>;
  /**
   * Once per element of this array in the row — "Mute Reuters", "Mute Le
   * Monde" — with `{field}` in `label` read from the element. Four at most.
   */
  each?: string;
  /** The quiet line under the item: "Back on its own next Saturday". */
  hint?: string;
  /** A small heading above the item, once per run of the same group: "Mute an outlet". */
  group?: string;
  when?: Visibility;
  /** It takes the story off the page: the card gives way to `done` and Undo for eight seconds. */
  hides?: true;
  /** What Undo calls, with the same arguments' kinds. */
  undo?: { tool: string; label: string; args: Record<string, ValueRef | { row: string } | { item: string }> };
}

/** A `stories` empty state: a title, a line, and a way on. */
export interface StoriesEmpty {
  when: Visibility;
  title: string | ValueRef;
  text?: string | ValueRef;
  /** The warm ground of a first time, rather than the plain one. */
  warm?: true;
  /** Each a link, or a page parameter set (`{ filter: 'all' }` — "Show all"). The last is the primary. */
  actions?: Array<{ label: string; to?: RouteRef; set?: Record<string, string> }>;
}

/**
 * A `repeat`'s poll: its query alone is asked again every `seconds` while
 * `while` holds of the answer. `finish` (since host API 1.28) is what makes a
 * card complete by itself: once a row of an answer satisfies `finish.when`,
 * `finish.action` is run once for that row — `{ row }` arguments read it —
 * its `busy` drawn in the card while it runs and its `done` after; then the
 * page does what its `then` says (refresh by default). A run that fails says
 * so in the card and is not tried again for that row.
 */
export interface RepeatPoll {
  seconds: number;
  while: Visibility;
  finish?: { when: Visibility; action: Omit<ToolRef, 'args' | 'confirm'> & { args: Record<string, ValueRef | { row: string }> } };
}

/**
 * What an event's sheet shows besides its title, its time and length and its
 * calendar (since host API 1.28); every path is read within the event's row.
 * `color` is the calendar's own `#rrggbb` beside its name; `mapHref` an
 * https address the place links out to; `open` a link out to the event where
 * it lives ("Open in Google Calendar"); `asks` buttons that open the corner
 * chat with a request written in — "Move or change {title}…" — since a change
 * goes through an agent and its approval card. `{field}` in an ask's `text`
 * reads the row; `{when}` is the event's day and time as the sheet shows it.
 */
export interface CalendarSheet {
  notes?: string;
  color?: string;
  mapHref?: string;
  open?: { label: string; href: string };
  asks?: Array<{ label: string; text: string }>;
}

/** One address on a message: the words the sender wrote, and the address. Since 1.30. */
export interface PageMessageAddress {
  name?: string | null;
  address: string;
}

/** One file on a message, as a `message` component draws it (since 1.30). */
export interface PageMessageAttachment {
  name: string;
  /** Bytes. */
  size: number;
  mime: string;
  /** The file in the owner's library once it is there; null while it is only listed. */
  artifactId: string | null;
  /** The part's Content-ID, without angle brackets: what a `cid:` image in the HTML names. */
  contentId?: string | null;
  /** Anything else the `fetch` button's arguments read (the message, the part's index). */
  [key: string]: unknown;
}

/**
 * The data a `message` component draws (since host API 1.30). `html` is the
 * body as the plugin stored it — the dashboard sanitises it again before a
 * single node is drawn, and never fetches a remote image until the owner asks
 * — `text` the plain body, drawn when there is no HTML. `at` is ISO 8601.
 * `note` is one sentence drawn in place of a body that is not there (purged
 * under retention); `snippet` is the folded line.
 */
export interface PageMessage {
  id?: string;
  from: PageMessageAddress;
  to?: PageMessageAddress[];
  cc?: PageMessageAddress[];
  at?: string | null;
  html?: string | null;
  text?: string | null;
  snippet?: string | null;
  note?: string | null;
  attachments?: PageMessageAttachment[];
}

/** What a section may put on the right of its heading: going, or doing. */
export type SectionAction = Extract<Component, { kind: 'link' } | { kind: 'button' } | { kind: 'menu' }>;

export type Component =
  | (ComponentCommon & {
      kind: 'section';
      /** A compact, centered first-run card (host API 1.33). */
      look?: 'setup';
      /** Right of the heading: a link away, or one button. Never a list of them. */
      actions?: SectionAction[];
      body: Component[];
      /**
       * Read this query and draw the body against its answer (since 1.30): the
       * parts of one conversation, inside a detail the route owns, read the
       * conversation rather than the page's own data.
       */
      query?: QueryRef;
      /** The heading read from the data, in place of `title`: a conversation's subject. Since 1.30. */
      heading?: ValueRef;
    })
  /**
   * A sentence. `text` may be a path, for something the data has to say.
   *
   * Since host API 1.27: `look: 'quiet'` draws it as one faint line with a
   * small glyph instead of a box — "Fetched at 10:00 from 31 sources · next
   * at 10:15" — and `link` ends it with a link ("2 aren't answering" →
   * Sources); `action` puts one button on its right ("Try now").
   */
  | (ComponentCommon & {
      kind: 'notice';
      text: string | ValueRef;
      tone?: Tone;
      look?: 'box' | 'quiet';
      icon?: 'globe' | 'clock' | 'alert';
      link?: { label: string | ValueRef; to: RouteRef; when?: Visibility };
      action?: ToolRef;
    })
  /** `tone: 'accent'` (1.27) draws it as the primary button where it heads a page or a section. */
  | (ComponentCommon & { kind: 'link'; label: string; to: RouteRef; tone?: 'accent' })
  /**
   * How far something has got: a bar. `value` is a number — a fraction 0–1
   * when there is no `total`, or a count of bytes against `total` (the line
   * under the bar reads "7 of 252 MB · 2%"). `label` is the line above the
   * bar; `done` is the line shown instead of the bar once `value` reaches
   * `total` (or 1). Inside a `repeat` with `poll`, a download moves.
   */
  | (ComponentCommon & {
      kind: 'progress';
      value: ValueRef;
      total?: ValueRef;
      label?: string | ValueRef;
      done?: string | ValueRef;
    })
  | (ComponentCommon & {
      kind: 'stats';
      query: QueryRef;
      items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }>;
    })
  /**
   * A small chart of a query's rows: a line (default) or bars. `x` and `y` are
   * paths within a row — `y` several paths for several series — and `rows`
   * the path to the array in the answer, left out when the answer is the
   * array. `target`, read from the answer, draws a dashed line across; `label`
   * names what `y` measures, for the axis and the summary a screen reader
   * hears. Drawn inline, in the page's own colours; a descriptor never says
   * how it looks.
   *
   * `series` in place of `y` and `type` draws a line and bars together, each
   * on its own scale — a day's temperature over its chance of rain — across
   * the width of the page.
   */
  | (ComponentCommon & {
      kind: 'chart';
      query: QueryRef;
      rows?: string;
      x: string;
      y?: string | string[];
      type?: 'line' | 'bar';
      series?: ChartSeries[];
      label?: string;
      target?: ValueRef;
    })
  | (ComponentCommon & {
      kind: 'list';
      query: QueryRef;
      /** Path to the array of rows in the query's result. */
      rows: string;
      /**
       * Path within a row to what makes it itself. Required unless `select`
       * gives one: a row keyed by its position collides across groups and
       * across the folded list, and the owner ticks the wrong thing.
       */
      key?: string;
      item: ListItem;
      select?: Selection;
      actions?: RowAction[];
      bulk?: BulkAction[];
      groupBy?: GroupBy;
      /** A second array, folded away behind one line. */
      collapsed?: { label: string; rows: string };
    })
  | (ComponentCommon & { kind: 'table'; query: QueryRef; rows: string; columns: ColumnMap[]; actions?: RowAction[] })
  | (ComponentCommon & {
      kind: 'detail';
      query: QueryRef;
      fields: Array<{ label: string; value: ValueRef; unit?: Unit }>;
      body: Component[];
    })
  | (ComponentCommon & {
      kind: 'form';
      fields: Field[];
      submit: ToolRef;
      initial?: QueryRef;
      /**
       * Behind a button, in a sheet, rather than open on the page. Since host
       * API 1.28 a drawer may have an `id` instead of (or as well as) its own
       * button: a `menu` item's `open` names it, and the page parameter
       * `open=<id>` opens it — so a link can too.
       */
      drawer?: { title: string; button?: string; id?: string };
      /**
       * Fields to a row on a wide panel: 2 (the default) or 3. The grid still
       * drops to two, then one, as the panel narrows.
       */
      columns?: 2 | 3;
    })
  | (ComponentCommon & {
      kind: 'search';
      fields: Field[];
      query: QueryRef;
      /** Path to the array of results in the query's answer. */
      rows: string;
      results: ListItem;
      /** Where a result goes when `results.to` does not say. */
      to?: RouteRef;
      /** Path to how many there are in all — a windowed answer says so. */
      count?: string;
      /** Path to one line about the answer: "the last 500, newest first". */
      note?: string;
      /** Ask again on every change, with no button. For a picker, not a search box. */
      auto?: true;
      /** Offer a Clear beside it: empties every field and asks again. */
      reset?: true;
    })
  | (ComponentCommon & {
      kind: 'list-detail';
      list: Extract<Component, { kind: 'list' }>;
      /** The page parameter the chosen item's id is bound to. */
      param: string;
      /**
       * `route` (the default) puts the chosen item in the URL, so it is a
       * thing the owner can link to. `local` keeps it in the page, for a
       * second level *inside* a detail that is already routed — two levels
       * cannot both own the one item segment.
       */
      selection?: 'route' | 'local';
      detail: Component[];
    })
  /**
   * The same sub-tree, once per row, with that row as its data.
   *
   * What makes a thread's messages (each an `expand` that fetches its own
   * body) and its drafts (each an `editor`) expressible at all: every
   * component inside is drawn against one row, so `artifact`, `approval` and
   * `when` all work per row.
   */
  | (ComponentCommon & {
      kind: 'repeat';
      query: QueryRef;
      rows: string;
      key: string;
      body: Component[];
      /**
       * Ask the query again every `seconds` while `while` holds of its answer,
       * and only this query: a download's progress line moves without the
       * page's forms being read again under the owner's hands.
       */
      poll?: RepeatPoll;
    })
  /**
   * Dated events as a calendar: a week of hours, a month of days, or a list
   * of days, behind a switch. `events` is the path to the array in the
   * query's answer and `map` where each event's parts are. The page adds
   * `from` and `to` to the query's parameters — `YYYY-MM-DD`, `to` the day
   * after the last one shown — and asks again, this query alone, as the owner
   * moves through the weeks; the query must take both. `hours` is the part of
   * the day a week shows without scrolling, 7 to 21 unless it says.
   */
  | (ComponentCommon & {
      kind: 'calendar';
      query: QueryRef;
      events: string;
      map: CalendarMap;
      views?: Array<'week' | 'month' | 'list'>;
      default?: 'week' | 'month' | 'list';
      hours?: [number, number];
      /** "12 events" beside the range's name in the bar (since host API 1.28). */
      count?: true;
      /** An event opens a sheet of its own instead of its day's list (since host API 1.28). */
      sheet?: CalendarSheet;
    })
  /**
   * A row of small cards, one per item — the canvas `tiles`, on a page: a
   * glyph, a value, a label on top and up to two small lines. `items` is the
   * path to the array in the query's answer; every other path is read within
   * one item, and `icon` may instead be one of the pinned glyphs as a
   * constant. `select` makes each card a button that writes the item's `key`
   * into the page parameter `param` — the day whose hours show below — and
   * marks the chosen one; the first is chosen until the owner picks.
   */
  | (ComponentCommon & {
      kind: 'tiles';
      query: QueryRef;
      items: string;
      icon: { path: string } | { const: TileIcon };
      value: string;
      label: string;
      lines?: string[];
      tone?: string;
      layout?: TilesLayout;
      select?: { param: string; key: string };
    })
  /**
   * A day in one panel: tabs across its `series`, the chosen one drawn as an
   * area (or bars) with its values written above every `labelEvery`-th point,
   * and under it the hourly strip of `tiles` drawn from the same `points` —
   * hovering or picking an hour marks it in both, and ←/→ move the pick.
   * `points` is the path to the array in the query's answer; `x` and every
   * series' `y` are read within one point.
   */
  | (ComponentCommon & {
      kind: 'series-panel';
      query: QueryRef;
      points: string;
      x: string;
      series: SeriesPanelSeries[];
      tiles: SeriesPanelTiles;
      labelEvery?: number;
    })
  /**
   * Now, large: one glyph, one big value and its word, and a few facts
   * beside — the head of a weather page, a balance and what moved it. Every
   * path is read in the query's answer; `icon` as a tile's.
   */
  | (ComponentCommon & {
      kind: 'hero';
      query: QueryRef;
      icon: { path: string } | { const: TileIcon };
      value: string;
      title: string;
      facts: Array<{ label: string; path: string }>;
    })
  /**
   * Views of one thing behind a switch at the right of a bar — Today, Week,
   * 10 days — each tab its own components, drawn only while it is chosen.
   * `pick`, when given, is a second switch at the left of the same bar. With
   * a pick, one tab is allowed (host API 1.22): the bar is then the pick
   * alone, a filter over one view.
   */
  | (ComponentCommon & {
      kind: 'tabs';
      tabs: PageTab[];
      default?: string;
      pick?: TabsPick;
      /**
       * Keep the chosen tab in this page parameter (since host API 1.27), so a
       * query below reads it as `{ param }` and an empty state's button can
       * move it ("Show all"). Without it the choice is the bar's own.
       */
      param?: string;
    })
  /**
   * A feed of stories, each from several sources (since host API 1.27): the
   * News page. Cards in a grid — the sources' logos and "Reuters and 3 more",
   * the age, a title, two lines, quiet marks (Opinion, EN · FR, "Told you ·
   * this morning" or "New since this morning") — under one head per group
   * with See all; a ⋯ menu of the ways out, each of which may hide the card
   * behind its sentence and Undo; and a sheet per story with its sources
   * linked out, how it moved, and the ways out again. Rows are `StoryRow`s.
   */
  | (ComponentCommon & {
      kind: 'stories';
      query: QueryRef;
      /** Path to the array of `StoryRow`s in the answer. */
      rows: string;
      /** Rows carry `group: { id, name }`: one head per group, and See all writes the id into `param`. */
      groups?: { param: string; label?: string };
      /** The ⋯ menu, in order; the first one that `hides` is also the sheet's left button. At most eight. */
      ways?: StoryWay[];
      /** The sheet's primary button, read against the story: Ask Anchor. */
      ask?: { label: string; to: RouteRef; when?: Visibility; context?: { title: ValueRef; text: ValueRef; suggestions?: string[] } };
      /** A link at the end of the sheet's quiet line, read against the story: "Read the edition". */
      edition?: { label: string; to: RouteRef; when?: Visibility };
      /** The page parameter the open story's id is kept in, so a story can be linked to. `story` when left out. */
      param?: string;
      /** What to say when there is no story, the first whose `when` holds of the answer; `empty` otherwise. */
      emptyStates?: StoriesEmpty[];
    })
  /**
   * One button that opens a short menu (since host API 1.28): Add a calendar
   * → Sign in with Google · Link with an app password · Paste a private
   * link. Each item runs a tool or opens a drawer form of the same page by
   * its `id`. It stands where a button does, a section's head included.
   */
  | (ComponentCommon & { kind: 'menu'; label: string; tone?: 'accent'; items: MenuItem[] })
  /** A fold. `label` may be a path, so a row's own words are on it. */
  | (ComponentCommon & { kind: 'expand'; query?: QueryRef; label: string | ValueRef; body: Component[] })
  /**
   * One button, anywhere — including inside a `repeat`, where its `ValueRef`
   * arguments resolve against that row. What makes an attachment one block: a
   * Fetch button that gives way, under a `when`, to the `artifact` link for
   * the file it just produced.
   */
  | (ComponentCommon & { kind: 'button'; action: ToolRef })
  /** An approval id in the data; draws the ApprovalCard, choices and all. */
  | (ComponentCommon & { kind: 'edition'; query: QueryRef; param: string })
  | (ComponentCommon & { kind: 'approval'; path: string })
  /** An artifact id in the data; draws the download link. */
  | (ComponentCommon & { kind: 'artifact'; path: string; label: string })
  /**
   * One email, read (since host API 1.30): who wrote it and when, To and Cc on
   * expand, and its body — sanitised HTML with remote images held back until
   * the owner shows them for that sender, or the plain text with its links —
   * with quoted earlier messages folded and the attachments as file rows. The
   * data is a `PageMessage`, at `path` or the data itself; with `query`, the
   * whole message is read from it when it is drawn open, and the row is only
   * the header. `folded` draws it as one line (who, when, how it opens) while
   * it holds of the row; opening it reads the query. `fetch` is the button on
   * an attachment that has no file yet, its arguments read against that
   * attachment.
   */
  | (ComponentCommon & {
      kind: 'message';
      path?: string;
      query?: QueryRef;
      folded?: Visibility;
      fetch?: ToolRef;
    })
  /**
   * An agent this plugin proposes (`manifest.agents`), offered where it is
   * needed: one line and one button. Accepting is the gated
   * `platform.accept_plugin_agent` the Plugins page's Accept runs, with the
   * approval card drawn in place — never a second road to an agent file.
   */
  | (ComponentCommon & { kind: 'agent-offer'; agent: string; text: string; label: string })
  | (ComponentCommon & {
      kind: 'editor';
      query: QueryRef;
      fields: Field[];
      save: ToolRef;
      actions?: ToolRef[];
      /** A line under the toolbar: what the buttons do, and do not do. */
      footnote?: string;
      /** Every field disabled and no buttons at all, while this holds. */
      readOnlyWhen?: Visibility;
      /**
       * Path to the version the save is made against — a stamp, not a clock.
       * The page offers it to `save` as the implicit field `version`, so a
       * descriptor writes `{ field: 'version' }` and the tool refuses a save
       * made against a version somebody else has already moved past.
       */
      version: string;
    });

/* ------------------------------------------------------------------ *
 * Validation
 *
 * The same argument as `views.ts`: a descriptor crosses a process boundary and
 * is then read by code that cannot check it, so it is checked where it enters
 * and where the plugin can still be named.
 * ------------------------------------------------------------------ */

const label = z.string().min(1).max(120);
const sentence = z.string().min(1).max(400);

const paramRefSchema = z.union([
  valueRefSchema,
  z.object({ param: z.string().regex(PAGE_NAME, 'a page parameter is a name') }).strict(),
  z.object({ route: z.enum(['plugin', 'page', 'item']) }).strict(),
]);

const queryRefSchema = z
  .object({
    query: z.string().regex(PAGE_QUERY_NAME, 'a query name is lower_snake_case'),
    params: z.record(paramRefSchema).optional(),
  })
  .strict();

const routeRefSchema = z.union([
  z
    .object({ page: z.string().regex(PAGE_ID, 'a page id is lower-kebab-case'), item: valueRefSchema.optional(), params: z.record(z.string().regex(PAGE_ID), valueRefSchema).optional() })
    .strict(),
  // An agent's chat. `chat` is a value read out of the data — an agent id the
  // query answered — never a page id and never a URL the descriptor wrote.
  z.object({ chat: valueRefSchema }).strict(),
  // The owner's Proposals inbox, filtered to this plugin. Names nothing.
  z.object({ proposals: z.literal(true) }).strict(),
  // An https address read out of the data (1.27): a link out, opened in a new tab.
  z.object({ href: valueRefSchema }).strict(),
]);

const TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The half of a tool reference that has nothing to do with where args come from. */
const visibilitySchema = z
  .object({
    path: viewPathSchema,
    equals: z.unknown(),
    in: z.array(z.unknown()).min(1).max(24).optional(),
    not: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => 'equals' in v || v.in !== undefined,
    'a condition needs `equals` or `in`: a path on its own is not a question',
  );

const toolRefCommon = {
  tool: z.string().regex(TOOL_NAME, 'a tool name is `plugin.tool`, lower case'),
  label,
  tone: z.enum(['accent', 'danger']).optional(),
  confirm: sentence.optional(),
  busy: label.optional(),
  done: z.union([sentence, valueRefSchema]).optional(),
  pending: sentence.optional(),
  placement: z.literal('leading').optional(),
  then: z.union([z.enum(['refresh', 'close']), z.object({ route: routeRefSchema }).strict()]).optional(),
};

const fieldArgSchema = z.union([
  valueRefSchema,
  z.object({ param: z.string().regex(PAGE_NAME, 'a page parameter is a name') }).strict(),
  z.object({ field: z.string().regex(PAGE_NAME, 'a field name is a name') }).strict(),
  z.object({ selected: z.literal(true) }).strict(),
]);
const rowArgSchema = z.union([
  valueRefSchema,
  z.object({ row: viewPathSchema }).strict(),
  z.object({ field: z.string().regex(PAGE_NAME, 'a field name is a name') }).strict(),
]);
const bulkArgSchema = z.union([valueRefSchema, z.object({ selected: z.literal(true) }).strict()]);

const toolRefSchema = z.object({ ...toolRefCommon, args: z.record(fieldArgSchema).optional() }).strict();
const rowActionSchema = z
  .object({
    ...toolRefCommon,
    args: z.record(rowArgSchema),
    when: visibilitySchema.optional(),
    form: z.lazy(() => rowFormSchema).optional(),
    menu: z.literal(true).optional(),
    hint: label.optional(),
    group: label.optional(),
  })
  .strict()
  .refine((action) => (action.hint === undefined && action.group === undefined) || action.menu === true, '`hint` and `group` are for an action in the ⋯ menu (`menu: true`)')
  .refine(
    (action) =>
      Object.values(action.args).every(
        (ref) => !('field' in ref) || (action.form?.fields ?? []).some((f) => f.name === ref.field),
      ),
    'a row action\'s `{ field }` argument names a field of its own `form`',
  );
const bulkActionSchema = z
  .object({ ...toolRefCommon, args: z.record(bulkArgSchema), all: z.literal(true).optional() })
  .strict();

const pillSchema = z
  .object({
    value: valueRefSchema,
    tone: z.union([toneSchema, valueRefSchema]).optional(),
    labels: z.record(label).optional(),
    tones: z.record(toneSchema).optional(),
  })
  .strict();

/** A tool reference that never asks first: a choice or a finish answers a pick, not a press. */
const { confirm: _confirm, ...toolRefNoConfirm } = toolRefCommon;

const choiceArgSchema = z.union([
  valueRefSchema,
  z.object({ row: viewPathSchema }).strict(),
  z.object({ choice: z.literal(true) }).strict(),
]);

/** A row's segmented choice (1.28): two to four options, the picked one's value sent as `{ choice: true }`. */
const rowChoiceSchema = z
  .object({
    ...toolRefNoConfirm,
    value: viewPathSchema,
    options: z
      .array(
        z
          .object({
            value: z.string().min(1).max(60),
            label: z.string().min(1).max(40),
            when: visibilitySchema.optional(),
            disabledWhen: visibilitySchema.optional(),
            hint: label.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(4)
      .refine((options) => new Set(options.map((o) => o.value)).size === options.length, 'each option of a choice has its own value'),
    args: z.record(choiceArgSchema),
  })
  .strict()
  .refine(
    (choice) => Object.values(choice.args).some((ref) => 'choice' in ref),
    'a choice sends what was picked: one of its arguments is `{ choice: true }`',
  );

const listItemSchema = z
  .object({
    title: valueRefSchema,
    sub: valueRefSchema.optional(),
    meta: z.array(valueRefSchema).max(6).optional(),
    pill: pillSchema.optional(),
    pills: z.array(pillSchema).max(4).optional(),
    to: routeRefSchema.optional(),
    images: z
      .union([
        z.array(z.object({ asset: valueRefSchema, label: valueRefSchema }).strict()).min(1).max(LIST_IMAGES_MAX),
        z.object({ from: viewPathSchema, asset: viewPathSchema, label: viewPathSchema }).strict(),
      ])
      .optional(),
    logo: z.object({ asset: valueRefSchema, label: valueRefSchema }).strict().optional(),
    tag: valueRefSchema.optional(),
    status: z.object({ text: valueRefSchema, tone: z.union([toneSchema, valueRefSchema]).optional() }).strict().optional(),
    swatch: viewPathSchema.optional(),
    choice: rowChoiceSchema.optional(),
    strong: visibilitySchema.optional(),
    preview: valueRefSchema.optional(),
  })
  .strict();

/** One item of a `menu` (1.28): a tool, or the id of a drawer form on the same page. */
const menuItemSchema = z
  .object({
    label,
    hint: label.optional(),
    when: visibilitySchema.optional(),
    action: toolRefSchema.optional(),
    open: z.string().regex(PAGE_ID, 'a drawer id is lower-kebab-case').optional(),
  })
  .strict()
  .refine((item) => (item.action === undefined) !== (item.open === undefined), 'a menu item runs a tool (`action`) or opens a drawer (`open`), one of the two');

/** A story way's argument: a literal or path, the story's own field, or the `each` element's. */
const storyArgSchema = z.union([
  valueRefSchema,
  z.object({ row: viewPathSchema }).strict(),
  z.object({ item: viewPathSchema }).strict(),
]);

const storyWaySchema = z
  .object({
    ...toolRefCommon,
    args: z.record(storyArgSchema),
    each: viewPathSchema.optional(),
    hint: label.optional(),
    group: label.optional(),
    when: visibilitySchema.optional(),
    hides: z.literal(true).optional(),
    undo: z
      .object({
        tool: z.string().regex(TOOL_NAME, 'a tool name is `plugin.tool`, lower case'),
        label,
        args: z.record(storyArgSchema),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((way) => way.undo === undefined || way.hides === true, 'an `undo` belongs to a way that `hides` the story')
  .refine(
    (way) => way.each !== undefined || Object.values(way.args).every((ref) => !('item' in ref)),
    'an `{ item }` argument reads the element of `each`, so the way needs one',
  );

const optionsFromSchema = z
  .object({
    query: queryRefSchema,
    rows: viewPathSchema,
    value: viewPathSchema,
    label: viewPathSchema,
    dependsOn: z.array(z.string().regex(PAGE_NAME, 'a field name is a name')).max(8).optional(),
  })
  .strict();

const fieldSchema = z
  .object({
    name: z.string().regex(PAGE_NAME, 'a field name is a name: letters, digits and underscores'),
    label,
    type: z.enum(['text', 'number', 'select', 'textarea', 'checkbox', 'secret', 'email', 'date']),
    options: z.array(z.object({ value: z.string(), label }).strict()).max(60).optional(),
    multiple: z.boolean().optional(),
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    hint: sentence.optional(),
    from: viewPathSchema.optional(),
    optionsFrom: optionsFromSchema.optional(),
    when: visibilitySchema.optional(),
    disabledWhen: visibilitySchema.optional(),
    action: z
      .object({
        tool: z.string().regex(TOOL_NAME, 'a tool name is `plugin.tool`, lower case'),
        label,
        icon: z.literal('play').optional(),
        args: z.record(fieldArgSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (field) => field.action === undefined || (field.type === 'select' && field.multiple !== true),
    'a field `action` sits beside a single select, and nothing else',
  )
  .refine(
    (field) =>
      field.type !== 'select' ||
      (field.options !== undefined && field.options.length > 0) ||
      field.optionsFrom !== undefined,
    'a select field needs `options` or `optionsFrom`',
  )
  .refine((field) => field.multiple !== true || field.type === 'select', '`multiple` is for a select field only');

const rowFormSchema = z
  .object({
    title: label,
    fields: z.array(fieldSchema).min(1).max(6),
    submit: label,
    openWhen: z
      .record(
        z.string().regex(PAGE_NAME, 'a page parameter is a name'),
        z.union([z.string().min(1).max(200), z.object({ row: viewPathSchema }).strict()]),
      )
      .refine((when) => Object.keys(when).length > 0 && Object.keys(when).length <= 4, '`openWhen` names one to four parameters')
      .optional(),
  })
  .strict();

const calendarViewSchema = z.enum(['week', 'month', 'list']);

/** A tile's or a hero's glyph: a path read at run time, or one of the pinned set now. */
const glyphRefSchema = z.union([z.object({ path: viewPathSchema }).strict(), z.object({ const: tileIconSchema }).strict()]);

const common = {
  when: visibilitySchema.optional(),
  title: label.optional(),
  note: sentence.optional(),
  empty: sentence.optional(),
  where: z.enum(['local', 'remote']).optional(),
};

/** What may stand at the right of a section's or a page's head. */
const HEAD_KINDS = new Set(['link', 'button', 'menu']);

/**
 * One component.
 *
 * `z.lazy` because the tree is recursive — a section holds components, a
 * list-detail holds a list and a detail — and a discriminated union on `kind`
 * because that is what makes the error name the *right* field: a bad `rows` on
 * a list is reported against the list, not as "no branch matched".
 */
export const componentSchema: z.ZodType<Component> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('section'),
        look: z.literal('setup').optional(),
        actions: z
          .array(componentSchema)
          .max(4)
          .refine(
            (actions) => actions.every((a) => HEAD_KINDS.has((a as Component).kind)),
            "a section's header actions are links, buttons and menus, nothing else",
          )
          .optional(),
        body: z.array(componentSchema).max(24),
        query: queryRefSchema.optional(),
        heading: valueRefSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('notice'),
        text: z.union([sentence, valueRefSchema]),
        tone: toneSchema.optional(),
        look: z.enum(['box', 'quiet']).optional(),
        icon: z.enum(['globe', 'clock', 'alert']).optional(),
        link: z
          .object({ label: z.union([label, valueRefSchema]), to: routeRefSchema, when: visibilitySchema.optional() })
          .strict()
          .optional(),
        action: toolRefSchema.optional(),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('link'), label, to: routeRefSchema, tone: z.literal('accent').optional() }).strict(),
    z
      .object({
        ...common,
        kind: z.literal('progress'),
        value: valueRefSchema,
        total: valueRefSchema.optional(),
        label: z.union([label, valueRefSchema]).optional(),
        done: z.union([sentence, valueRefSchema]).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('stats'),
        query: queryRefSchema,
        items: z
          .array(
            z
              .object({ label, value: valueRefSchema, unit: unitSchema.optional(), tone: toneSchema.optional() })
              .strict(),
          )
          .min(1)
          .max(12),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('chart'),
        query: queryRefSchema,
        rows: viewPathSchema.optional(),
        x: viewPathSchema,
        y: z.union([viewPathSchema, z.array(viewPathSchema).min(1).max(4)]).optional(),
        type: z.enum(['line', 'bar']).optional(),
        series: z
          .array(
            z
              .object({ y: viewPathSchema, type: z.enum(['line', 'bar']), label, unit: z.literal('percent').optional() })
              .strict(),
          )
          .min(1)
          .max(4)
          .optional(),
        label: label.optional(),
        target: valueRefSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('list'),
        query: queryRefSchema,
        rows: viewPathSchema,
        key: viewPathSchema.optional(),
        item: listItemSchema,
        select: z
          .object({ key: viewPathSchema, disabledWhen: visibilitySchema.optional() })
          .strict()
          .optional(),
        actions: z.array(rowActionSchema).max(6).optional(),
        bulk: z.array(bulkActionSchema).max(6).optional(),
        groupBy: z
          .object({
            key: viewPathSchema,
            labels: z.record(z.string()).optional(),
            label: viewPathSchema.optional(),
            aside: viewPathSchema.optional(),
            asideTone: viewPathSchema.optional(),
            actions: z.array(rowActionSchema).max(4).optional(),
          })
          .strict()
          .optional(),
        collapsed: z.object({ label, rows: viewPathSchema }).strict().optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('table'),
        query: queryRefSchema,
        rows: viewPathSchema,
        columns: z.array(columnMapSchema).min(1).max(24),
        actions: z.array(rowActionSchema).max(6).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('detail'),
        query: queryRefSchema,
        fields: z
          .array(z.object({ label, value: valueRefSchema, unit: unitSchema.optional() }).strict())
          .max(24),
        body: z.array(componentSchema).max(24),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('form'),
        fields: z.array(fieldSchema).min(1).max(24),
        submit: toolRefSchema,
        initial: queryRefSchema.optional(),
        drawer: z
          .object({ title: label, button: label.optional(), id: z.string().regex(PAGE_ID, 'a drawer id is lower-kebab-case').optional() })
          .strict()
          .refine((drawer) => drawer.button !== undefined || drawer.id !== undefined, 'a drawer opens from its own `button`, or from a menu by its `id`')
          .optional(),
        columns: z.union([z.literal(2), z.literal(3)]).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('search'),
        fields: z.array(fieldSchema).min(1).max(12),
        query: queryRefSchema,
        rows: viewPathSchema,
        results: listItemSchema,
        to: routeRefSchema.optional(),
        count: viewPathSchema.optional(),
        note: viewPathSchema.optional(),
        auto: z.literal(true).optional(),
        reset: z.literal(true).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('list-detail'),
        // Not `componentSchema`: the left half of a list-detail is a list, and
        // saying so here is what makes "list-detail.list.rows" the error.
        list: z.lazy(() => componentSchema).refine(
          (component) => (component as Component).kind === 'list',
          'the `list` of a list-detail must be a list component',
        ),
        param: z.string().regex(PAGE_NAME, 'a page parameter is a name'),
        selection: z.enum(['route', 'local']).optional(),
        detail: z.array(componentSchema).max(24),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('repeat'),
        query: queryRefSchema,
        rows: viewPathSchema,
        key: viewPathSchema,
        body: z.array(componentSchema).max(24),
        poll: z
          .object({
            seconds: z.number().int().min(1).max(60),
            while: visibilitySchema,
            finish: z
              .object({
                when: visibilitySchema,
                action: z
                  .object({
                    ...toolRefNoConfirm,
                    args: z.record(z.union([valueRefSchema, z.object({ row: viewPathSchema }).strict()])),
                  })
                  .strict(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('calendar'),
        query: queryRefSchema,
        events: viewPathSchema,
        map: z
          .object({
            id: viewPathSchema,
            title: viewPathSchema,
            start: viewPathSchema,
            end: viewPathSchema,
            allDay: viewPathSchema.optional(),
            calendar: viewPathSchema.optional(),
            tone: viewPathSchema.optional(),
            location: viewPathSchema.optional(),
          })
          .strict(),
        views: z
          .array(calendarViewSchema)
          .min(1)
          .max(3)
          .refine((views) => new Set(views).size === views.length, 'a calendar names each view once')
          .optional(),
        default: calendarViewSchema.optional(),
        hours: z
          .tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])
          .refine(([from, to]) => to - from >= 4, 'a calendar shows at least four hours: `hours` is [from, to], from before to')
          .optional(),
        count: z.literal(true).optional(),
        sheet: z
          .object({
            notes: viewPathSchema.optional(),
            color: viewPathSchema.optional(),
            mapHref: viewPathSchema.optional(),
            open: z.object({ label: viewPathSchema, href: viewPathSchema }).strict().optional(),
            asks: z.array(z.object({ label, text: sentence }).strict()).max(3).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('tiles'),
        query: queryRefSchema,
        items: viewPathSchema,
        icon: glyphRefSchema,
        value: viewPathSchema,
        label: viewPathSchema,
        lines: z.array(viewPathSchema).max(2).optional(),
        tone: viewPathSchema.optional(),
        layout: z.enum(['grid', 'row', 'strip']).optional(),
        select: z
          .object({ param: z.string().regex(PAGE_NAME, 'a page parameter is a name'), key: viewPathSchema })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('series-panel'),
        query: queryRefSchema,
        points: viewPathSchema,
        x: viewPathSchema,
        series: z
          .array(
            z
              .object({
                id: z.string().regex(PAGE_ID, 'a series id is lower-kebab-case'),
                label,
                y: viewPathSchema,
                unit: z.enum(['percent', 'temp', 'speed']).optional(),
                kind: z.enum(['area', 'bars']),
              })
              .strict(),
          )
          .min(1)
          .max(4)
          .refine((series) => new Set(series.map((s) => s.id)).size === series.length, 'each series has its own id'),
        tiles: z
          .object({
            icon: glyphRefSchema,
            value: viewPathSchema,
            label: viewPathSchema,
            lines: z.array(viewPathSchema).max(2).optional(),
          })
          .strict(),
        labelEvery: z.number().int().min(1).max(12).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('hero'),
        query: queryRefSchema,
        icon: glyphRefSchema,
        value: viewPathSchema,
        title: viewPathSchema,
        facts: z.array(z.object({ label, path: viewPathSchema }).strict()).max(8),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('tabs'),
        tabs: z
          .array(
            z
              .object({
                id: z.string().regex(PAGE_ID, 'a tab id is lower-kebab-case'),
                label,
                body: z.array(componentSchema).max(24),
              })
              .strict(),
          )
          .min(1)
          .max(6)
          .refine((tabs) => new Set(tabs.map((tab) => tab.id)).size === tabs.length, 'each tab has its own id'),
        default: z.string().regex(PAGE_ID).optional(),
        pick: z
          .object({
            param: z.string().regex(PAGE_NAME, 'a page parameter is a name'),
            label,
            options: z.array(z.object({ value: z.string().max(200), label }).strict()).min(1).max(12).optional(),
            optionsFrom: optionsFromSchema.optional(),
            look: z.enum(['segment', 'chips']).optional(),
            add: z.object({ label, to: routeRefSchema }).strict().optional(),
          })
          .strict()
          .refine(
            (pick) => (pick.options === undefined) !== (pick.optionsFrom === undefined),
            'a pick takes its choices from `options` or from `optionsFrom`, one of the two',
          )
          .refine((pick) => pick.add === undefined || pick.look === 'chips', 'a pick\'s `add` is the last of its chips: `look: \'chips\'`')
          .optional(),
        param: z.string().regex(PAGE_NAME, 'a page parameter is a name').optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('stories'),
        query: queryRefSchema,
        rows: viewPathSchema,
        groups: z
          .object({ param: z.string().regex(PAGE_NAME, 'a page parameter is a name'), label: label.optional() })
          .strict()
          .optional(),
        ways: z.array(storyWaySchema).max(8).optional(),
        ask: z.object({ label, to: routeRefSchema, when: visibilitySchema.optional(), context: z.object({ title: valueRefSchema, text: valueRefSchema, suggestions: z.array(z.string().min(1).max(200)).max(3).optional() }).strict().optional() }).strict().optional(),
        edition: z.object({ label, to: routeRefSchema, when: visibilitySchema.optional() }).strict().optional(),
        param: z.string().regex(PAGE_NAME, 'a page parameter is a name').optional(),
        emptyStates: z
          .array(
            z
              .object({
                when: visibilitySchema,
                title: z.union([label, valueRefSchema]),
                text: z.union([sentence, valueRefSchema]).optional(),
                warm: z.literal(true).optional(),
                actions: z
                  .array(
                    z
                      .object({
                        label,
                        to: routeRefSchema.optional(),
                        set: z.record(z.string().regex(PAGE_NAME, 'a page parameter is a name'), z.string().max(200)).optional(),
                      })
                      .strict()
                      .refine((a) => (a.to === undefined) !== (a.set === undefined), 'an empty state\'s action goes somewhere (`to`) or sets a parameter (`set`), one of the two'),
                  )
                  .max(3)
                  .optional(),
              })
              .strict(),
          )
          .max(6)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('expand'),
        query: queryRefSchema.optional(),
        label: z.union([label, valueRefSchema]),
        body: z.array(componentSchema).max(24),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('button'), action: toolRefSchema }).strict(),
    z
      .object({ ...common, kind: z.literal('menu'), label, tone: z.literal('accent').optional(), items: z.array(menuItemSchema).min(1).max(8) })
      .strict(),
    z.object({ ...common, kind: z.literal('edition'), query: queryRefSchema, param: z.string().regex(PAGE_ID) }).strict(),
    z.object({ ...common, kind: z.literal('approval'), path: viewPathSchema }).strict(),
    z.object({ ...common, kind: z.literal('artifact'), path: viewPathSchema, label }).strict(),
    z
      .object({
        ...common,
        kind: z.literal('message'),
        path: viewPathSchema.optional(),
        query: queryRefSchema.optional(),
        folded: visibilitySchema.optional(),
        fetch: toolRefSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('agent-offer'),
        agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'an agent id is kebab-case'),
        text: sentence,
        label,
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('editor'),
        query: queryRefSchema,
        fields: z.array(fieldSchema).min(1).max(24),
        save: toolRefSchema,
        actions: z.array(toolRefSchema).max(6).optional(),
        footnote: sentence.optional(),
        readOnlyWhen: visibilitySchema.optional(),
        version: viewPathSchema,
      })
      .strict(),
  ]),
) as z.ZodType<Component>;

export const pageDescriptorSchema = z
  .object({
    id: z.string().regex(PAGE_ID, 'a page id is lower-kebab-case'),
    title: label,
    place: z.enum(['rail', 'settings']),
    icon: z.enum(['mail', 'money', 'calendar', 'people', 'file', 'chart', 'bell', 'plug', 'key', 'globe', 'sun', 'cloud', 'news']).optional(),
    order: z.number().int().min(-999).max(999).optional(),
    data: queryRefSchema.optional(),
    actions: z
      .array(componentSchema)
      .max(3)
      .refine(
        (actions) => actions.every((a) => HEAD_KINDS.has((a as Component).kind)),
        "a page's head actions are links, buttons and menus, nothing else",
      )
      .optional(),
    body: z.array(componentSchema).min(1).max(24),
  })
  .strict()
  .refine((page) => page.actions === undefined || page.place === 'rail', 'head actions are for a rail page: a settings tab has no head of its own');

/* ------------------------------------------------------------------ *
 * The walk
 *
 * A descriptor is somebody else's object graph. It is walked twice — once for
 * its size and shape, once for the names it references — and both walks are
 * iterative and cycle-safe, because a plugin that hands over `a.b = a` must
 * fail load with a sentence rather than take the process down with a stack
 * overflow.
 * ------------------------------------------------------------------ */

/**
 * How big somebody else's descriptor may be before it is not a screen.
 *
 * `depth` counts **components inside components** — one per `body` level — and
 * nothing else. Counting every object and array as a level made the ordinary
 * one-block attachment shape (a list-detail holding a repeat holding an expand
 * holding a repeat holding a button whose argument is a path) land at thirteen
 * without a single surprising thing in it. A page can be twelve components
 * deep; the arrays and the small objects that hold them are not nesting.
 */
export const PAGE_LIMITS = { depth: 12, nodes: 400, bytes: 64 * 1024 } as const;

/**
 * Where a component may stand: the keys that hold one.
 *
 * Depth is about *screens inside screens*, so only a node that has a `kind`
 * **and** sits in one of these counts. A `{ kind: 'weird' }` the owner happens
 * to be comparing against in `when: { in: [...] }` is data that looks like a
 * component and must not make the page a level deeper.
 */
const COMPONENT_POSITIONS = new Set(['body', 'detail', 'list', 'action', 'actions', 'bulk']);

/**
 * …and where one may not: everything under these keys is values, however much
 * it looks like a tree.
 */
const NOT_COMPONENTS = new Set(['equals', 'in', 'args', 'params', 'labels', 'tones', 'options']);

/** Refuse a descriptor that is too deep, too big, or not a tree at all. */
function checkShape(raw: unknown, plugin: string, named: string): void {
  /*
   * Cycles are detected against the *ancestors* of the node being walked, not
   * against everything seen so far: a descriptor that uses the same object
   * literal in two places — the same toolbar action on two rows, one shared
   * `ListItem` — is reuse, which is fine and rather sensible. Only a node that
   * contains itself is a cycle. The node budget is what bounds the walk when
   * reuse makes the graph wider than the tree it prints as.
   */
  const ancestors = new Set<object>();
  let nodes = 0;
  type Step =
    | { enter: unknown; depth: number; at: string; data: boolean }
    | { leave: object };
  const stack: Step[] = [{ enter: raw, depth: 0, at: '(root)', data: false }];
  while (stack.length > 0) {
    const step = stack.pop() as Step;
    if ('leave' in step) {
      ancestors.delete(step.leave);
      continue;
    }
    const { enter: value, depth, at, data } = step;
    if (typeof value !== 'object' || value === null) continue;
    if (ancestors.has(value)) {
      throw new Error(`plugin ${plugin}: page descriptor ${named} contains itself; a descriptor is a tree`);
    }
    nodes += 1;
    if (nodes > PAGE_LIMITS.nodes) {
      throw new Error(`plugin ${plugin}: page descriptor ${named} has more than ${PAGE_LIMITS.nodes} nodes`);
    }
    /*
     * A component is a node with a `kind` standing where a component may
     * stand. Anything under a data key — the values a `when` compares
     * against, a tool's arguments, a group's labels — is data, and nothing
     * below it counts however deep it goes.
     */
    const isComponent =
      !data && typeof (value as { kind?: unknown }).kind === 'string' && COMPONENT_POSITIONS.has(at);
    const deeper = isComponent ? depth + 1 : depth;
    if (deeper > PAGE_LIMITS.depth) {
      throw new Error(`plugin ${plugin}: page descriptor ${named} nests components deeper than ${PAGE_LIMITS.depth}`);
    }
    ancestors.add(value);
    stack.push({ leave: value });
    if (Array.isArray(value)) {
      // An array stands where its key stands: `body[0]` is a `body` position.
      for (const child of value) stack.push({ enter: child, depth: deeper, at, data });
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      stack.push({ enter: child, depth: deeper, at: key, data: data || NOT_COMPONENTS.has(key) });
    }
  }
  const size = JSON.stringify(raw)?.length ?? 0;
  if (size > PAGE_LIMITS.bytes) {
    throw new Error(
      `plugin ${plugin}: page descriptor ${named} is ${size} bytes; a descriptor is a screen, not a document (${PAGE_LIMITS.bytes} max)`,
    );
  }
}

/**
 * Subtrees whose *keys* come from data rather than from the grammar.
 *
 * `groupBy.labels` is keyed by the values of a column, and `options` by
 * whatever a select offers. A plugin whose rows are grouped by a field whose
 * value is "page" must not fail to load with "links to Page, which is not a
 * page of this plugin".
 */
const DATA_KEYED = new Set(['labels', 'tones', 'options', 'args', 'params']);

/** The shapes a reference string is allowed to sit in. */
const REF_PARENT: Record<'query' | 'tool' | 'page', (parent: Record<string, unknown>) => boolean> = {
  // `{ query, params? }` — a QueryRef, and nothing else in the grammar.
  query: (parent) => Object.keys(parent).every((key) => key === 'query' || key === 'params'),
  // A ToolRef always carries the button's words.
  tool: (parent) => typeof parent.label === 'string',
  // `{ page, item?, params? }` — a RouteRef.
  page: (parent) => Object.keys(parent).every((key) => key === 'page' || key === 'item' || key === 'params'),
};

interface Ref {
  kind: 'query' | 'tool' | 'page';
  name: string;
  at: string;
}

/**
 * Every `{ query }`, `{ tool }` and `{ page }` in a tree, with where it was.
 *
 * Shape-aware rather than key-aware: a string under a key called `page` is a
 * route only when its parent looks like a route. See `DATA_KEYED`.
 */
function collectRefs(root: unknown, at: string): Ref[] {
  const refs: Ref[] = [];
  const stack: Array<{ value: unknown; at: string }> = [{ value: root, at }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, at: where } = stack.pop() as { value: unknown; at: string };
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => stack.push({ value: child, at: `${where}[${index}]` }));
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const kind of ['query', 'tool', 'page'] as const) {
      const name = record[kind];
      if (typeof name === 'string' && REF_PARENT[kind](record)) {
        refs.push({ kind, name, at: `${where}${where === '' ? '' : '.'}${kind}` });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (DATA_KEYED.has(key)) continue;
      stack.push({ value: child, at: `${where}${where === '' ? '' : '.'}${key}` });
    }
  }
  return refs;
}

/** Where a `list` says nothing about what makes a row itself. */
function unkeyedLists(root: unknown, at: string): string[] {
  const found: string[] = [];
  const stack: Array<{ value: unknown; at: string }> = [{ value: root, at }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, at: where } = stack.pop() as { value: unknown; at: string };
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => stack.push({ value: child, at: `${where}[${index}]` }));
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'list' && record.key === undefined && record.select === undefined) found.push(where);
    for (const [key, child] of Object.entries(record)) {
      if (DATA_KEYED.has(key)) continue;
      stack.push({ value: child, at: `${where}${where === '' ? '' : '.'}${key}` });
    }
  }
  return found;
}

/** Every `agent-offer` in a tree, with where it was. */
function agentOffers(root: unknown, at: string): Array<{ agent: string; at: string }> {
  const found: Array<{ agent: string; at: string }> = [];
  const stack: Array<{ value: unknown; at: string }> = [{ value: root, at }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, at: where } = stack.pop() as { value: unknown; at: string };
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => stack.push({ value: child, at: `${where}[${index}]` }));
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'agent-offer' && typeof record.agent === 'string') found.push({ agent: record.agent, at: where });
    for (const [key, child] of Object.entries(record)) {
      if (DATA_KEYED.has(key) || NOT_COMPONENTS.has(key)) continue;
      stack.push({ value: child, at: `${where}${where === '' ? '' : '.'}${key}` });
    }
  }
  return found;
}

/** Every `calendar` in a tree, with where it was. */
function calendarsIn(root: unknown, at: string): Array<{ component: Extract<Component, { kind: 'calendar' }>; at: string }> {
  const found: Array<{ component: Extract<Component, { kind: 'calendar' }>; at: string }> = [];
  const stack: Array<{ value: unknown; at: string }> = [{ value: root, at }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, at: where } = stack.pop() as { value: unknown; at: string };
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => stack.push({ value: child, at: `${where}[${index}]` }));
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'calendar') found.push({ component: record as unknown as Extract<Component, { kind: 'calendar' }>, at: where });
    for (const [key, child] of Object.entries(record)) {
      if (DATA_KEYED.has(key) || NOT_COMPONENTS.has(key)) continue;
      stack.push({ value: child, at: `${where}${where === '' ? '' : '.'}${key}` });
    }
  }
  return found;
}

/** Every component of one kind in a tree, with where it was. */
function componentsIn<K extends Component['kind']>(
  root: unknown,
  at: string,
  kind: K,
): Array<{ component: Extract<Component, { kind: K }>; at: string }> {
  const found: Array<{ component: Extract<Component, { kind: K }>; at: string }> = [];
  const stack: Array<{ value: unknown; at: string }> = [{ value: root, at }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, at: where } = stack.pop() as { value: unknown; at: string };
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => stack.push({ value: child, at: `${where}[${index}]` }));
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === kind) found.push({ component: record as unknown as Extract<Component, { kind: K }>, at: where });
    for (const [key, child] of Object.entries(record)) {
      if (DATA_KEYED.has(key) || NOT_COMPONENTS.has(key)) continue;
      stack.push({ value: child, at: `${where}${where === '' ? '' : '.'}${key}` });
    }
  }
  return found;
}

/** Is this a zod schema at all? Duck-typed: core does not own the plugin's zod. */
function isZodSchema(value: unknown): value is ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * A query's parameters, as the route will use them: an object schema that
 * refuses what it does not declare.
 *
 * Unknown keys are refused by the *framework*, not by each plugin remembering
 * `.strict()`. A plugin that wrote `z.object({...})` gets the strict version
 * of it; anything that is not an object schema is refused at load, because a
 * query string is a bag of named strings and nothing else can read one.
 */
function strictParams(query: PageQuery, plugin: string): ZodTypeAny {
  const params = query.params as unknown as {
    _def?: { typeName?: string; unknownKeys?: string };
    strict?: () => ZodTypeAny;
  };
  if (!isZodSchema(query.params) || params._def?.typeName !== 'ZodObject' || typeof params.strict !== 'function') {
    throw new Error(
      `plugin ${plugin}: page query ${query.name} must declare \`params\` as a zod object schema; ` +
        'a query string is a bag of named strings.',
    );
  }
  return params._def?.unknownKeys === 'strict' ? (query.params as ZodTypeAny) : params.strict();
}

/** What a manifest's pages and queries are, once they have been checked. */
export interface PageContributions {
  pages: PageDescriptor[];
  /**
   * The queries, with `params` made strict. These are what the route runs:
   * the plugin's own objects, never re-created.
   */
  queries: PageQuery[];
  /**
   * Every tool any of these pages names — and therefore the only tools the act
   * route will invoke for this plugin. A plugin's other tools are an agent's
   * business, not a button's.
   */
  tools: string[];
}

/**
 * Validate a manifest's pages and queries, or throw naming the plugin, the
 * page and the field.
 *
 * Beyond the shape, each of these is a rename that missed a file rather than a
 * typo the browser could survive:
 *
 *  - a query name a page uses must be one the same manifest contributes;
 *  - a tool a page writes through must be one the same manifest contributes;
 *  - a route a page links to must be a page of the same plugin.
 *
 * And each query is checked to be a query at all: `produce` a function,
 * `params` a zod object schema, `result` a zod schema when it is there. They
 * are called by the gateway with the owner's own context, so "it looked like a
 * query" is not a thing to find out at request time.
 */
export function parsePageContributions(opts: {
  plugin: string;
  pages?: readonly unknown[];
  queries?: readonly PageQuery[];
  tools?: readonly string[];
  /** The ids of the agents the same manifest proposes, for `agent-offer`. */
  agents?: readonly string[];
}): PageContributions {
  const { plugin } = opts;
  const queryNames = new Set<string>();
  const queries: PageQuery[] = [];
  for (const query of opts.queries ?? []) {
    if (typeof query?.name !== 'string' || !PAGE_QUERY_NAME.test(query.name)) {
      throw new Error(
        `plugin ${plugin}: invalid page query name "${String(query?.name)}" — lower_snake_case, up to 40 characters`,
      );
    }
    if (queryNames.has(query.name)) {
      throw new Error(`plugin ${plugin}: two page queries are called ${query.name}`);
    }
    if (typeof query.produce !== 'function') {
      throw new Error(`plugin ${plugin}: page query ${query.name} has no \`produce\` function`);
    }
    if (query.sensitive !== undefined && typeof query.sensitive !== 'boolean') {
      const paths: unknown = query.sensitive;
      if (!Array.isArray(paths)) {
        throw new Error(
          `plugin ${plugin}: page query ${query.name} declares \`sensitive\` that is not true, false or a list of paths`,
        );
      }
      if (paths.length === 0 || paths.length > SENSITIVE_PATHS_MAX) {
        throw new Error(
          `plugin ${plugin}: page query ${query.name} declares ${paths.length} sensitive paths — between 1 and ${SENSITIVE_PATHS_MAX}`,
        );
      }
      const seen = new Set<string>();
      for (const path of paths) {
        if (typeof path !== 'string' || path.length > 200 || !SENSITIVE_PATH.test(path)) {
          throw new Error(
            `plugin ${plugin}: page query ${query.name} marks "${String(path)}" sensitive — a path is dotted field names, ` +
              '`[]` for every item of a list (`accounts[].balance`)',
          );
        }
        if (seen.has(path)) throw new Error(`plugin ${plugin}: page query ${query.name} marks "${path}" sensitive twice`);
        seen.add(path);
      }
    }
    if (query.result !== undefined && !isZodSchema(query.result)) {
      throw new Error(`plugin ${plugin}: page query ${query.name} declares a \`result\` that is not a zod schema`);
    }
    queryNames.add(query.name);
    queries.push({ ...query, params: strictParams(query, plugin) });
  }

  const pages: PageDescriptor[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (opts.pages ?? []).entries()) {
    const named = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : `index ${index}`;
    checkShape(raw, plugin, named);
    const parsed = pageDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`plugin ${plugin}: invalid page descriptor ${named} — ${detail}`);
    }
    if (ids.has(parsed.data.id)) throw new Error(`plugin ${plugin}: two pages are called ${parsed.data.id}`);
    ids.add(parsed.data.id);
    pages.push(parsed.data as PageDescriptor);
  }

  /*
   * A row must be keyed by something in the row. Checked here rather than in
   * the schema because a `.refine` on one arm of a discriminated union is no
   * longer an object schema, and the union is what makes `body.0.rows` the
   * error instead of "no branch matched".
   */
  for (const page of pages) {
    for (const at of unkeyedLists(page.body, 'body')) {
      throw new Error(
        `plugin ${plugin}: page ${page.id}, ${at}: a list needs \`key\` (or a \`select.key\`) — ` +
          'a row keyed by its position collides across groups and across the folded rows',
      );
    }
  }

  /*
   * An offer names an agent the same manifest proposes. Anything else would be
   * a button that can only ever answer "no plugin proposes that".
   */
  const proposed = new Set(opts.agents ?? []);
  for (const page of pages) {
    for (const offer of agentOffers(page.body, 'body')) {
      if (!proposed.has(offer.agent)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${offer.at}: offers ${offer.agent}, which this plugin does not propose — ` +
            `it proposes ${proposed.size === 0 ? 'no agent' : [...proposed].join(', ')}`,
        );
      }
    }
  }

  /*
   * A calendar opens on one of the views it offers, and asks a query that
   * takes the range it shows: the page adds `from` and `to`, and a strict
   * schema that does not declare them refuses every week the owner opens.
   */
  const byName = new Map(queries.map((query) => [query.name, query]));
  for (const page of pages) {
    for (const { component, at } of calendarsIn(page.body, 'body')) {
      if (component.default !== undefined && component.views !== undefined && !component.views.includes(component.default)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${at}: opens on ${component.default}, which is not one of its views (${component.views.join(', ')})`,
        );
      }
      const query = byName.get(component.query.query);
      const shape = (query?.params as unknown as { shape?: Record<string, unknown> } | undefined)?.shape;
      if (query !== undefined && (shape === undefined || !('from' in shape) || !('to' in shape))) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${at}: the calendar's query ${query.name} must take \`from\` and \`to\` — ` +
            'the page asks it for the days it shows',
        );
      }
    }
  }

  /*
   * A chart says what it draws one way: `y` (and `type`), or `series`. A tab
   * bar opens on a tab it has. Checked here for the reason `key` is.
   */
  for (const page of pages) {
    for (const { component, at } of componentsIn(page.body, 'body', 'chart')) {
      if ((component.y === undefined) === (component.series === undefined)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${at}: a chart takes \`y\` or \`series\`, one of the two`,
        );
      }
      if (component.series !== undefined && component.type !== undefined) {
        throw new Error(`plugin ${plugin}: page ${page.id}, ${at}: with \`series\`, each series says its own type`);
      }
    }
    for (const { component, at } of componentsIn(page.body, 'body', 'tabs')) {
      // One tab is a bar with only its pick (since host API 1.22): a filter
      // over the one view. Without a pick, one tab is no choice at all.
      if (component.tabs.length < 2 && component.pick === undefined) {
        throw new Error(`plugin ${plugin}: page ${page.id}, ${at}: a tab bar has two tabs or more, or one tab and a pick`);
      }
      if (component.default !== undefined && !component.tabs.some((tab) => tab.id === component.default)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${at}: opens on ${component.default}, which is not one of its tabs (${component.tabs
            .map((tab) => tab.id)
            .join(', ')})`,
        );
      }
    }
  }

  /*
   * A menu item's `open` names a drawer form of the same page (1.28): one
   * that names nothing would be an item that does nothing. Two drawers by one
   * id would open together.
   */
  for (const page of pages) {
    const drawers = new Set<string>();
    const tree = [page.body, page.actions ?? []];
    for (const { component, at } of tree.flatMap((root) => componentsIn(root, 'body', 'form'))) {
      const id = component.drawer?.id;
      if (id === undefined) continue;
      if (drawers.has(id)) throw new Error(`plugin ${plugin}: page ${page.id}, ${at}: two drawers are called ${id}`);
      drawers.add(id);
    }
    for (const { component, at } of tree.flatMap((root) => componentsIn(root, 'body', 'menu'))) {
      for (const item of component.items) {
        if (item.open !== undefined && !drawers.has(item.open)) {
          throw new Error(
            `plugin ${plugin}: page ${page.id}, ${at}: "${item.label}" opens ${item.open}, which is no drawer on this page — ` +
              `it has ${drawers.size === 0 ? 'none' : [...drawers].join(', ')}`,
          );
        }
      }
    }
  }

  const contributed = new Set(opts.tools ?? []);
  const named = new Set<string>();
  for (const page of pages) {
    for (const ref of [...collectRefs(page.data, 'data'), ...collectRefs(page.body, 'body'), ...collectRefs(page.actions ?? [], 'actions')]) {
      if (ref.kind === 'query' && !queryNames.has(ref.name)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${ref.at}: no query called ${ref.name} — this plugin contributes ${
            queryNames.size === 0 ? 'none' : [...queryNames].join(', ')
          }`,
        );
      }
      if (ref.kind === 'tool') {
        if (opts.tools !== undefined && !contributed.has(ref.name)) {
          throw new Error(
            `plugin ${plugin}: page ${page.id}, ${ref.at}: names ${ref.name}, which this plugin does not contribute`,
          );
        }
        named.add(ref.name);
      }
      if (ref.kind === 'page' && !ids.has(ref.name)) {
        throw new Error(`plugin ${plugin}: page ${page.id}, ${ref.at}: links to ${ref.name}, which is not a page of this plugin`);
      }
    }
  }
  return { pages, queries, tools: [...named] };
}

/* ------------------------------------------------------------------ *
 * The read-only pool
 * ------------------------------------------------------------------ */

/*
 * `QueryRefusal`, `PageFile`, `pageFile` and `isPageFile` live in the plugin
 * entry point (`./plugin/page-file.ts`): they are pure, and a plugin needs them
 * without the rest of this file. Re-exported so every importer stays put.
 */
export { QueryRefusal, pageFile, isPageFile } from './plugin/page-file.js';
/** A query answering with bytes rather than data. See `./plugin/page-file.ts`. */
export type PageFile = PluginPageFile;

/**
 * A plugin that keeps a directory per agent names the page queries that read
 * it, and the chat's canvas draws a Files tab over them for any conversation
 * whose agent has one. The dashboard learns the names from `GET /api/pages`,
 * so it never names the plugin. Every one must be a query of the same plugin:
 *
 *  - `workspace` `{ agent }` → `{ workspace: { name, dir } | null }`;
 *  - `list` `{ agent, path? }` → one folder's entries;
 *  - `stat` `{ agent, path }` → one file's type, size and mtime;
 *  - `read` `{ agent, path, v?, download? }` → a `PageFile`;
 *  - `archive` `{ agent, path? }` → a `PageFile` (a zip), or a refusal naming its cap.
 */
export interface WorkspaceFiles {
  workspace: string;
  list: string;
  stat: string;
  read: string;
  archive: string;
}

/** A query tried to do something other than read. */
export class ReadOnlyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyRefusal';
  }
}

/**
 * The statement with its comments, string literals and quoted identifiers
 * blanked out, so the keywords that are left are keywords.
 *
 * A scanner rather than a pile of regular expressions: `'--'` inside a literal
 * is not a comment, and `--` before a quote does not start one.
 */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') { depth += 1; i += 2; continue; }
        if (sql.slice(i, i + 2) === '*/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      out += ' ';
      continue;
    }
    const ch = sql[i] as string;
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          // A doubled quote is an escaped one and the literal goes on.
          if (sql[i + 1] === ch) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (ch === '$') {
      // Dollar quoting: `$tag$ … $tag$`. Anything inside is a literal.
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        out += ' ';
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * `select … into` is `create table as` with a friendlier face, and `for
 * update` takes a lock. Both are refused by the read-only transaction below
 * as well; they are named here so the refusal is a sentence about pages
 * rather than a Postgres error code.
 */
const NOT_A_READ = /\binto\b|\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/i;

/**
 * A cheap pre-filter: does this statement even *look* like a read?
 *
 * It decides one thing — what the statement starts with — and refuses a second
 * statement smuggled in after a semicolon. It is **not** the enforcement, and
 * it deliberately no longer hunts for keywords anywhere else: `select comment
 * from t` is an ordinary read, and a lexical scan cannot tell whether
 * `select plugin.f()` writes. What decides that is Postgres, in
 * `readOnlyPool`.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const bare = stripSqlNoise(sql).trim().replace(/;+\s*$/, '');
  if (bare === '') return false;
  // A second statement would be a whole second thing to check, and the only
  // reason to send one through `query` is to smuggle it past the first.
  if (bare.includes(';')) return false;
  const opening = bare.replace(/^[\s(]+/, '');
  const first = /^([a-z_]+)/i.exec(opening)?.[1]?.toLowerCase();
  if (first !== 'select' && first !== 'with') return false;
  return !NOT_A_READ.test(bare);
}

/** How long one page query's statement may run before Postgres cancels it. */
export const PAGE_QUERY_TIMEOUT_MS = 5_000;

/**
 * How long a page query waits for a connection before giving up.
 *
 * A pool with nothing free is a busy installation, not a broken one, and the
 * honest answer is a sentence the owner can read — not a spinner that never
 * ends because `pool.connect()` waits for ever by default.
 */
export const PAGE_POOL_ACQUIRE_MS = 5_000;

/**
 * A client, or a refusal — never a wait without end.
 *
 * The loser of the race is not abandoned: if the pool hands a client over
 * after the deadline, it is released immediately, because a client nobody
 * holds is a connection the pool never gets back.
 */
async function connectWithin(pool: Pool, ms: number): Promise<PoolClient> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = pool.connect();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ReadOnlyRefusal(
                'a page query could not get a database connection in time; the installation is busy.',
              ),
            ),
          ms,
        );
      }),
    ]);
  } catch (err) {
    void pending.then(
      (late) => late.release(),
      () => {
        /* the pool itself failed; there is nothing to give back */
      },
    );
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The pool a `PageQuery` is handed: the real one, in a transaction that cannot
 * write.
 *
 * "A query cannot write" is the whole reason reads and writes are different
 * things here — the first plugin to run an `update` in a query would have
 * invented a write nobody approved, with no action, no preview and no ledger
 * row — so it is **Postgres** that enforces it, not a regular expression:
 * every statement runs inside
 *
 *     begin isolation level repeatable read read only;
 *     set local statement_timeout = '5s';
 *     <the statement>
 *     rollback;
 *
 * which refuses `insert`/`update`/`delete`/`copy … to`/`create`/`select …
 * into`/`nextval`/large-object writes **including inside a volatile function
 * the plugin wrote itself**, in Postgres's own words. The scanner above stays
 * as a pre-filter, so the common mistake is answered in this process; it is no
 * longer described as the boundary.
 *
 * Two things it does **not** cover, and they are honest limits rather than
 * bugs: a superuser-ish role can still call `pg_read_file` or
 * `pg_terminate_backend`, neither of which writes a row. The answer to those
 * is a Postgres role without the grant — see `docs/plugin-pages.md` §8.
 *
 * The wrapper holds the client, takes one per statement and always gives it
 * back; `connect()` throws, so a query never sees one and cannot open a
 * transaction of its own.
 */
const readOnlyPools = new WeakSet<object>();

/** Is this pool already `readOnlyPool`'s wrapper? */
export function isReadOnlyPool(pool: unknown): boolean {
  return typeof pool === 'object' && pool !== null && readOnlyPools.has(pool);
}

export function readOnlyPool(pool: Pool, opts: { acquireMs?: number } = {}): Pool {
  const acquireMs = opts.acquireMs ?? PAGE_POOL_ACQUIRE_MS;
  const run = async (config: unknown, values?: unknown): Promise<unknown> => {
    const text =
      typeof config === 'string'
        ? config
        : typeof (config as { text?: unknown } | null)?.text === 'string'
          ? (config as { text: string }).text
          : null;
    if (text === null || !isReadOnlyStatement(text)) {
      throw new ReadOnlyRefusal('a page query may only read: this statement is not a select.');
    }
    const client = await connectWithin(pool, acquireMs);
    try {
      await client.query('begin isolation level repeatable read read only');
      await client.query(`set local statement_timeout = ${PAGE_QUERY_TIMEOUT_MS}`);
      return await (client.query as (...args: unknown[]) => Promise<unknown>)(
        config,
        ...(values === undefined ? [] : [values]),
      );
    } finally {
      /*
       * Always, and whatever happened: the transaction only ever read, so
       * there is nothing to keep and nothing to lose by throwing it away.
       *
       * A `rollback` that *fails* means this connection is in a state nobody
       * here can describe — a broken socket, a server that went away
       * mid-statement — so it is released **with** the error, which is how
       * `pg` is told to destroy it rather than hand it to the next query
       * still inside a transaction.
       */
      try {
        await client.query('rollback');
        client.release();
      } catch (err) {
        client.release(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const guarded = {
    query(config: unknown, values?: unknown): unknown {
      // A refusal is a rejected promise, not a throw: `pool.query` is awaited
      // everywhere, and a caller that only catches rejections must not be able
      // to turn this into an unhandled defect.
      return run(config, typeof values === 'function' ? undefined : values);
    },
    connect(): never {
      throw new ReadOnlyRefusal(
        'a page query may only read: it is handed a pool, not a client — a transaction is a write.',
      );
    },
    end(): never {
      throw new ReadOnlyRefusal('a page query does not own the pool and may not end it.');
    },
    /** What is left of the pool's surface: facts, no statements. */
    get totalCount(): number {
      return pool.totalCount;
    },
    get idleCount(): number {
      return pool.idleCount;
    },
    get waitingCount(): number {
      return pool.waitingCount;
    },
    on(): unknown {
      return guarded;
    },
  };
  readOnlyPools.add(guarded);
  return guarded as unknown as Pool;
}

/**
 * The context a query runs in: the caller's, with the read-only pool in place
 * of the real one and the owner's agent id stamped on it.
 */
export function pageQueryContext(ctx: CoreToolContext): CoreToolContext {
  return { ...ctx, db: readOnlyPool(ctx.db), agentId: OWNER_AGENT_ID };
}
