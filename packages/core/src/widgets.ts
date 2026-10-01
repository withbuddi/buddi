/**
 * Widgets: small live panels a plugin exports for the dashboard's Home.
 *
 * The glance card (`home.ts`, `card` on a glance) generalised. A widget is a
 * named, read-only function that answers a **body** from a small fixed
 * vocabulary — a figure, a few rows, a strip of tiles, a bar, a sentence —
 * with every value already formatted in the plugin's own units. The page owns
 * the frame (title, menu, stale and error states) and five renderers; it
 * draws no plugin HTML and knows no plugin by name. The owner picks which
 * widgets sit on Home, in which order and at which size.
 *
 * Three rules, the metric's (`metrics.ts`):
 *
 *  1. **It only reads.** `produce` is handed a context whose `db` is the
 *     read-only pool a page query runs in.
 *  2. **`null` is an answer**: nothing to show right now. The frame says so.
 *  3. **A broken widget is not a broken Home.** One that throws, times out or
 *     answers a body the page cannot draw shows its own error state (with the
 *     last good body when there is one) and nothing else is touched.
 */
import type { CoreToolContext, ToolContext } from './tools.js';
import { TILE_ICONS, type TileIcon } from './views.js';
import { HOME_CARD_LINE_MAX, HOME_CARD_TREND_MAX, HOME_CARD_VALUE_MAX, type HomeGlanceCard } from './home.js';

