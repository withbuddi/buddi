/**
 * Widgets: what the plugins export, each surface's placements, and each
 * placement's body (docs/dashboard.md, docs/plugins.md §2.5d).
 *
 *   GET  /api/widgets[?surface=home|lock][&hour=12|24]  → available, both surfaces' placements, a view per placement of the surface asked (Home by default)
 *   PUT  /api/widgets/home | /lock         → { placements: [{ key?, widget, size, settings? }] }: that surface's order, sizes and settings
 *   GET  /api/widgets/settings/<widget>    → the widget's fields with their choices read, and the owner's places: the settings sheet
 *   POST /api/widgets/preview              → { widget, size, settings }: the body for unsaved settings, the sheet's live preview
 *   POST /api/widgets/<key>/refresh        → produce that placement now (Try again), then the same answer as GET
 *
 * A **placement** is one widget, a size and its own settings. Home and the
 * lock screen each hold an ordered list of them; the same widget can sit twice
 * on one (weather at Home and at Work) and on both with different settings.
 * Each placement owns its settings — nothing is shared between two of them, so
 * changing one never moves another. The lock screen holds at most four, never
 * a sensitive one; until the owner arranges it, it shows the first four of
 * Home's (as before surfaces had their own).
 *
 * A body is produced at most once per its `refreshSeconds` per widget, size
 * and resolved settings (two placements set alike share it; a failure is tried
 * again after a minute), with its own timeout. One that throws, times out or
 * answers a body the page cannot draw keeps its last good body and is marked
 * stale, or shows its error when it never had one; nothing else notices. The
 * built-in World clock reads only the clock and is produced every time.
 *
 * An older plugin's glance that sends a `card` is a widget too — a small
 * `stat` under the glance's id — unless the plugin declares a widget with that
 * id.
 *
 * Kept for the installation in `core.web_settings` under `widgets` as
 * `{ version: 2, home?, lock? }`. The layout widgets v1 kept (`{ layout:
 * [{ id, size }] }`) reads as Home's placements with no settings, once, and is
 * written in the new shape on the next save. Until the owner arranges Home it
 * shows every widget that is not sensitive, in plugin order, at its first
 * size, leaving out a glance card the owner had hidden.
 */
import { randomBytes } from 'node:crypto';
import {
  CLOCK_WIDGET,
  CLOCK_WIDGET_ID,
  getOwnerProfile,
  listOwnerPlaces,
  produceClock,
  readWebSetting,
  resolveWidgetSettings,
  sanitizeWidgetSettings,
  statOfGlanceCard,
  widgetBodyOf,
  widgetPlacementLabel,
  writeWebSetting,
  WIDGET_REFRESH_DEFAULT_S,
  WIDGET_SIZES,
  type CoreToolContext,
  type OwnerPlace,
  type StoredWidgetSettings,
  type ToolRegistry,
  type WidgetBody,
  type WidgetRequest,
  type WidgetSettingField,
  type WidgetSettingOption,
  type WidgetSize,
  type WidgetSurface,
} from '@buddi/core';
import { HOME_SETTINGS_KEY } from './read.js';

/** The `core.web_settings` key the placements are kept under. */
export const WIDGETS_SETTINGS_KEY = 'widgets';

/** How long one production may take before its frame says it could not load. */
export const WIDGET_TIMEOUT_MS = 5_000;

/** After a failure, how long before it is tried again (or its refresh, if shorter). */
export const WIDGET_RETRY_MS = 60_000;

/** At most this many placements on Home. */
export const WIDGET_LAYOUT_MAX = 24;

/** At most this many on the lock screen. */
export const LOCK_WIDGETS_MAX = 4;

/** A select's read choices are kept this long, so a Home poll does not ask the plugin each time. */
export const WIDGET_OPTIONS_CACHE_MS = 60_000;

type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export interface Placement {
  /** Stable for the placement's life: what a refresh, a view and the page's React key name. */
  key: string;
  widget: string;
  size: WidgetSize;
  /** What the owner set, as kept: only what differs from the defaults. */
  settings: StoredWidgetSettings;
}

/** A placement as the page reads it: with its name ("Weather · Work"). */
export interface PlacementView extends Placement {
  label: string;
}

/** A field as the sheet draws it: a select's choices present when they are fixed. */
export type WidgetFieldView = Omit<WidgetSettingField, 'options'> & { options?: WidgetSettingOption[]; dynamic?: true };

