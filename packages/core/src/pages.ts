/**
 * Plugin pages — a plugin's screens, as data.
 *
 * `docs/specs/plugin-pages.md`. A plugin already tells the dashboard how to
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
 * (`docs/specs/developer.md`).
 */
import type { Pool, PoolClient } from 'pg';
import { z, type ZodTypeAny } from 'zod';
import type { CoreToolContext, ToolContext } from './tools.js';
import type { PageFile as PluginPageFile } from './plugin/page-file.js';
import {
  columnMapSchema,
  toneSchema,
  unitSchema,
  valueRefSchema,
  viewPathSchema,
  type ColumnMap,
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
   */
  sensitive?: boolean;
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
  | 'globe';

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
 * is the list's current selection, as an array of its `key` values.
 */
export type ArgRef =
  | ValueRef
  | { param: string }
  | { field: string }
  | { row: string }
  | { selected: true };

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
 * (docs/specs/learning.md), filtered to *this* plugin's rules. A plugin that
 * proposes policies through core has its proposals there, not on its own
 * page, and the only useful thing its page can say about them is where they
 * are. It names no plugin: the dashboard fills in the one drawing the page.
 */
export type RouteRef = { page: string; item?: ValueRef } | { chat: ValueRef } | { proposals: true };

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
  args: Record<string, ValueRef | { row: string }>;
  /** Offered only on the rows where this holds: Fetch, until there is a file. */
  when?: Visibility;
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

/** One line of a list: what it says, and where it goes. */
export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: PillRef;
  /** Several, when one word is not the whole state of a row. */
  pills?: PillRef[];
  to?: RouteRef;
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
}

/** One control on a form, a search or an editor. */
export interface Field {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'secret' | 'email' | 'date';
  options?: Array<{ value: string; label: string }>;
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
}

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
}

/** What a section may put on the right of its heading: going, or doing. */
export type SectionAction = Extract<Component, { kind: 'link' } | { kind: 'button' }>;

