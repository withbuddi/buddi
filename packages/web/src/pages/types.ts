/**
 * The plugin-page contract, browser side.
 *
 * This mirrors `packages/core/src/pages.ts`, for the same reason
 * `canvas/types.ts` mirrors `views.ts`: the contract crosses a process
 * boundary as JSON, and the page must not pull a Node package (pg, zod) into
 * the bundle to read it.
 *
 * The copy is not trusted to stay in step by hand: `types.conformance.ts`
 * asserts, at `tsc` time, that each declaration here and its counterpart in
 * core are mutually assignable, so a field added on one side and not the other
 * fails `pnpm -r typecheck` rather than a page at 7 a.m.
 *
 * Everything here is a *shape*. Nothing in this directory — types, components
 * or tests — is allowed to know the name of a plugin, a tool or a query.
 */
import type { ColumnMap, Tone, Unit, ValueRef } from '../canvas/types';

export type { ColumnMap, Tone, Unit, ValueRef };

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

/** A condition over the data: `equals` one value, or `in` a set, optionally `not`. */
export interface Visibility {
  path: string;
  equals?: unknown;
  in?: unknown[];
  not?: true;
}

export type ParamRef = ValueRef | { param: string } | { route: 'plugin' | 'page' | 'item' };

export interface QueryRef {
  query: string;
  params?: Record<string, ParamRef>;
}

export type ArgRef = ValueRef | { param: string } | { field: string } | { row: string } | { selected: true };

/** Another page of the same plugin, or — the one exception — an agent's chat. */
/** `{ proposals: true }`: the owner's Proposals inbox, filtered to the plugin drawing the page. */
export type RouteRef = { page: string; item?: ValueRef } | { chat: ValueRef } | { proposals: true };

export interface ToolRef {
  tool: string;
  label: string;
  args?: Record<string, ArgRef>;
  tone?: 'accent' | 'danger';
  /** `{count}` in it is replaced by the size of the selection. */
  confirm?: string;
  /** The label while it is running. */
  busy?: string;
  /** What the page says once it worked; a `ValueRef` reads the tool's result. */
  done?: string | ValueRef;
  /** Left of the toolbar, with a spacer after it. The primary stays rightmost. */
  placement?: 'leading';
  then?: 'refresh' | 'close' | { route: RouteRef };
}

export interface RowAction extends ToolRef {
  args: Record<string, ValueRef | { row: string }>;
  /** Offered only on the rows where this holds. */
  when?: Visibility;
}

export interface BulkAction extends ToolRef {
  args: Record<string, ValueRef | { selected: true }>;
  /** With nothing ticked, offer it on every row the owner may act on. */
  all?: true;
}

/** A word about state; `tone` may itself be a path within the row. */
export interface PillRef {
  value: ValueRef;
  tone?: Tone | ValueRef;
}

export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: PillRef;
  pills?: PillRef[];
  to?: RouteRef;
}

export interface Selection {
  key: string;
  disabledWhen?: Visibility;
}

export interface GroupBy {
  key: string;
  labels?: Record<string, string>;
}

/** A select's options, read from a query rather than written in the descriptor. */
export interface OptionsFrom {
  query: QueryRef;
  rows: string;
  value: string;
  label: string;
  /** Fields whose value is sent as a parameter, and whose change re-reads. */
  dependsOn?: string[];
}

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
  from?: string;
  optionsFrom?: OptionsFrom;
  /** Asked of the form's own values first, then of the data behind it. */
  when?: Visibility;
  disabledWhen?: Visibility;
}

export interface ComponentCommon {
  when?: Visibility;
  title?: string;
  note?: string;
  empty?: string;
}

export type ListComponent = ComponentCommon & {
  kind: 'list';
  query: QueryRef;
  rows: string;
  key?: string;
  item: ListItem;
  select?: Selection;
  actions?: RowAction[];
  bulk?: BulkAction[];
  groupBy?: GroupBy;
  collapsed?: { label: string; rows: string };
};

/** What a section may put on the right of its heading. */
export type SectionAction = Extract<Component, { kind: 'link' } | { kind: 'button' }>;

export type Component =
  | (ComponentCommon & { kind: 'section'; actions?: SectionAction[]; body: Component[] })
  | (ComponentCommon & { kind: 'notice'; text: string | ValueRef; tone?: Tone })
  | (ComponentCommon & { kind: 'link'; label: string; to: RouteRef })
  | (ComponentCommon & {
      kind: 'stats';
      query: QueryRef;
      items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }>;
    })
  | ListComponent
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
      drawer?: { title: string; button: string };
    })
  | (ComponentCommon & {
      kind: 'search';
      fields: Field[];
      query: QueryRef;
      rows: string;
      results: ListItem;
      to?: RouteRef;
      count?: string;
      note?: string;
      auto?: true;
      reset?: true;
    })
  | (ComponentCommon & {
      kind: 'list-detail';
      list: ListComponent;
      param: string;
      selection?: 'route' | 'local';
      detail: Component[];
    })
  | (ComponentCommon & { kind: 'repeat'; query: QueryRef; rows: string; key: string; body: Component[] })
  | (ComponentCommon & { kind: 'expand'; query: QueryRef; label: string | ValueRef; body: Component[] })
  | (ComponentCommon & { kind: 'button'; action: ToolRef })
  | (ComponentCommon & { kind: 'approval'; path: string })
  | (ComponentCommon & { kind: 'artifact'; path: string; label: string })
  | (ComponentCommon & {
      kind: 'editor';
      query: QueryRef;
      fields: Field[];
      save: ToolRef;
      actions?: ToolRef[];
      footnote?: string;
      readOnlyWhen?: Visibility;
      version: string;
    });

/** A descriptor as `GET /api/pages` serves it: the plugin, then the screen. */
export interface PluginPageDescriptor {
  plugin: string;
  id: string;
  title: string;
  place: 'rail' | 'settings';
  icon?: PageIcon;
  order?: number;
  data?: QueryRef;
  body: Component[];
}

/** What a write answered with: the tool's result, or an approval to decide. */
export interface PageActResult {
  result?: unknown;
  approvalId?: string;
  preview?: string;
}

/**
 * A plugin's per-agent directory, as `GET /api/pages` names it under `files`:
 * the page queries the canvas's Files tab reads it with.
 */
export interface WorkspaceFiles {
  workspace: string;
  list: string;
  stat: string;
  read: string;
  archive: string;
}

/** Served with the plugin that contributes it. */
export interface PluginWorkspaceFiles extends WorkspaceFiles {
  plugin: string;
}