/** One widget as the gallery and the frame know it. */
export interface WidgetInfo {
  id: string;
  plugin: string;
  title: string;
  sizes: WidgetSize[];
  link?: { plugin: string; page: string; place: 'rail' | 'settings' };
  sensitive?: boolean;
  /** What a placement of it can set; absent when nothing. */
  settings?: WidgetFieldView[];
  /** buddi's own: no plugin behind it. */
  builtIn?: true;
}

/** A placement, now: what the frame draws. */
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
  home: PlacementView[];
  lock: PlacementView[];
  /** The owner has saved that surface; until then it is the default. */
  arranged: { home: boolean; lock: boolean };
  /** By placement key, for each placement of the surface asked. */
  views: Record<string, WidgetView>;
}

/** Something that produces a body: a declared widget, the built-in clock, or an older glance's card. */
interface Producer {
  info: WidgetInfo;
  fields: readonly WidgetSettingField[] | undefined;
  refreshMs: number;
  /** A glance card standing in for a widget: available only once it has sent one. */
  legacy: boolean;
  /** Produced every time, never cached: the clock. */
  volatile: boolean;
  produce(ctx: CoreToolContext, request: WidgetRequest, owner: OwnerFacts): Promise<unknown>;
  options?(key: string, ctx: CoreToolContext): Promise<WidgetSettingOption[]>;
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

/** How a browser reads a clock: sent while the owner left Time on Auto. */
export type HourCycle = '12' | '24';
export const hourOf = (value: unknown): HourCycle | undefined => (value === '12' || value === '24' ? value : undefined);

interface OwnerFacts {
  places: OwnerPlace[];
  timeFormat: '12h' | '24h' | null;
}

export interface WidgetsDeps {
  pool: Db;
  registry: ToolRegistry;
  ctx: CoreToolContext;
  now: () => Date;
  timeoutMs?: number;
}

interface Stored {
  home?: Placement[];
  lock?: Placement[];
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

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const newKey = (): string => `w-${randomBytes(4).toString('hex')}`;
const sizeOf = (value: unknown): WidgetSize => ((WIDGET_SIZES as readonly unknown[]).includes(value) ? (value as WidgetSize) : 'small');

/** Stored placements, made sound: known shape only, keys unique. Unknown widgets are kept here and dropped against what is installed. */
function storedPlacements(value: unknown): Placement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = new Set<string>();
  const out: Placement[] = [];
  for (const raw of value) {
    const item = raw as { key?: unknown; widget?: unknown; size?: unknown; settings?: unknown } | null;
    if (!item || typeof item.widget !== 'string') continue;
    let key = typeof item.key === 'string' && KEY.test(item.key) && !keys.has(item.key) ? item.key : newKey();
    while (keys.has(key)) key = newKey();
    keys.add(key);
    const settings = item.settings && typeof item.settings === 'object' && !Array.isArray(item.settings) ? (item.settings as StoredWidgetSettings) : {};
    out.push({ key, widget: item.widget, size: sizeOf(item.size), settings });
  }
  return out;
}

/**
 * What `core.web_settings.widgets` holds, read the new way. Widgets v1's
 * `{ layout: [{ id, size }] }` is Home's placements with no settings: the one
 * conversion, kept until the next save writes the new shape.
 */
export function readStoredWidgets(value: unknown): Stored {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (v.version === 2) {
    const home = storedPlacements(v.home);
    const lock = storedPlacements(v.lock);
    return { ...(home ? { home } : {}), ...(lock ? { lock } : {}) };
  }
  if (Array.isArray(v.layout)) {
    const seen = new Set<string>();
    const home: Placement[] = [];
    for (const raw of v.layout as unknown[]) {
      const item = raw as { id?: unknown; size?: unknown } | null;
      if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
      seen.add(item.id);
      // A key derived from the id, so two reads before the first save name the same placement.
      home.push({ key: `v1-${item.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 40), widget: item.id, size: sizeOf(item.size), settings: {} });
    }
    return { home };
  }
  return {};
}

function fieldView(f: WidgetSettingField): WidgetFieldView {
  if (f.kind !== 'select' && f.kind !== 'multiselect') return f;
  const { options, ...rest } = f;
  return Array.isArray(options) ? { ...rest, options } : { ...rest, dynamic: true };
}

/**
 * The widgets service: one per web server, holding the cache. `answer()` is
 * GET; `saveSurface()` PUT; `settingsFor()` the sheet; `preview()` its live body.
 */
export function createWidgets(deps: WidgetsDeps) {
  const timeoutMs = deps.timeoutMs ?? WIDGET_TIMEOUT_MS;
  const cache = new Map<string, Entry>();
  const optionsCache = new Map<string, { at: number; options: WidgetSettingOption[] }>();
  /** The page an older glance last linked to, by its id: its card opens the same page. */
  const glancePages = new Map<string, string | undefined>();

  const linkOf = (plugin: string, page: string | undefined): WidgetInfo['link'] => {
    if (page === undefined) return undefined;
    const target = deps.registry.pages().find((p) => p.plugin === plugin && p.id === page);
    return target ? { plugin, page: target.id, place: target.place } : undefined;
  };

  /** Declared widgets first, in plugin order, then the World clock, then the glances that may carry a card. */
  function producers(): Producer[] {
    const declared: Producer[] = deps.registry.widgets().map((w) => {
      const link = linkOf(w.plugin, w.link?.page);
      return {
        info: {
          id: w.id, plugin: w.plugin, title: w.title, sizes: [...w.sizes],
          ...(link ? { link } : {}), ...(w.sensitive ? { sensitive: true } : {}),
          ...(w.settings ? { settings: w.settings.map(fieldView) } : {}),
        },
        fields: w.settings,
        refreshMs: w.refreshSeconds * 1000,
        legacy: false,
        volatile: false,
        produce: (ctx, request) => w.produce(ctx, request),
        ...(w.options ? { options: (key: string, ctx: CoreToolContext) => w.options!(key, ctx) } : {}),
      };
    });
    const taken = new Set(declared.map((p) => p.info.id));
    const clock: Producer = {
      info: { id: CLOCK_WIDGET_ID, plugin: CLOCK_WIDGET.plugin, title: CLOCK_WIDGET.title, sizes: [...CLOCK_WIDGET.sizes], settings: CLOCK_WIDGET.settings.map(fieldView), builtIn: true },
      fields: CLOCK_WIDGET.settings,
      refreshMs: 60_000,
      legacy: false,
      volatile: true,
      produce: async (_ctx, request, owner) => produceClock(request.settings ?? {}, request.size, { now: deps.now(), timezone: deps.ctx.timezone, places: owner.places }),
    };
    const legacy: Producer[] = [];
    for (const contribution of deps.registry.home()) {
      if (contribution.placement !== 'glance' || taken.has(contribution.id)) continue;
      const plugin = deps.registry.homePlugin(contribution.id) ?? contribution.id.split('.')[0] ?? '';
      legacy.push({
        get info(): WidgetInfo {
          const link = linkOf(plugin, glancePages.get(contribution.id));
          return { id: contribution.id, plugin, title: contribution.title, sizes: ['small'], ...(link ? { link } : {}) };
        },
        fields: undefined,
        refreshMs: WIDGET_REFRESH_DEFAULT_S * 1000,
        legacy: true,
        volatile: false,
        async produce(ctx) {
          const glance = await contribution.produce(ctx);
          glancePages.set(contribution.id, glance?.link?.route?.page);
          return glance?.card ? statOfGlanceCard(glance.card, glance.icon) ?? null : null;
        },
      });
    }
    return [...declared, clock, ...legacy];
  }

  /**
   * The owner's places and time format. `hour` is how the asking browser reads
   * a clock, used only while the owner left Time on Auto: the page's own
   * clock follows the browser then, and a widget's should not disagree.
   */
  async function ownerFacts(hour?: HourCycle): Promise<OwnerFacts> {
    const [places, profile] = await Promise.all([
      listOwnerPlaces(deps.pool as never).catch(() => [] as OwnerPlace[]),
      getOwnerProfile(deps.pool as never).catch(() => null),
    ]);
    return { places, timeFormat: profile?.timeFormat ?? (hour === '12' ? '12h' : hour === '24' ? '24h' : null) };
  }

  /** A select's choices: fixed, or read through the plugin (kept a minute). Empty when they cannot be read. */
  async function optionsOf(p: Producer, fresh = false): Promise<Record<string, WidgetSettingOption[]>> {
    const out: Record<string, WidgetSettingOption[]> = {};
    for (const f of p.fields ?? []) {
      if (f.kind !== 'select' && f.kind !== 'multiselect') continue;
      if (Array.isArray(f.options)) {
        out[f.key] = f.options;
        continue;
      }
      const key = `${p.info.id}\u0000${f.key}`;
      const hit = optionsCache.get(key);
      if (!fresh && hit && deps.now().getTime() - hit.at < WIDGET_OPTIONS_CACHE_MS) {
        out[f.key] = hit.options;
        continue;
      }
      try {
        const read = await withTimeout(Promise.resolve().then(() => p.options?.(f.key, deps.ctx) ?? []), timeoutMs);
        const options = (Array.isArray(read) ? read : [])
          .filter((o): o is WidgetSettingOption => !!o && typeof o.value === 'string' && typeof o.label === 'string' && o.label.trim() !== '')
          .slice(0, 50)
          .map((o) => ({ value: o.value.slice(0, 80), label: o.label.trim().slice(0, 60) }));
        optionsCache.set(key, { at: deps.now().getTime(), options });
        out[f.key] = options;
      } catch {
        out[f.key] = hit?.options ?? [];
      }
    }
    return out;
  }

  /** Produce one, unless the cache still holds a fresh answer; one try at a time per widget, size and settings. */
  async function ensure(p: Producer, size: WidgetSize, stored: StoredWidgetSettings, owner: OwnerFacts, force = false): Promise<Entry> {
    const settings = resolveWidgetSettings(p.fields, stored, owner);
    const key = `${p.info.id}\u0000${size}\u0000${JSON.stringify(settings)}`;
    let entry = p.volatile ? undefined : cache.get(key);
    if (!entry) {
      entry = { at: 0 };
      if (!p.volatile) cache.set(key, entry);
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
        const raw = await withTimeout(Promise.resolve().then(() => p.produce(deps.ctx, { size, settings }, owner)), timeoutMs);
        if (raw === null || raw === undefined) {
          e.body = null;
        } else {
          const checked = widgetBodyOf(raw, { plugin: p.info.plugin });
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
  async function availableOf(all: Producer[], owner: OwnerFacts): Promise<Producer[]> {
    const offered = await Promise.all(
      all.map(async (p) => {
        if (!p.legacy) return p;
        const entry = await ensure(p, 'small', {}, owner);
        return entry.body ? p : null;
      }),
    );
    return offered.filter((p): p is Producer => p !== null);
  }

  /** A stored list against what is installed: unknown widgets dropped, sizes it no longer offers put back to its first. */
  function fit(list: Placement[], byId: Map<string, Producer>, surface: WidgetSurface): Placement[] {
    const out = list
      .filter((p) => byId.has(p.widget) && !(surface === 'lock' && byId.get(p.widget)!.info.sensitive))
      .map((p) => {
        const sizes = byId.get(p.widget)!.info.sizes;
        return { ...p, size: sizes.includes(p.size) ? p.size : sizes[0]! };
      });
    return surface === 'lock' ? out.slice(0, LOCK_WIDGETS_MAX) : out;
  }

  async function surfaces(available: Producer[]): Promise<{ stored: Stored; home: Placement[]; lock: Placement[] }> {
    const byId = new Map(available.map((p) => [p.info.id, p]));
    const stored = readStoredWidgets(await readSetting<Record<string, unknown>>(deps.pool, WIDGETS_SETTINGS_KEY));
    let home: Placement[];
    if (stored.home) {
      home = fit(stored.home, byId, 'home');
    } else {
      const settings = await readSetting<{ hiddenGlances?: unknown }>(deps.pool, HOME_SETTINGS_KEY);
      const hidden = new Set(Array.isArray(settings.hiddenGlances) ? settings.hiddenGlances : []);
      home = available
        .filter((p) => !p.info.sensitive && !hidden.has(p.info.id) && !p.info.builtIn)
        .map((p) => ({ key: `d-${p.info.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 40), widget: p.info.id, size: p.info.sizes[0]!, settings: {} }));
    }
    // Until the lock screen is arranged: the first four of Home's that may show there, at their size.
    const lock = stored.lock
      ? fit(stored.lock, byId, 'lock')
      : fit(home.map((p) => ({ ...p, key: `l-${p.key}`.slice(0, 40) })), byId, 'lock');
    return { stored, home, lock };
  }