export type Component =
  | (ComponentCommon & {
      kind: 'section';
      /** Right of the heading: a link away, or one button. Never a list of them. */
      actions?: SectionAction[];
      body: Component[];
    })
  /** A sentence. `text` may be a path, for something the data has to say. */
  | (ComponentCommon & { kind: 'notice'; text: string | ValueRef; tone?: Tone })
  | (ComponentCommon & { kind: 'link'; label: string; to: RouteRef })
  | (ComponentCommon & {
      kind: 'stats';
      query: QueryRef;
      items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }>;
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
      /** Behind a button, in a sheet, rather than open on the page. */
      drawer?: { title: string; button: string };
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
  | (ComponentCommon & { kind: 'repeat'; query: QueryRef; rows: string; key: string; body: Component[] })
  /** A fold. `label` may be a path, so a row's own words are on it. */
  | (ComponentCommon & { kind: 'expand'; query: QueryRef; label: string | ValueRef; body: Component[] })
  /**
   * One button, anywhere — including inside a `repeat`, where its `ValueRef`
   * arguments resolve against that row. What makes an attachment one block: a
   * Fetch button that gives way, under a `when`, to the `artifact` link for
   * the file it just produced.
   */
  | (ComponentCommon & { kind: 'button'; action: ToolRef })
  /** An approval id in the data; draws the ApprovalCard, choices and all. */
  | (ComponentCommon & { kind: 'approval'; path: string })
  /** An artifact id in the data; draws the download link. */
  | (ComponentCommon & { kind: 'artifact'; path: string; label: string })
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
    .object({ page: z.string().regex(PAGE_ID, 'a page id is lower-kebab-case'), item: valueRefSchema.optional() })
    .strict(),
  // An agent's chat. `chat` is a value read out of the data — an agent id the
  // query answered — never a page id and never a URL the descriptor wrote.
  z.object({ chat: valueRefSchema }).strict(),
  // The owner's Proposals inbox, filtered to this plugin. Names nothing.
  z.object({ proposals: z.literal(true) }).strict(),
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
const rowArgSchema = z.union([valueRefSchema, z.object({ row: viewPathSchema }).strict()]);
const bulkArgSchema = z.union([valueRefSchema, z.object({ selected: z.literal(true) }).strict()]);

const toolRefSchema = z.object({ ...toolRefCommon, args: z.record(fieldArgSchema).optional() }).strict();
const rowActionSchema = z
  .object({ ...toolRefCommon, args: z.record(rowArgSchema), when: visibilitySchema.optional() })
  .strict();
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

const listItemSchema = z
  .object({
    title: valueRefSchema,
    sub: valueRefSchema.optional(),
    meta: z.array(valueRefSchema).max(6).optional(),
    pill: pillSchema.optional(),
    pills: z.array(pillSchema).max(4).optional(),
    to: routeRefSchema.optional(),
  })
  .strict();

const fieldSchema = z
  .object({
    name: z.string().regex(PAGE_NAME, 'a field name is a name: letters, digits and underscores'),
    label,
    type: z.enum(['text', 'number', 'select', 'textarea', 'checkbox', 'secret', 'email', 'date']),
    options: z.array(z.object({ value: z.string(), label }).strict()).max(60).optional(),
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    hint: sentence.optional(),
    from: viewPathSchema.optional(),
    optionsFrom: z
      .object({
        query: queryRefSchema,
        rows: viewPathSchema,
        value: viewPathSchema,
        label: viewPathSchema,
        dependsOn: z.array(z.string().regex(PAGE_NAME, 'a field name is a name')).max(8).optional(),
      })
      .strict()
      .optional(),
    when: visibilitySchema.optional(),
    disabledWhen: visibilitySchema.optional(),
  })
  .strict()
  .refine(
    (field) =>
      field.type !== 'select' ||
      (field.options !== undefined && field.options.length > 0) ||
      field.optionsFrom !== undefined,
    'a select field needs `options` or `optionsFrom`',
  );

const common = {
  when: visibilitySchema.optional(),
  title: label.optional(),
  note: sentence.optional(),
  empty: sentence.optional(),
};

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
        actions: z
          .array(componentSchema)
          .max(4)
          .refine(
            (actions) => actions.every((a) => (a as Component).kind === 'link' || (a as Component).kind === 'button'),
            "a section's header actions are links and buttons, nothing else",
          )
          .optional(),
        body: z.array(componentSchema).max(24),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('notice'),
        text: z.union([sentence, valueRefSchema]),
        tone: toneSchema.optional(),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('link'), label, to: routeRefSchema }).strict(),
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
        groupBy: z.object({ key: viewPathSchema, labels: z.record(z.string()).optional() }).strict().optional(),
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
        drawer: z.object({ title: label, button: label }).strict().optional(),
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
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('expand'),
        query: queryRefSchema,
        label: z.union([label, valueRefSchema]),
        body: z.array(componentSchema).max(24),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('button'), action: toolRefSchema }).strict(),
    z.object({ ...common, kind: z.literal('approval'), path: viewPathSchema }).strict(),
    z.object({ ...common, kind: z.literal('artifact'), path: viewPathSchema, label }).strict(),
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
    icon: z.enum(['mail', 'money', 'calendar', 'people', 'file', 'chart', 'bell', 'plug', 'key', 'globe']).optional(),
    order: z.number().int().min(-999).max(999).optional(),
    data: queryRefSchema.optional(),
    body: z.array(componentSchema).min(1).max(24),
  })
  .strict();

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
  // `{ page, item? }` — a RouteRef.
  page: (parent) => Object.keys(parent).every((key) => key === 'page' || key === 'item'),
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
      throw new Error(`plugin ${plugin}: page query ${query.name} declares \`sensitive\` that is not true or false`);
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

  const contributed = new Set(opts.tools ?? []);
  const named = new Set<string>();
  for (const page of pages) {
    for (const ref of [...collectRefs(page.data, 'data'), ...collectRefs(page.body, 'body')]) {
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
 * is a Postgres role without the grant — see `docs/specs/plugin-pages.md` §8.
 *
 * The wrapper holds the client, takes one per statement and always gives it
 * back; `connect()` throws, so a query never sees one and cannot open a
 * transaction of its own.
 */
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
  return guarded as unknown as Pool;
}

/**
 * The context a query runs in: the caller's, with the read-only pool in place
 * of the real one and the owner's agent id stamped on it.
 */
export function pageQueryContext(ctx: CoreToolContext): CoreToolContext {
  return { ...ctx, db: readOnlyPool(ctx.db), agentId: OWNER_AGENT_ID };
}
