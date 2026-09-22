/**
 * The plugin-page contract, browser side.
 *
 * This mirrors `packages/core/src/pages.ts`, for the same reason
 * `canvas/types.ts` mirrors `views.ts`: the contract crosses a process
 * boundary as JSON, and the page must not pull a Node package (pg, zod) into
 * the bundle to read it. Two copies of a data-only contract is the cheap half
 * of that trade; if one changes, change both.
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

/** A descriptor as `GET /api/pages` serves it: the plugin, then the screen. */
export interface PluginPageDescriptor {
  plugin: string;
  id: string;
  title: string;
  place: 'rail' | 'settings';
  icon?: PageIcon;
  order?: number;
  body: Component[];
}

export type ParamRef = ValueRef | { param: string } | { route: 'plugin' | 'page' | 'item' };

export interface QueryRef {
  query: string;
  params?: Record<string, ParamRef>;
}

export type ArgRef = ValueRef | { param: string } | { field: string } | { row: string } | { selected: true };

export interface RouteRef {
  page: string;
  item?: ValueRef;
}

export interface ToolRef {
  tool: string;
  label: string;
  args?: Record<string, ArgRef>;
  tone?: 'accent' | 'danger';
  confirm?: string;
  then?: 'refresh' | 'close' | { route: RouteRef };
}

export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: { value: ValueRef; tone?: Tone };
  to?: RouteRef;
}

export interface Selection {
  key: string;
  disabledWhen?: { path: string; equals: unknown };
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
}

export interface ComponentCommon {
  when?: { path: string; equals: unknown };
  title?: string;
  note?: string;
  empty?: string;
}

export type ListComponent = ComponentCommon & {
  kind: 'list';
  query: QueryRef;
  rows: string;
  item: ListItem;
  select?: Selection;
  actions?: ToolRef[];
  bulk?: ToolRef[];
  groupBy?: { key: string; labels?: Record<string, string> };
  collapsed?: { label: string; rows: string };
};

export type Component =
  | (ComponentCommon & { kind: 'section'; body: Component[] })
  | (ComponentCommon & { kind: 'notice'; text: string; tone?: Tone })
  | (ComponentCommon & { kind: 'link'; label: string; to: RouteRef })
  | (ComponentCommon & {
      kind: 'stats';
      query: QueryRef;
      items: Array<{ label: string; value: ValueRef; unit?: Unit; tone?: Tone }>;
    })
  | ListComponent
  | (ComponentCommon & { kind: 'table'; query: QueryRef; rows: string; columns: ColumnMap[]; actions?: ToolRef[] })
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
  | (ComponentCommon & { kind: 'search'; fields: Field[]; query: QueryRef; results: ListItem; to?: RouteRef })
  | (ComponentCommon & { kind: 'list-detail'; list: ListComponent; param: string; detail: Component[] })
  | (ComponentCommon & { kind: 'expand'; query: QueryRef; label: string; body: Component[] })
  | (ComponentCommon & { kind: 'approval'; path: string })
  | (ComponentCommon & { kind: 'artifact'; path: string; label: string })
  | (ComponentCommon & {
      kind: 'editor';
      query: QueryRef;
      fields: Field[];
      save: ToolRef;
      actions?: ToolRef[];
      version: string;
    });

/** What a write answered with: the tool's result, or an approval to decide. */
export interface PageActResult {
  result?: unknown;
  approvalId?: string;
  preview?: string;
}