  /**
   * `timeFormat` stands in for the owner's Profile: the lock screen passes its
   * clock's, so a widget left on Profile reads the way the big clock does.
   */
  async function answer(opts: { surface?: WidgetSurface; force?: string; hour?: HourCycle; timeFormat?: '12h' | '24h' } = {}): Promise<WidgetsAnswer> {
    const facts = await ownerFacts(opts.hour);
    const owner = opts.timeFormat ? { ...facts, timeFormat: opts.timeFormat } : facts;
    const available = await availableOf(producers(), owner);
    const byId = new Map(available.map((p) => [p.info.id, p]));
    const { stored, home, lock } = await surfaces(available);
    const shown = (opts.surface ?? 'home') === 'lock' ? lock : home;
    const views = await Promise.all(
      shown.map(async (p) => [p.key, viewOf(await ensure(byId.get(p.widget)!, p.size, p.settings, owner, opts.force === p.key))] as const),
    );
    const named = async (list: Placement[]): Promise<PlacementView[]> =>
      Promise.all(list.map(async (p) => {
        const producer = byId.get(p.widget)!;
        const needsOptions = producer.fields?.some((f) => f.inTitle && f.kind === 'select' && !Array.isArray(f.options) && p.settings[f.key] !== undefined);
        const options = needsOptions ? await optionsOf(producer) : undefined;
        return { ...p, label: widgetPlacementLabel(producer.info.title, producer.fields, p.settings, { ...(options ? { options } : {}), places: owner.places }) };
      }));
    return {
      available: available.map((p) => p.info),
      home: await named(home),
      lock: await named(lock),
      arranged: { home: stored.home !== undefined, lock: stored.lock !== undefined },
      views: Object.fromEntries(views),
    };
  }