/** Small takes one column of Home's grid, medium two. One row height for both. */
export const WIDGET_SIZES = ['small', 'medium'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** The vocabulary. A new kind is a host API minor and a renderer in the page. */
export const WIDGET_BODY_KINDS = ['stat', 'list', 'strip', 'progress', 'text'] as const;
export type WidgetBodyKind = (typeof WIDGET_BODY_KINDS)[number];

/** How often a widget is produced again, at most and at least, and by default. */
export const WIDGET_REFRESH_MIN_S = 60;
export const WIDGET_REFRESH_MAX_S = 86_400;
export const WIDGET_REFRESH_DEFAULT_S = 600;

/** Lengths past which text is cut with an ellipsis, and how many of a thing are kept. */
export const WIDGET_TITLE_MAX = 40;
export const WIDGET_VALUE_MAX = HOME_CARD_VALUE_MAX;
export const WIDGET_LINE_MAX = HOME_CARD_LINE_MAX;
export const WIDGET_TEXT_MAX = 160;
export const WIDGET_TREND_MAX = HOME_CARD_TREND_MAX;
export const WIDGET_ROWS_MAX = 3;
export const WIDGET_ITEMS_MAX = 8;

/** A figure, a quiet line, a short run of numbers drawn as a sparkline, a foot. The weather card. */
export interface WidgetStat {
  kind: 'stat';
  icon?: TileIcon;
  /** Already formatted: "18°C", "3". At most `WIDGET_VALUE_MAX` characters. */
  value: string;
  caption?: string;
  /** Two to `WIDGET_TREND_MAX` finite numbers, in order; no axis is drawn. */
  trend?: { label?: string; points: number[] };
  foot?: string;
}

export interface WidgetListRow {
  title: string;
  sub?: string;
  /** The right-hand figure, already formatted: "20:00", "€42". */
  side?: string;
  tone?: 'good' | 'critical';
}

/** Up to `WIDGET_ROWS_MAX` rows (a small widget draws them without `sub`), and a foot. */
export interface WidgetList {
  kind: 'list';
  rows: WidgetListRow[];
  /** "2 more tomorrow". */
  more?: string;
}

export interface WidgetStripItem {
  /** "14:00", "Thu". */
  label: string;
  icon?: TileIcon;
  value: string;
}

/** A headline and a row of tiles: the next hours, the next days. Small draws four, medium six. */
export interface WidgetStrip {
  kind: 'strip';
  icon?: TileIcon;
  value?: string;
  caption?: string;
  items: WidgetStripItem[];
}

/** A figure and how far along it is: spent of a budget, done of a list. */
export interface WidgetProgress {
  kind: 'progress';
  value: string;
  caption?: string;
  /** 0 to 1; outside is clamped. */
  ratio: number;
  foot?: string;
  tone?: 'accent' | 'good' | 'warning' | 'critical';
}

/** A glyph and a sentence, for what has no number. */
export interface WidgetText {
  kind: 'text';
  icon?: TileIcon;
  /** At most `WIDGET_TEXT_MAX` characters. */
  text: string;
  sub?: string;
}

export type WidgetBody = WidgetStat | WidgetList | WidgetStrip | WidgetProgress | WidgetText;

/** What `produce` is told: the size the owner put it at, so a medium can say more. */
export interface WidgetRequest {
  size: WidgetSize;
}

export interface WidgetDefinition {
  /** `<plugin>.<name>`, stable: what the owner's layout remembers. */
  id: string;
  /** The frame's title and the gallery's name: "Weather at home". At most `WIDGET_TITLE_MAX`. */
  title: string;
  /** The sizes it can be drawn at; the first is where it starts. */
  sizes: WidgetSize[];
  /** Seconds between productions; clamped to 60–86400, ten minutes when left out. */
  refreshSeconds?: number;
  /** A page of the same plugin the body opens. */
  link?: { page: string };
  /** Hidden on screen until the owner asks, and never on a lock screen: a balance, not the weather. */
  sensitive?: boolean;
  /** The body for now, or null when there is nothing to show. Read-only. */
  produce(ctx: ToolContext, request: WidgetRequest): Promise<WidgetBody | null>;
}

/** A widget, the plugin that contributed it, and its refresh made concrete. */
export interface RegisteredWidget extends Omit<WidgetDefinition, 'produce'> {
  plugin: string;
  refreshSeconds: number;
  produce(ctx: CoreToolContext, request: WidgetRequest): Promise<WidgetBody | null>;
}

const WIDGET_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Check a manifest's widgets at register, the way pages and metrics are
 * checked: a bad declaration is a startup error naming the plugin, not an
 * empty frame on a Tuesday. Returns them with the refresh made concrete.
 */
export function parseWidgets(
  plugin: string,
  widgets: unknown,
  opts: { pages: readonly string[]; taken: (id: string) => boolean },
): Array<Omit<RegisteredWidget, 'produce'> & { produce: WidgetDefinition['produce'] }> {
  const fail = (message: string): never => {
    throw new Error(`plugin ${plugin}: ${message}`);
  };
  if (!Array.isArray(widgets)) fail('widgets must be an array');
  const seen = new Set<string>();
  return (widgets as unknown[]).map((raw, index) => {
    if (!raw || typeof raw !== 'object') return fail(`widgets[${index}] is not an object`);
    const w = raw as Record<string, unknown>;
    const id = typeof w.id === 'string' ? w.id : '';
    const [owner, name, ...rest] = id.split('.');
    if (owner !== plugin || !name || rest.length > 0 || !WIDGET_NAME.test(name)) {
      fail(`widget ${JSON.stringify(w.id)} must be named ${plugin}.<name> (lowercase letters, digits, _)`);
    }
    if (seen.has(id) || opts.taken(id)) fail(`widget ${id} is declared twice`);
    seen.add(id);
    const title = typeof w.title === 'string' ? w.title.trim() : '';
    if (title === '' || title.length > WIDGET_TITLE_MAX) fail(`widget ${id} needs a title of 1 to ${WIDGET_TITLE_MAX} characters`);
    const sizes = w.sizes;
    if (
      !Array.isArray(sizes) || sizes.length === 0 || new Set(sizes).size !== sizes.length ||
      !sizes.every((s) => (WIDGET_SIZES as readonly unknown[]).includes(s))
    ) {
      fail(`widget ${id}: sizes must list ${WIDGET_SIZES.join(' and/or ')}, each once`);
    }
    if (typeof w.produce !== 'function') fail(`widget ${id} needs a produce function`);
    const refresh = w.refreshSeconds;
    if (refresh !== undefined && (typeof refresh !== 'number' || !Number.isFinite(refresh))) {
      fail(`widget ${id}: refreshSeconds must be a number`);
    }
    const link = w.link as { page?: unknown } | undefined;
    if (link !== undefined && (typeof link?.page !== 'string' || !opts.pages.includes(link.page))) {
      fail(`widget ${id} links to ${JSON.stringify(link?.page)}, which is not a page of this plugin`);
    }
    if (w.sensitive !== undefined && typeof w.sensitive !== 'boolean') fail(`widget ${id}: sensitive must be true or false`);
    return {
      id,
      plugin,
      title,
      sizes: sizes as WidgetSize[],
      refreshSeconds: Math.min(WIDGET_REFRESH_MAX_S, Math.max(WIDGET_REFRESH_MIN_S, Math.round((refresh as number | undefined) ?? WIDGET_REFRESH_DEFAULT_S))),
      ...(link ? { link: { page: link.page as string } } : {}),
      ...(w.sensitive === true ? { sensitive: true } : {}),
      produce: w.produce as WidgetDefinition['produce'],
    };
  });
}

/* ------------------------------------------------------------------ *
 * Bodies, as the page may draw them
 * ------------------------------------------------------------------ */

const ICONS: ReadonlySet<string> = new Set(TILE_ICONS);

/** A line cut to `max` characters with an ellipsis; nothing for a blank or a non-string. */
export function cutLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A glyph from the pinned set; one outside it is left off rather than guessed at. */
function iconOf(value: unknown): { icon?: TileIcon } {
  return typeof value === 'string' && ICONS.has(value) ? { icon: value as TileIcon } : {};
}

function opt<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

const TONES_ROW = new Set(['good', 'critical']);
const TONES_BAR = new Set(['accent', 'good', 'warning', 'critical']);

/**
 * A plugin's body, as the page may draw it, or a reason it cannot be drawn.
 * Lines are cut to size, lists to their count, numbers checked; a body with
 * no figure, no rows or an unknown kind is refused rather than drawn wrong.
 */
export function widgetBodyOf(raw: unknown): { ok: true; body: WidgetBody } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the widget answered something that is not a body' };
  const b = raw as Record<string, unknown>;
  switch (b.kind) {
    case 'stat': {
      const value = cutLine(b.value, WIDGET_VALUE_MAX);
      if (!value) return { ok: false, reason: 'a stat needs a value' };
      const t = b.trend as { label?: unknown; points?: unknown } | undefined;
      const points = t && Array.isArray(t.points)
        ? t.points.slice(0, WIDGET_TREND_MAX).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : [];
      const label = t ? cutLine(t.label, WIDGET_LINE_MAX) : undefined;
      return {
        ok: true,
        body: {
          kind: 'stat', ...iconOf(b.icon), value,
          ...opt('caption', cutLine(b.caption, WIDGET_LINE_MAX)),
          ...(points.length >= 2 ? { trend: { ...opt('label', label), points } } : {}),
          ...opt('foot', cutLine(b.foot, WIDGET_LINE_MAX)),
        },
      };
    }
    case 'list': {
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .map((r): WidgetListRow | null => {
          if (!r || typeof r !== 'object') return null;
          const row = r as Record<string, unknown>;
          const title = cutLine(row.title, WIDGET_LINE_MAX);
          if (!title) return null;
          return {
            title,
            ...opt('sub', cutLine(row.sub, WIDGET_LINE_MAX)),
            ...opt('side', cutLine(row.side, WIDGET_VALUE_MAX)),
            ...(typeof row.tone === 'string' && TONES_ROW.has(row.tone) ? { tone: row.tone as 'good' | 'critical' } : {}),
          };
        })
        .filter((r): r is WidgetListRow => r !== null)
        .slice(0, WIDGET_ROWS_MAX);
      if (rows.length === 0) return { ok: false, reason: 'a list needs at least one row with a title' };
      return { ok: true, body: { kind: 'list', rows, ...opt('more', cutLine(b.more, WIDGET_LINE_MAX)) } };
    }
    case 'strip': {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map((i): WidgetStripItem | null => {
          if (!i || typeof i !== 'object') return null;
          const item = i as Record<string, unknown>;
          const label = cutLine(item.label, WIDGET_VALUE_MAX);
          const value = cutLine(item.value, WIDGET_VALUE_MAX);
          return label && value ? { label, ...iconOf(item.icon), value } : null;
        })
        .filter((i): i is WidgetStripItem => i !== null)
        .slice(0, WIDGET_ITEMS_MAX);
      if (items.length === 0) return { ok: false, reason: 'a strip needs at least one tile with a label and a value' };
      return {
        ok: true,
        body: {
          kind: 'strip', ...iconOf(b.icon),
          ...opt('value', cutLine(b.value, WIDGET_VALUE_MAX)),
          ...opt('caption', cutLine(b.caption, WIDGET_LINE_MAX)),
          items,
        },
      };
    }
    case 'progress': {
      const value = cutLine(b.value, WIDGET_VALUE_MAX);
      if (!value) return { ok: false, reason: 'a progress needs a value' };
      if (typeof b.ratio !== 'number' || !Number.isFinite(b.ratio)) return { ok: false, reason: 'a progress needs a ratio between 0 and 1' };
      return {
        ok: true,
        body: {
          kind: 'progress', value,
          ...opt('caption', cutLine(b.caption, WIDGET_LINE_MAX)),
          ratio: Math.min(1, Math.max(0, b.ratio)),
          ...opt('foot', cutLine(b.foot, WIDGET_LINE_MAX)),
          ...(typeof b.tone === 'string' && TONES_BAR.has(b.tone) ? { tone: b.tone as WidgetProgress['tone'] & string } : {}),
        },
      };
    }
    case 'text': {
      const text = cutLine(b.text, WIDGET_TEXT_MAX);
      if (!text) return { ok: false, reason: 'a text needs text' };
      return { ok: true, body: { kind: 'text', ...iconOf(b.icon), text, ...opt('sub', cutLine(b.sub, WIDGET_LINE_MAX)) } };
    }
    default:
      return { ok: false, reason: `the page draws ${WIDGET_BODY_KINDS.join(', ')}, not ${JSON.stringify(b.kind)}` };
  }
}

/**
 * An older plugin's glance card, as a stat body: the same figure, line,
 * sparkline and foot. How a glance that still sends `card` keeps its card
 * now that Home draws cards as widgets.
 */
export function statOfGlanceCard(card: HomeGlanceCard | undefined, icon: string): WidgetStat | undefined {
  if (!card) return undefined;
  const checked = widgetBodyOf({ kind: 'stat', icon, ...card });
  return checked.ok && checked.body.kind === 'stat' ? checked.body : undefined;
}
