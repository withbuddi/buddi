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
import type { Pool } from 'pg';
import { z, type ZodTypeAny } from 'zod';
import type { ToolContext } from './tools.js';
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

/** Somewhere else in the same plugin. Never another plugin, never a core page. */
export interface RouteRef {
  /** A page id of this plugin. */
  page: string;
  item?: ValueRef;
}

/** A write: a tool of this plugin, invoked as the owner. */
export interface ToolRef {
  /** A tool this plugin contributes. */
  tool: string;
  /** The button's words. */
  label: string;
  args?: Record<string, ArgRef>;
  tone?: 'accent' | 'danger';
  /** One sentence the owner must confirm first. */
  confirm?: string;
  /** What the page does after it succeeds. Refreshes its queries by default. */
  then?: 'refresh' | 'close' | { route: RouteRef };
}

/** A tool on one row: its arguments may read that row. */
export interface RowAction extends ToolRef {
  args: Record<string, ValueRef | { row: string }>;
}

/** A tool over a selection: its arguments may read it. */
export interface BulkAction extends ToolRef {
  args: Record<string, ValueRef | { selected: true }>;
}

/** One line of a list: what it says, and where it goes. */
export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: { value: ValueRef; tone?: Tone };
  to?: RouteRef;
}

/** Rows the owner may tick, and the ones they may not. */
export interface Selection {
  /** Path within a row to the value an action is given. */
  key: string;
  disabledWhen?: { path: string; equals: unknown };
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
}

/** Shown or hidden by what the page's own data says. */
export interface Visibility {
  path: string;
  equals: unknown;
}

/** What every component may carry. */
export interface ComponentCommon {
  /** Show this only when the data at `path` equals this value. */
  when?: Visibility;
  title?: string;
  /** One line under the title. */
  note?: string;
  /** The sentence shown when there is nothing. */
  empty?: string;
}

export type Component =
  | (ComponentCommon & { kind: 'section'; body: Component[] })
  | (ComponentCommon & { kind: 'notice'; text: string; tone?: Tone })
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
  | (ComponentCommon & { kind: 'search'; fields: Field[]; query: QueryRef; results: ListItem; to?: RouteRef })
  | (ComponentCommon & {
      kind: 'list-detail';
      list: Extract<Component, { kind: 'list' }>;
      /** The page parameter the chosen item's id is bound to. */
      param: string;
      detail: Component[];
    })
  | (ComponentCommon & { kind: 'expand'; query: QueryRef; label: string; body: Component[] })
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

const routeRefSchema = z
  .object({ page: z.string().regex(PAGE_ID, 'a page id is lower-kebab-case'), item: valueRefSchema.optional() })
  .strict();

const TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The half of a tool reference that has nothing to do with where args come from. */
const toolRefCommon = {
  tool: z.string().regex(TOOL_NAME, 'a tool name is `plugin.tool`, lower case'),
  label,
  tone: z.enum(['accent', 'danger']).optional(),
  confirm: sentence.optional(),
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
const rowActionSchema = z.object({ ...toolRefCommon, args: z.record(rowArgSchema) }).strict();
const bulkActionSchema = z.object({ ...toolRefCommon, args: z.record(bulkArgSchema) }).strict();

const listItemSchema = z
  .object({
    title: valueRefSchema,
    sub: valueRefSchema.optional(),
    meta: z.array(valueRefSchema).max(6).optional(),
    pill: z.object({ value: valueRefSchema, tone: toneSchema.optional() }).strict().optional(),
    to: routeRefSchema.optional(),
  })
  .strict();

const visibilitySchema = z.object({ path: viewPathSchema, equals: z.unknown() }).strict();

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
  })
  .strict()
  .refine(
    (field) => field.type !== 'select' || (field.options !== undefined && field.options.length > 0),
    'a select field needs `options`',
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
    z.object({ ...common, kind: z.literal('section'), body: z.array(componentSchema).max(24) }).strict(),
    z.object({ ...common, kind: z.literal('notice'), text: sentence, tone: toneSchema.optional() }).strict(),
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
        results: listItemSchema,
        to: routeRefSchema.optional(),
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
        detail: z.array(componentSchema).max(24),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('expand'),
        query: queryRefSchema,
        label,
        body: z.array(componentSchema).max(24),
      })
      .strict(),
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
    body: z.array(componentSchema).min(1).max(24),
  })
  .strict();

/** Every `{ query }`, `{ tool }` and `{ page }` in a tree, with where it was. */
function collectRefs(node: unknown, at: string, into: Array<{ kind: 'query' | 'tool' | 'page'; name: string; at: string }>): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectRefs(child, `${at}[${index}]`, into));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  // The three reference keys are unambiguous in this grammar: nothing else in
  // a descriptor is called `query`, `tool` or `page`.
  for (const key of ['query', 'tool', 'page'] as const) {
    if (typeof record[key] === 'string') {
      into.push({ kind: key, name: record[key] as string, at: `${at}${at === '' ? '' : '.'}${key}` });
    }
  }
  for (const [key, value] of Object.entries(record)) {
    collectRefs(value, `${at}${at === '' ? '' : '.'}${key}`, into);
  }
}

