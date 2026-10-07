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
  | 'cloud'
  | 'news';

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

export type ArgRef = ValueRef | { param: string } | { field: string } | { row: string } | { selected: true } | { choice: true };

/** Another page of the same plugin, or — the one exception — an agent's chat. */
/** `{ proposals: true }`: the owner's Proposals inbox, filtered to the plugin drawing the page. */
/** `{ href }` (1.27): an https address read from the data, opened in a new tab. */
export type RouteRef = { page: string; item?: ValueRef; params?: Record<string, ValueRef> } | { chat: ValueRef } | { proposals: true } | { href: ValueRef };

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
  /** `{ field }` names a field of `form`. */
  args: Record<string, ValueRef | { row: string } | { field: string }>;
  /** Offered only on the rows where this holds. */
  when?: Visibility;
  /** The button opens a small sheet asking for these fields first. */
  form?: RowActionForm;
  /** 1.27: in the row's ⋯ menu; `hint` the line under it, `group` a heading above. */
  menu?: true;
  hint?: string;
  group?: string;
}

/** The small form a row action opens; `openWhen` opens it from the page's parameters. */
export interface RowActionForm {
  title: string;
  fields: Field[];
  submit: string;
  openWhen?: Record<string, string | { row: string }>;
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

/** A picture on a row (1.27): a key of the plugin's assets, and its words. */
export interface ImageRef {
  asset: ValueRef;
  label: ValueRef;
}

/** Pictures from an array in the row (1.27): paths within one element. */
export interface ImageList {
  from: string;
  asset: string;
  label: string;
}

export interface ListItem {
  title: ValueRef;
  sub?: ValueRef;
  meta?: ValueRef[];
  pill?: PillRef;
  pills?: PillRef[];
  to?: RouteRef;
  images?: ImageRef[] | ImageList;
  /** 1.27: one larger picture leading the row; a letter tile from `label` when missing. */
  logo?: ImageRef;
  /** 1.27: a short word after the title in small capitals ("FR"). */
  tag?: ValueRef;
  /** 1.27: one sentence under the row, in its tone. */
  status?: { text: ValueRef; tone?: Tone | ValueRef };
  /** 1.28: a path to a `#rrggbb` colour, a dot leading the row. */
  swatch?: string;
  /** 1.28: a segmented choice on the row's right. */
  choice?: RowChoice;
  /** 1.30: the title drawn heavier while this holds of the row (unread mail). */
  strong?: Visibility;
  /** 1.30: one faint line under the row, cut to one line. */
  preview?: ValueRef;
}

/** 1.30: one address on a message. */
export interface PageMessageAddress {
  name?: string | null;
  address: string;
}

/** 1.30: one file on a message; extra keys are what `fetch` reads. */
export interface PageMessageAttachment {
  name: string;
  size: number;
  mime: string;
  artifactId: string | null;
  contentId?: string | null;
  [key: string]: unknown;
}

/** 1.30: the data a `message` component draws. */
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

/** A row's segmented choice (1.28): `{ choice: true }` is the picked option's value. */
export interface RowChoice extends Omit<ToolRef, 'args' | 'confirm'> {
  value: string;
  options: RowChoiceOption[];
  args: Record<string, ValueRef | { row: string } | { choice: true }>;
}

/** One option of a row's choice. */
export interface RowChoiceOption {
  value: string;
  label: string;
  when?: Visibility;
  disabledWhen?: Visibility;
  hint?: string;
}

/** One item of a `menu` (1.28): a tool, or a drawer form's `id` to open. */
export interface MenuItem {
  label: string;
  hint?: string;
  when?: Visibility;
  action?: ToolRef;
  open?: string;
}

/** A repeat's poll; `finish` (1.28) runs a tool once for a row that satisfies `when`. */
export interface RepeatPoll {
  seconds: number;
  while: Visibility;
  finish?: { when: Visibility; action: Omit<ToolRef, 'args' | 'confirm'> & { args: Record<string, ValueRef | { row: string }> } };
}

export interface Selection {
  key: string;
  disabledWhen?: Visibility;
}

export interface GroupBy {
  key: string;
  labels?: Record<string, string>;
  /** 1.27: the group's words, read from its first row. */
  label?: string;
  /** 1.27: a quiet line beside the head, read from its first row. */
  aside?: string;
  /** 1.28: the aside's tone, read from the first row. */
  asideTone?: string;
  /** 1.28: actions on the group's head, read against its first row. */
  actions?: RowAction[];
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
  /** 1.28: only on this computer's browser (`local`) or anywhere else (`remote`). */
  where?: 'local' | 'remote';
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
  /** 1.27: chips that wrap (and scroll on a phone) instead of a segment. */
  look?: 'segment' | 'chips';
  /** 1.27: a quiet last chip that goes somewhere. */
  add?: { label: string; to: RouteRef };
}

/** One story, as a `stories` component reads it (1.27). */
export interface StoryRow {
  image?: import('./StoryImage').StoryPicture;
  id: string;
  title: string;
  /** Source labels supplied by the plugin for the text actually displayed. */
  titleAttribution?: string;
  summaryAttribution?: string;
  updateAttribution?: string;
  lead?: string;
  summary?: string;
  update?: string;
  url?: string;
  ago?: string;
  opinion?: boolean;
  languages?: string;
  mark?: { kind: 'told' | 'new'; text: string };
  quiet?: boolean;
  outlets: Array<{ id?: string; name: string; logo?: string }>;
  group?: { id: string; name: string };
  kicker?: string;
  meta?: string;
  sources?: Array<{ title: string; url?: string; outlet: string; logo?: string; meta?: string }>;
  timeline?: Array<{ at: string; text: string; told?: boolean }>;
}

/** One way out of a story (1.27): `{ row }` reads the story, `{ item }` the element of `each`. */
export interface StoryWay extends Omit<ToolRef, 'args'> {
  args: Record<string, ValueRef | { row: string } | { item: string }>;
  each?: string;
  hint?: string;
  group?: string;
  when?: Visibility;
  hides?: true;
  undo?: { tool: string; label: string; args: Record<string, ValueRef | { row: string } | { item: string }> };
}

/** A `stories` empty state (1.27). */
export interface StoriesEmpty {
  when: Visibility;
  title: string | ValueRef;
  text?: string | ValueRef;
  warm?: true;
  actions?: Array<{ label: string; to?: RouteRef; set?: Record<string, string> }>;
}

/** The stories arm (1.27), named so its renderer can take it. */
export type StoriesComponent = ComponentCommon & {
  kind: 'stories';
  query: QueryRef;
  rows: string;
  groups?: { param: string; label?: string };
  ways?: StoryWay[];
  ask?: { label: string; to: RouteRef; when?: Visibility; context?: { title: ValueRef; text: ValueRef; suggestions?: string[] } };
  edition?: { label: string; to: RouteRef; when?: Visibility };
  param?: string;
  emptyStates?: StoriesEmpty[];
};

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
  /** 1.28: "12 events" beside the range's name. */
  count?: true;
  /** 1.28: an event opens a sheet of its own. */
  sheet?: CalendarSheet;
};