  /** One placement as sent, checked: an installed widget, a size it offers, settings it declares. */
  async function checkPlacement(
    raw: unknown,
    known: Map<string, Producer>,
    owner: OwnerFacts,
    surface: WidgetSurface,
  ): Promise<{ ok: true; placement: Omit<Placement, 'key'> & { key?: string } } | { ok: false; error: string }> {
    const item = (raw ?? {}) as { key?: unknown; widget?: unknown; id?: unknown; size?: unknown; settings?: unknown };
    const widget = typeof item.widget === 'string' ? item.widget : typeof item.id === 'string' ? item.id : '';
    const producer = known.get(widget);
    if (!producer) return { ok: false, error: `no widget is installed with the id ${widget || JSON.stringify(item.widget)}` };
    if (surface === 'lock' && producer.info.sensitive) return { ok: false, error: `${producer.info.title} is sensitive: it never shows on the lock screen` };
    if (!(producer.info.sizes as readonly unknown[]).includes(item.size)) {
      return { ok: false, error: `${widget} comes in ${producer.info.sizes.join(' or ')}, not ${JSON.stringify(item.size)}` };
    }
    const needsOptions = producer.fields?.some((f) => (f.kind === 'select' || f.kind === 'multiselect') && !Array.isArray(f.options) && item.settings && typeof item.settings === 'object' && f.key in (item.settings as object));
    const options = needsOptions ? await optionsOf(producer, true) : undefined;
    // Choices that could not be read are not held against the owner: kept as sent, checked again when they can be.
    const readable = options ? Object.fromEntries(Object.entries(options).filter(([, list]) => list.length > 0)) : undefined;
    const settings = sanitizeWidgetSettings(producer.fields, item.settings, { ...(readable ? { options: readable } : {}), places: owner.places });
    if (!settings.ok) return { ok: false, error: `${producer.info.title}: ${settings.error}` };
    return {
      ok: true,
      placement: { ...(typeof item.key === 'string' ? { key: item.key } : {}), widget, size: item.size as WidgetSize, settings: settings.settings },
    };
  }