/**
 * Validate a manifest's pages and queries, or throw naming the plugin, the
 * page and the field.
 *
 * Three things are checked beyond the shape, and each one is a rename that
 * missed a file rather than a typo the browser could survive:
 *
 *  - a query name a page uses must be one the same manifest contributes;
 *  - a tool a page writes through must be one the same manifest contributes
 *    (the act route refuses any other name anyway, at run time, but a page
 *    that could never work should not install);
 *  - a route a page links to must be a page of the same plugin.
 */
export function parsePageContributions(opts: {
  plugin: string;
  pages?: readonly unknown[];
  queries?: readonly PageQuery[];
  tools?: readonly string[];
}): PageDescriptor[] {
  const { plugin } = opts;
  const queryNames = new Set<string>();
  for (const query of opts.queries ?? []) {
    if (!PAGE_QUERY_NAME.test(query.name)) {
      throw new Error(`plugin ${plugin}: invalid page query name "${query.name}" — lower_snake_case, up to 40 characters`);
    }
    if (queryNames.has(query.name)) {
      throw new Error(`plugin ${plugin}: two page queries are called ${query.name}`);
    }
    queryNames.add(query.name);
  }

  const pages: PageDescriptor[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (opts.pages ?? []).entries()) {
    const named = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : `index ${index}`;
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

  const tools = new Set(opts.tools ?? []);
  for (const page of pages) {
    const refs: Array<{ kind: 'query' | 'tool' | 'page'; name: string; at: string }> = [];
    collectRefs(page.body, 'body', refs);
    for (const ref of refs) {
      if (ref.kind === 'query' && !queryNames.has(ref.name)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${ref.at}: no query called ${ref.name} — this plugin contributes ${
            queryNames.size === 0 ? 'none' : [...queryNames].join(', ')
          }`,
        );
      }
      if (ref.kind === 'tool' && opts.tools !== undefined && !tools.has(ref.name)) {
        throw new Error(
          `plugin ${plugin}: page ${page.id}, ${ref.at}: names ${ref.name}, which this plugin does not contribute`,
        );
      }
      if (ref.kind === 'page' && !ids.has(ref.name)) {
        throw new Error(`plugin ${plugin}: page ${page.id}, ${ref.at}: links to ${ref.name}, which is not a page of this plugin`);
      }
    }
  }
  return pages;
}

/* ------------------------------------------------------------------ *
 * The read-only pool
 * ------------------------------------------------------------------ */

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

/** Everything a page query may not do, whatever the statement starts with. */
const FORBIDDEN_KEYWORD =
  /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do|lock|set|reset|comment|refresh|vacuum|cluster|reindex|notify|listen|unlisten|prepare|execute|begin|commit|rollback|savepoint|discard|security|nextval|setval|pg_sleep|pg_advisory|dblink)\b/i;

/** `select … for update` and its relatives: a lock is a write. */
const LOCKING_CLAUSE = /\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/i;

/**
 * Is this statement a read, and nothing else?
 *
 * The first keyword decides what it *is* — `select`, or a `with` whose body is
 * one — and the rest is checked for the ways a read stops being one: a
 * data-modifying CTE, a locking clause, a second statement after a semicolon.
 * Fail-closed: anything this cannot recognise is refused.
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
  if (FORBIDDEN_KEYWORD.test(bare)) return false;
  if (LOCKING_CLAUSE.test(bare)) return false;
  return true;
}

/**
 * The pool a `PageQuery` is handed: the real one, with a rule.
 *
 * "A query cannot write" is the whole reason reads and writes are different
 * things here, and a comment saying so would be worth nothing — the first
 * plugin to run an `update` in a query would have invented a write nobody
 * approved, with no action, no preview and no ledger row. So the statement is
 * read before it is sent, and anything that is not a `select` throws.
 *
 * Not a substitute for a read-only role in Postgres — a plugin's own pool can
 * still do as it likes — but this is the pool the *engine* hands out, and it
 * is the one a page's data comes through.
 */
export function readOnlyPool(pool: Pool): Pool {
  /**
   * A refusal is a rejected promise, not a throw: `pool.query` is awaited
   * everywhere, and a caller that only catches rejections must not be able to
   * turn this into an unhandled defect.
   */
  const refuse = (sql: string): Promise<never> =>
    Promise.reject(
      new ReadOnlyRefusal(
        `a page query may only read: this statement is not a select — ${sql.trim().slice(0, 120)}`,
      ),
    );
  const guarded = {
    query(config: unknown, values?: unknown, callback?: unknown): unknown {
      const text =
        typeof config === 'string'
          ? config
          : typeof (config as { text?: unknown } | null)?.text === 'string'
            ? ((config as { text: string }).text)
            : null;
      if (text === null || !isReadOnlyStatement(text)) return refuse(text ?? String(config));
      return (pool.query as (...args: unknown[]) => unknown)(config, values, callback);
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
export function pageQueryContext(ctx: ToolContext): ToolContext {
  return { ...ctx, db: readOnlyPool(ctx.db), agentId: OWNER_AGENT_ID };
}