/** What an event's sheet shows (1.28): paths within the event's row. */
export interface CalendarSheet {
  notes?: string;
  color?: string;
  mapHref?: string;
  open?: { label: string; href: string };
  asks?: Array<{ label: string; text: string }>;
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
export type SectionAction = Extract<Component, { kind: 'link' } | { kind: 'button' } | { kind: 'menu' }>;

export type Component =
  | (ComponentCommon & {
      kind: 'section';
      /** A compact, centered first-run card (host API 1.33). */
      look?: 'setup';
      actions?: SectionAction[];
      body: Component[];
      /** 1.30: the body is drawn against this query's answer. */
      query?: QueryRef;
      /** 1.30: the heading read from the data, in place of `title`. */
      heading?: ValueRef;
    })
  | (ComponentCommon & {
      kind: 'notice';
      text: string | ValueRef;
      tone?: Tone;
      look?: 'box' | 'quiet';
      icon?: 'globe' | 'clock' | 'alert';
      link?: { label: string | ValueRef; to: RouteRef; when?: Visibility };
      action?: ToolRef;
    })
  | (ComponentCommon & { kind: 'link'; label: string; to: RouteRef; tone?: 'accent' })
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
      drawer?: { title: string; button?: string; id?: string };
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
      poll?: RepeatPoll;
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
  | (ComponentCommon & { kind: 'tabs'; tabs: PageTab[]; default?: string; pick?: TabsPick; param?: string })
  | StoriesComponent
  | (ComponentCommon & { kind: 'expand'; query?: QueryRef; label: string | ValueRef; body: Component[] })
  | (ComponentCommon & { kind: 'button'; action: ToolRef })
  /** 1.28: one button opening a short menu of tools and drawers. */
  | (ComponentCommon & { kind: 'menu'; label: string; tone?: 'accent'; items: MenuItem[] })
  /** 1.33: a drawer over the page while the page parameter `param` is set. */
  | (ComponentCommon & { kind: 'sheet'; title: string; param: string; heading?: ValueRef; query?: QueryRef; body: Component[] })
  /** 1.33: a saved digest at `path`, drawn as chat's digest card. */
  | (ComponentCommon & { kind: 'digest'; path: string; emptyTitle?: string })
  | (ComponentCommon & { kind: 'approval'; path: string })
  /** One of the plugin's proposed agents: a line, and the gated accept. */
  | (ComponentCommon & { kind: 'agent-offer'; agent: string; text: string; label: string })
  | (ComponentCommon & { kind: 'artifact'; path: string; label: string })
  /** 1.30: one email, read — sanitised HTML or text, quotes folded, attachments as file rows. */
  | (ComponentCommon & { kind: 'message'; path?: string; query?: QueryRef; folded?: Visibility; fetch?: ToolRef })
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
  /**
   * 1.31: the values each of this plugin's queries marks sensitive, by query
   * name — paths into its answer, `[]` for every item. Drawn as a mask until
   * the owner presses Show amounts; the structure around them stays.
   */
  sensitivePaths?: Record<string, string[]>;
  id: string;
  title: string;
  place: 'rail' | 'settings';
  icon?: PageIcon;
  order?: number;
  data?: QueryRef;
  /** 1.27: the page head's right, links and buttons. */
  actions?: SectionAction[];
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
