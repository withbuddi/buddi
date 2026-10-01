/**
 * Home's widgets: what the plugins export, the owner's layout, and each
 * placed widget's body (docs/dashboard.md, docs/plugins.md §2.5d).
 *
 *   GET  /api/widgets                → available, layout, arranged, and a view per placed widget
 *   PUT  /api/widgets/layout         → { layout: [{ id, size }] }: the owner's order and sizes
 *   POST /api/widgets/<id>/refresh   → produce that one now (Try again), then the same answer as GET
 *
 * A widget is produced at most once per its `refreshSeconds` (a failure is
 * tried again after a minute), with its own timeout, and one at a time per
 * widget and size. One that throws, times out or answers a body the page
 * cannot draw keeps its last good body and is marked stale, or shows its
 * error when it never had one; nothing else on Home notices.
 *
 * An older plugin's glance that sends a `card` is a widget too — a small
 * `stat` under the glance's id — unless the plugin declares a widget with that
 * id. That is how a card drawn beside the greeting before widgets keeps
 * appearing on Home.
 *
 * The layout is the installation's, in `core.web_settings` under `widgets`, so
 * a widget placed on the laptop is on the phone too. Until the owner arranges
 * anything, Home shows every widget that is not sensitive, in plugin order, at
 * its first size, leaving out a glance card the owner had hidden.
 */
import {
  readWebSetting,
  statOfGlanceCard,
  widgetBodyOf,
  writeWebSetting,
  WIDGET_REFRESH_DEFAULT_S,
  WIDGET_SIZES,
  type CoreToolContext,
  type ToolRegistry,
  type WidgetBody,
  type WidgetRequest,
  type WidgetSize,
} from '@buddi/core';
import { HOME_SETTINGS_KEY } from './read.js';

/** The `core.web_settings` key the owner's layout is kept under. */
export const WIDGETS_SETTINGS_KEY = 'widgets';

/** How long one production may take before its frame says it could not load. */
export const WIDGET_TIMEOUT_MS = 5_000;

/** After a failure, how long before it is tried again (or its refresh, if shorter). */
export const WIDGET_RETRY_MS = 60_000;

/** At most this many widgets in a layout. */
export const WIDGET_LAYOUT_MAX = 24;

type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export interface LayoutItem {
  id: string;
  size: WidgetSize;
}

/** One widget as the gallery and the frame know it. */
export interface WidgetInfo {
  id: string;
  plugin: string;
  title: string;
  sizes: WidgetSize[];
  link?: { plugin: string; page: string; place: 'rail' | 'settings' };
  sensitive?: boolean;
}

/** A placed widget, now: what the frame draws. */
export interface WidgetView {
  /** `ok`: a body. `empty`: nothing to show. `stale`: the last body, the refresh failed. `error`: failed, no body. */
  state: 'ok' | 'empty' | 'stale' | 'error';
  body?: WidgetBody;
  /** When the body (or the nothing) was produced. */
  updatedAt?: string;
  /** Why the last try failed, for `stale` and `error`. */
  error?: string;
}

export interface WidgetsAnswer {
  available: WidgetInfo[];
  layout: LayoutItem[];
  /** The owner has saved a layout; until then `layout` is the default. */
  arranged: boolean;
  /** By id, for each placed widget. */
  widgets: Record<string, WidgetView>;
}

/** Something that produces a body: a declared widget, or an older glance's card. */
interface Producer {
  info: WidgetInfo;
  refreshMs: number;
  /** A glance card standing in for a widget: available only once it has sent one. */
  legacy: boolean;
  produce(ctx: CoreToolContext, request: WidgetRequest): Promise<unknown>;
}

interface Entry {
  /** When the last try finished, good or bad. */
  at: number;
  /** The last good answer: a body, or null for nothing to show. Undefined when there never was one. */
  body?: WidgetBody | null;
  okAt?: number;
  error?: string;
  inflight?: Promise<void>;
}

export interface WidgetsDeps {
  pool: Db;
  registry: ToolRegistry;
  ctx: CoreToolContext;
  now: () => Date;
  timeoutMs?: number;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not answer in ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function readSetting<T extends object>(pool: Db, key: string): Promise<T> {
  try {
    const value = await readWebSetting<T>(pool as never, key);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : ({} as T);
  } catch {
    return {} as T;
  }
}

/** A stored layout, made sound: known shape only, no repeats. Unknown ids are kept here and dropped against what is installed. */
function storedLayout(value: unknown): LayoutItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const raw of value) {
    const item = raw as { id?: unknown; size?: unknown } | null;
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, size: (WIDGET_SIZES as readonly unknown[]).includes(item.size) ? (item.size as WidgetSize) : 'small' });
  }
  return out;
}