  /** Check and keep one surface's placements. The other surface is kept as it is (Home's default stays a default). */
  async function saveSurface(surface: WidgetSurface, body: unknown, hour?: HourCycle): Promise<{ status: number; body: unknown }> {
    const b = (body ?? {}) as { placements?: unknown; layout?: unknown };
    const raw = Array.isArray(b.placements) ? b.placements : Array.isArray(b.layout) && surface === 'home' ? b.layout : undefined;
    if (!raw) return { status: 400, body: { error: '`placements` must be a list of { widget, size, settings }' } };
    const max = surface === 'lock' ? LOCK_WIDGETS_MAX : WIDGET_LAYOUT_MAX;
    if (raw.length > max) {
      return { status: 400, body: { error: surface === 'lock' ? `the lock screen holds at most ${LOCK_WIDGETS_MAX} widgets` : `at most ${WIDGET_LAYOUT_MAX} widgets fit on Home` } };
    }
    const owner = await ownerFacts();
    const known = new Map(producers().map((p) => [p.info.id, p]));
    const keys = new Set<string>();
    const placements: Placement[] = [];
    for (const item of raw as unknown[]) {
      const checked = await checkPlacement(item, known, owner, surface);
      if (!checked.ok) return { status: 400, body: { error: checked.error } };
      let key = checked.placement.key && KEY.test(checked.placement.key) && !keys.has(checked.placement.key) ? checked.placement.key : newKey();
      while (keys.has(key)) key = newKey();
      keys.add(key);
      placements.push({ ...checked.placement, key });
    }
    const current = readStoredWidgets(await readSetting<Record<string, unknown>>(deps.pool, WIDGETS_SETTINGS_KEY));
    const next = { version: 2, ...current, [surface]: placements };
    await writeWebSetting(deps.pool as never, WIDGETS_SETTINGS_KEY, next);
    return { status: 200, body: await answer({ surface, ...(hour ? { hour } : {}) }) };
  }

