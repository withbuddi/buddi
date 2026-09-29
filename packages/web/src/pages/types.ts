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
import type { ColumnMap, TileIcon, Tone, Unit, ValueRef } from '../canvas/types';

export type { ColumnMap, TileIcon, Tone, Unit, ValueRef };

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
  | 'cloud';

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
  /** A gated tool's sentence, drawn above its approval card while it waits. */
  pending?: string;
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
  /** The words for a value: a slug as the owner reads it. */
  labels?: Record<string, string>;
  /** A tone per value, over `tone`. */
  tones?: Record<string, Tone>;
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
  /** A select taking several choices; its value is an array, and `max` caps how many. */
  multiple?: boolean;
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
  /** A small icon button after a single select: a tool run with the form's unsaved values. */
  action?: FieldAction;
}

/** A field's own button: `args` as a submit's, or the form's active values when absent. */
export interface FieldAction {
  tool: string;
  label: string;
  icon?: 'play';
  args?: Record<string, ArgRef>;
}

/** A tool result's sound: base64 `audio/*`, played in the browser and never stored. */
export interface PagePlay {
  mime: string;
  data: string;
}

export interface ComponentCommon {
  when?: Visibility;
  title?: string;
  note?: string;
  empty?: string;
}

/** Where a calendar finds each event's parts: paths within one row. */
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

/** How tiles lie: wrapping, sharing the width, or scrolling sideways. */
export type TilesLayout = 'grid' | 'row' | 'strip';

/** One series of a two-kind chart; the bars' scale is 0–100 with `unit: 'percent'`. */
export interface ChartSeries {
  y: string;
  type: 'line' | 'bar';
  label: string;
  unit?: 'percent';
}

/** One tab of a `tabs`. */
export interface PageTab {
  id: string;
  label: string;
  body: Component[];
}

/** The choice at the left of a `tabs` bar, written into page parameter `param`. */
export interface TabsPick {
  param: string;
  label: string;
  options?: Array<{ value: string; label: string }>;
  optionsFrom?: OptionsFrom;
}

/** The tiles arm, named so its renderer can take it. */
export type TilesComponent = ComponentCommon & {
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
};

/** One series of a `series-panel`: a tab over the chart; `unit` says how it is written and scaled. */
export interface SeriesPanelSeries {
  id: string;
  label: string;
  y: string;
  unit?: 'percent' | 'temp' | 'speed';
  kind: 'area' | 'bars';
}

/** The strip under a `series-panel`'s chart, one tile per point. */
export interface SeriesPanelTiles {
  icon: { path: string } | { const: TileIcon };
  value: string;
  label: string;
  lines?: string[];
}

/** The series-panel arm, named so its renderer can take it. */
export type SeriesPanelComponent = ComponentCommon & {
  kind: 'series-panel';
  query: QueryRef;
  points: string;
  x: string;
  series: SeriesPanelSeries[];
  tiles: SeriesPanelTiles;
  labelEvery?: number;
};

/** The calendar arm, named so its renderer can take it. */
export type CalendarComponent = ComponentCommon & {
  kind: 'calendar';
  query: QueryRef;
  events: string;
  map: CalendarMap;
  views?: Array<'week' | 'month' | 'list'>;
  default?: 'week' | 'month' | 'list';
  hours?: [number, number];
};

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
  | (ComponentCommon & { kind: 'progress'; value: ValueRef; total?: ValueRef; label?: string | ValueRef; done?: string | ValueRef })
  /** A small chart of a query's rows; `rows` is left out when the answer is the array. */
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
      columns?: 2 | 3;
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
      poll?: { seconds: number; while: Visibility };
    })
  /** Dated events: week, month and list views; the page adds `from` and `to` to the query. */
  | CalendarComponent
  | TilesComponent
  | SeriesPanelComponent
  | (ComponentCommon & {
      kind: 'hero';
      query: QueryRef;
      icon: { path: string } | { const: TileIcon };
      value: string;
      title: string;
      facts: Array<{ label: string; path: string }>;
    })
  | (ComponentCommon & { kind: 'tabs'; tabs: PageTab[]; default?: string; pick?: TabsPick })
  | (ComponentCommon & { kind: 'expand'; query: QueryRef; label: string | ValueRef; body: Component[] })
  | (ComponentCommon & { kind: 'button'; action: ToolRef })
  | (ComponentCommon & { kind: 'approval'; path: string })
  /** One of the plugin's proposed agents: a line, and the gated accept. */
  | (ComponentCommon & { kind: 'agent-offer'; agent: string; text: string; label: string })
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
  /**
   * This plugin's queries marked sensitive. Every section that reads one is
   * masked until the owner asks, as Home masks a sensitive block.
   */
  sensitive?: string[];
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