/**
 * The widgets service: one per web server, holding the cache. `answer()` is
 * GET; `saveLayout()` PUT; `refresh()` the Try again.
 */
export function createWidgets(deps: WidgetsDeps) {
  const timeoutMs = deps.timeoutMs ?? WIDGET_TIMEOUT_MS;
  const cache = new Map<string, Entry>();
  /** The page an older glance last linked to, by its id: its card opens the same page. */
  const glancePages = new Map<string, string | undefined>();
  const keyOf = (id: string, size: WidgetSize): string => `${id}\u0000${size}`;

  const linkOf = (plugin: string, page: string | undefined): WidgetInfo['link'] => {
    if (page === undefined) return undefined;
    const target = deps.registry.pages().find((p) => p.plugin === plugin && p.id === page);
    return target ? { plugin, page: target.id, place: target.place } : undefined;
  };

  /** Declared widgets first, in plugin order, then the glances that may carry a card. */
  function producers(): Producer[] {
    const declared: Producer[] = deps.registry.widgets().map((w) => {
      const link = linkOf(w.plugin, w.link?.page);
      return {
        info: { id: w.id, plugin: w.plugin, title: w.title, sizes: [...w.sizes], ...(link ? { link } : {}), ...(w.sensitive ? { sensitive: true } : {}) },
        refreshMs: w.refreshSeconds * 1000,
        legacy: false,
        produce: (ctx, request) => w.produce(ctx, request),
      };
    });
    const taken = new Set(declared.map((p) => p.info.id));
    const legacy: Producer[] = [];
    for (const contribution of deps.registry.home()) {
      if (contribution.placement !== 'glance' || taken.has(contribution.id)) continue;
      const plugin = deps.registry.homePlugin(contribution.id) ?? contribution.id.split('.')[0] ?? '';
      legacy.push({
        get info(): WidgetInfo {
          const link = linkOf(plugin, glancePages.get(contribution.id));
          return { id: contribution.id, plugin, title: contribution.title, sizes: ['small'], ...(link ? { link } : {}) };
        },
        refreshMs: WIDGET_REFRESH_DEFAULT_S * 1000,
        legacy: true,
        async produce(ctx) {
          const glance = await contribution.produce(ctx);
          glancePages.set(contribution.id, glance?.link?.route?.page);
          return glance?.card ? statOfGlanceCard(glance.card, glance.icon) ?? null : null;
        },
      });
    }
    return [...declared, ...legacy];
  }

  /** Produce one, unless the cache still holds a fresh answer; one try at a time per widget and size. */
  async function ensure(p: Producer, size: WidgetSize, force = false): Promise<Entry> {
    const key = keyOf(p.info.id, size);
    let entry = cache.get(key);
    if (!entry) {
      entry = { at: 0 };
      cache.set(key, entry);
    }
    if (entry.inflight) {
      await entry.inflight;
      return entry;
    }
    const now = deps.now().getTime();
    const wait = entry.error !== undefined ? Math.min(WIDGET_RETRY_MS, p.refreshMs) : p.refreshMs;
    if (!force && entry.at > 0 && now - entry.at < wait) return entry;
    const e = entry;
    e.inflight = (async () => {
      try {
        const raw = await withTimeout(Promise.resolve().then(() => p.produce(deps.ctx, { size })), timeoutMs);
        if (raw === null || raw === undefined) {
          e.body = null;
        } else {
          const checked = widgetBodyOf(raw);
          if (!checked.ok) throw new Error(checked.reason);
          e.body = checked.body;
        }
        e.okAt = deps.now().getTime();
        delete e.error;
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err);
      } finally {
        e.at = deps.now().getTime();
        delete e.inflight;
      }
    })();
    await e.inflight;
    return e;
  }

  function viewOf(entry: Entry): WidgetView {
    const updatedAt = entry.okAt !== undefined ? new Date(entry.okAt).toISOString() : undefined;
    if (entry.error !== undefined) {
      return entry.body
        ? { state: 'stale', body: entry.body, ...(updatedAt ? { updatedAt } : {}), error: entry.error }
        : { state: 'error', error: entry.error };
    }
    return entry.body ? { state: 'ok', body: entry.body, ...(updatedAt ? { updatedAt } : {}) } : { state: 'empty', ...(updatedAt ? { updatedAt } : {}) };
  }

  /** A legacy glance is offered only once it has sent a card; produced through the same cache to find out. */
  async function availableOf(all: Producer[]): Promise<Producer[]> {
    const offered = await Promise.all(
      all.map(async (p) => {
        if (!p.legacy) return p;
        const entry = await ensure(p, 'small');
        return entry.body ? p : null;
      }),
    );
    return offered.filter((p): p is Producer => p !== null);
  }

  async function answer(opts: { force?: string } = {}): Promise<WidgetsAnswer> {
    const available = await availableOf(producers());
    const byId = new Map(available.map((p) => [p.info.id, p]));
    const settings = await readSetting<{ layout?: unknown }>(deps.pool, WIDGETS_SETTINGS_KEY);
    const saved = storedLayout(settings.layout);
    let layout: LayoutItem[];
    if (saved) {
      layout = saved
        .filter((item) => byId.has(item.id))
        .map((item) => {
          const sizes = byId.get(item.id)!.info.sizes;
          return { id: item.id, size: sizes.includes(item.size) ? item.size : sizes[0]! };
        });
    } else {
      const home = await readSetting<{ hiddenGlances?: unknown }>(deps.pool, HOME_SETTINGS_KEY);
      const hidden = new Set(Array.isArray(home.hiddenGlances) ? home.hiddenGlances : []);
      layout = available
        .filter((p) => !p.info.sensitive && !hidden.has(p.info.id))
        .map((p) => ({ id: p.info.id, size: p.info.sizes[0]! }));
    }
    const views = await Promise.all(
      layout.map(async (item) => [item.id, viewOf(await ensure(byId.get(item.id)!, item.size, opts.force === item.id))] as const),
    );
    return {
      available: available.map((p) => p.info),
      layout,
      arranged: saved !== undefined,
      widgets: Object.fromEntries(views),
    };
  }

  /** Check and keep the owner's layout. Every id must be a widget (or a glance) installed here, at a size it offers. */
  async function saveLayout(body: unknown): Promise<{ status: number; body: unknown }> {
    const raw = (body as { layout?: unknown } | null)?.layout;
    if (!Array.isArray(raw)) return { status: 400, body: { error: '`layout` must be a list of { id, size }' } };
    if (raw.length > WIDGET_LAYOUT_MAX) return { status: 400, body: { error: `at most ${WIDGET_LAYOUT_MAX} widgets fit on Home` } };
    const known = new Map(producers().map((p) => [p.info.id, p]));
    const seen = new Set<string>();
    const layout: LayoutItem[] = [];
    for (const item of raw as Array<{ id?: unknown; size?: unknown } | null>) {
      const id = item && typeof item.id === 'string' ? item.id : '';
      const producer = known.get(id);
      if (!producer) return { status: 400, body: { error: `no widget is installed with the id ${id || JSON.stringify(item?.id)}` } };
      if (seen.has(id)) return { status: 400, body: { error: `${id} is in the layout twice` } };
      seen.add(id);
      const size = item!.size;
      if (!(producer.info.sizes as readonly unknown[]).includes(size)) {
        return { status: 400, body: { error: `${id} comes in ${producer.info.sizes.join(' or ')}, not ${JSON.stringify(size)}` } };
      }
      layout.push({ id, size: size as WidgetSize });
    }
    await writeWebSetting(deps.pool as never, WIDGETS_SETTINGS_KEY, { layout });
    return { status: 200, body: await answer() };
  }

  return { answer, saveLayout };
}

export type WidgetsService = ReturnType<typeof createWidgets>;

/** The routes, one module, as tips and connections do. */
export async function widgetsRoute(
  service: WidgetsService,
  req: { method: string; path: string; body: unknown },
): Promise<{ status: number; body: unknown }> {
  if (req.path === '/api/widgets') {
    if (req.method === 'GET' || req.method === 'HEAD') return { status: 200, body: await service.answer() };
    return { status: 405, body: { error: 'GET only' } };
  }
  if (req.path === '/api/widgets/layout') {
    if (req.method === 'PUT') return service.saveLayout(req.body);
    return { status: 405, body: { error: 'PUT only' } };
  }
  const refresh = /^\/api\/widgets\/([^/]+)\/refresh$/.exec(req.path);
  if (refresh) {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    return { status: 200, body: await service.answer({ force: decodeURIComponent(refresh[1] as string) }) };
  }
  return { status: 404, body: { error: 'not found' } };
}