  /** The sheet's fields with their choices read now, and the owner's places for a place field. */
  async function settingsFor(widget: string): Promise<{ status: number; body: unknown }> {
    const producer = producers().find((p) => p.info.id === widget);
    if (!producer) return { status: 404, body: { error: `no widget is installed with the id ${widget}` } };
    const [owner, options] = await Promise.all([ownerFacts(), optionsOf(producer, true)]);
    const fields = (producer.fields ?? []).map((f) =>
      f.kind === 'select' || f.kind === 'multiselect' ? { ...fieldView(f), options: options[f.key] ?? [] } : fieldView(f),
    );
    return {
      status: 200,
      body: {
        widget,
        fields,
        places: owner.places.map((p) => ({ id: p.id, label: p.label, name: p.name, timezone: p.timezone })),
        timeFormat: owner.timeFormat,
      },
    };
  }

  /** The body unsaved settings would give: the sheet's live preview. Through the same cache. */
  async function preview(body: unknown): Promise<{ status: number; body: unknown }> {
    const owner = await ownerFacts(hourOf((body as { hour?: unknown } | null)?.hour));
    const known = new Map(producers().map((p) => [p.info.id, p]));
    const checked = await checkPlacement(body, known, owner, 'home');
    if (!checked.ok) return { status: 400, body: { error: checked.error } };
    const producer = known.get(checked.placement.widget)!;
    const entry = await ensure(producer, checked.placement.size, checked.placement.settings, owner);
    return {
      status: 200,
      body: {
        view: viewOf(entry),
        label: widgetPlacementLabel(producer.info.title, producer.fields, checked.placement.settings, { options: await optionsOf(producer), places: owner.places }),
      },
    };
  }

  return { answer, saveSurface, settingsFor, preview };
}

export type WidgetsService = ReturnType<typeof createWidgets>;

/** The routes, one module, as tips and connections do. */
export async function widgetsRoute(
  service: WidgetsService,
  req: { method: string; path: string; body: unknown; query?: URLSearchParams },
): Promise<{ status: number; body: unknown }> {
  if (req.path === '/api/widgets') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const hour = hourOf(req.query?.get('hour'));
      return { status: 200, body: await service.answer({ surface: req.query?.get('surface') === 'lock' ? 'lock' : 'home', ...(hour ? { hour } : {}) }) };
    }
    return { status: 405, body: { error: 'GET only' } };
  }
  const surface = /^\/api\/widgets\/(home|lock)$/.exec(req.path);
  if (surface) {
    if (req.method === 'PUT') return service.saveSurface(surface[1] as WidgetSurface, req.body, hourOf(req.query?.get('hour')));
    return { status: 405, body: { error: 'PUT only' } };
  }
  const settings = /^\/api\/widgets\/settings\/([^/]+)$/.exec(req.path);
  if (settings) {
    if (req.method !== 'GET') return { status: 405, body: { error: 'GET only' } };
    return service.settingsFor(decodeURIComponent(settings[1] as string));
  }
  if (req.path === '/api/widgets/preview') {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    return service.preview(req.body);
  }
  const refresh = /^\/api\/widgets\/([^/]+)\/refresh$/.exec(req.path);
  if (refresh) {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const surfaceOf = req.query?.get('surface') === 'lock' ? 'lock' : 'home';
    const hour = hourOf(req.query?.get('hour'));
    return { status: 200, body: await service.answer({ surface: surfaceOf, force: decodeURIComponent(refresh[1] as string), ...(hour ? { hour } : {}) }) };
  }
  return { status: 404, body: { error: 'not found' } };
}
