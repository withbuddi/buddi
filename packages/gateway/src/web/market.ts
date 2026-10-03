/**
 * `GET /api/market` — the plugin list from withbuddi.com, for Browse.
 *
 * The page never reaches the internet itself: it asks this route, and this
 * route fetches `<origin>/plugins/index.json` only when it is asked — which is
 * when the owner opens the Browse tab. Nothing fetches it at start or on a
 * timer. It is one of the few things that leave the machine, and the docs list
 * it as that: "the plugin list from withbuddi.com, when you open Browse".
 *
 * The answer is kept a day, in memory and on disk under the data directory, so
 * opening Browse twice does not ask twice. A fetch that fails with a copy on
 * hand answers the copy, marked `stale`; one that fails with nothing answers
 * an empty list and the sentence, still with a 200, because "withbuddi.com did
 * not answer" is something the page shows, not an error in the gateway.
 *
 * Each entry is annotated against the installed record: `installed` when a
 * plugin of that npm name (or buddi name) is here, `update` when the listed
 * version is newer, and `usesWords` in the same words the staged card uses.
 * Nothing about installing changes: Install on the page stages the spec, and
 * the staged card and its approvals are the ones every install goes through.
 *
 * The listings' pictures come through here too: `GET /api/market/asset?url=`
 * fetches a file under `https://withbuddi.com/plugins/` (a screenshot) and
 * keeps it beside the index, so the page never reaches the internet itself.
 * Each listing's icon is read the same way while the list is answered and
 * passed on as `iconSvg`, sanitised to plain shapes (`svg.ts`), so the page can
 * draw it inline in the colour of its tile. Both happen only on the way to
 * Browse, which is already the one time the market is asked anything.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compareVersions, cutLine, resolveDataDir, WIDGET_SIZES, WIDGET_TITLE_MAX, widgetBodyOf, type InstalledPlugin, type WidgetBody, type WidgetSize } from '@buddi/core';
import { installedRecord, usesWords, type RouteReply } from './plugins.js';
import { sanitizeIconSvg } from './svg.js';

export const MARKET_ORIGIN = 'https://withbuddi.com';
/** How long a fetched list is trusted before Browse asks again. The pictures keep a day. */
export const MARKET_TTL_MS = 60 * 60 * 1000;
export const MARKET_ASSET_TTL_MS = 24 * 60 * 60 * 1000;
export const MARKET_TIMEOUT_MS = 10_000;

export const MARKET_CATEGORIES = ['days', 'money', 'home', 'voice', 'work', 'other'] as const;

/**
 * One listing. Only what Browse relies on is checked; every other field the
 * site writes is kept as it came, so a newer index still reaches the page.
 */
const entrySchema = z
  .object({
    name: z.string().min(1),
    npm: z.string().min(1),
    version: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
    category: z.enum(MARKET_CATEGORIES).catch('other'),
    trust: z.enum(['by-buddi', 'reviewed']),
    pricing: z
      .object({ kind: z.enum(['free', 'paid', 'subscription']) })
      .passthrough()
      .catch({ kind: 'free' as const }),
  })
  .passthrough();

const indexSchema = z
  .object({
    generatedAt: z.string().optional(),
    plugins: z.array(z.unknown()),
  })
  .passthrough();

export type MarketEntry = z.infer<typeof entrySchema>;

export interface MarketIndex {
  generatedAt?: string;
  plugins: MarketEntry[];
}

interface Cached {
  fetchedAt: string;
  index: MarketIndex;
}

export interface MarketDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Injected by tests that want no socket at all; the gateway uses the global. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Keyed by the file on disk, so two data directories never share a copy. */
const memory = new Map<string, Cached>();

/** For tests: forget the in-memory copies. */
export function resetMarketCache(): void {
  memory.clear();
}

export function marketFile(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDataDir(env), 'market', 'index.json');
}

export function marketUrl(env: NodeJS.ProcessEnv): string {
  const origin = env.BUDDI_MARKET_URL?.trim() || MARKET_ORIGIN;
  return `${origin.replace(/\/+$/, '')}/plugins/index.json`;
}

/** The index as buddi keeps it: shape checked, bad entries left out and said so. */
export function parseMarketIndex(value: unknown, log: (line: string) => void = () => {}): MarketIndex {
  const index = indexSchema.parse(value);
  const plugins: MarketEntry[] = [];
  for (const raw of index.plugins) {
    const parsed = entrySchema.safeParse(raw);
    if (parsed.success) plugins.push(parsed.data);
    else {
      const name = typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : '?';
      log(`market: left out the listing "${name}": ${parsed.error.issues[0]?.message ?? 'not a listing'}`);
    }
  }
  return { ...index, plugins };
}

function readDisk(file: string): Cached | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; index?: unknown };
    if (typeof parsed.fetchedAt !== 'string') return undefined;
    return { fetchedAt: parsed.fetchedAt, index: parseMarketIndex(parsed.index) };
  } catch {
    return undefined;
  }
}

function writeDisk(file: string, cached: Cached, log: (line: string) => void): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cached, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    // The copy in memory still answers; a day's cache on disk is a convenience.
    log(`market: could not keep the list on disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchIndex(deps: MarketDeps): Promise<MarketIndex> {
  const doFetch = deps.fetch ?? fetch;
  const url = marketUrl(deps.env);
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(MARKET_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return parseMarketIndex(await response.json(), deps.log);
}

function reason(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `it did not answer within ${MARKET_TIMEOUT_MS / 1000} seconds`;
  }
  if (err instanceof z.ZodError) return 'what it answered is not a plugin list';
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return `${err instanceof Error ? err.message : String(err)}${cause}`;
}

/** Which installed record, if any, is this listing. */
export function installedAs(entry: MarketEntry, record: readonly InstalledPlugin[]): InstalledPlugin | undefined {
  return record.find(
    (plugin) =>
      plugin.name === entry.name || (plugin.source.kind === 'registry' && plugin.source.name === entry.npm),
  );
}

/** The areas a listing reaches, from its claims, in the staged card's words. */
function listedUses(entry: MarketEntry): unknown[] {
  const claims = (entry as { claims?: { package?: { uses?: unknown }; manifest?: { uses?: unknown } } }).claims;
  const uses = claims?.package?.uses ?? claims?.manifest?.uses;
  return Array.isArray(uses) ? uses : [];
}

/** A listed widget as Browse draws it: the market's Widgets filter, and the previews on a card and a listing. */
export interface MarketWidget {
  id: string;
  title: string;
  sizes: WidgetSize[];
  sensitive?: true;
  settings: number;
  /** The plugin's sample, per size. */
  preview?: Partial<Record<WidgetSize, WidgetBody>>;
}

/**
 * The widgets a listing declares (`widgets` in the index, else its claims),
 * each checked the way a plugin's own answer is: the title cut, only the two
 * sizes, the preview passed through `widgetBodyOf` with no plugin to bind a
 * picture to, so a row's image is left off and nothing the page cannot draw
 * reaches it; a size it does not offer is not kept. One without an id, a
 * title or a size is left out.
 */
export function listedWidgets(entry: MarketEntry): MarketWidget[] {
  const e = entry as { widgets?: unknown; claims?: { manifest?: { widgets?: unknown } } };
  const raw = Array.isArray(e.widgets) ? e.widgets : Array.isArray(e.claims?.manifest?.widgets) ? e.claims.manifest.widgets : [];
  const out: MarketWidget[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const title = cutLine(w.title, WIDGET_TITLE_MAX);
    const sizes = Array.isArray(w.sizes) ? WIDGET_SIZES.filter((size) => (w.sizes as unknown[]).includes(size)) : [];
    if (typeof w.id !== 'string' || w.id === '' || !title || sizes.length === 0) continue;
    const preview: Partial<Record<WidgetSize, WidgetBody>> = {};
    if (w.preview && typeof w.preview === 'object') {
      for (const size of sizes) {
        const checked = widgetBodyOf((w.preview as Record<string, unknown>)[size]);
        if (checked.ok) preview[size] = checked.body;
      }
    }
    out.push({
      id: w.id,
      title,
      sizes,
      ...(w.sensitive === true ? { sensitive: true as const } : {}),
      settings: Array.isArray(w.settings) ? w.settings.length : 0,
      ...(Object.keys(preview).length > 0 ? { preview } : {}),
    });
  }
  return out;
}

export function annotateMarket(
  plugins: readonly MarketEntry[],
  record: readonly InstalledPlugin[],
): Array<Record<string, unknown>> {
  return plugins.map((entry) => {
    const here = installedAs(entry, record);
    const newer = here !== undefined && (compareVersions(entry.version, here.version) ?? 0) > 0;
    return {
      ...entry,
      usesWords: usesWords(listedUses(entry)),
      widgets: listedWidgets(entry),
      ...(here === undefined ? {} : { installed: { version: here.version, name: here.name } }),
      ...(newer ? { update: entry.version } : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The listings' files: icons and screenshots
 * ------------------------------------------------------------------ */

/** Where every listing's files live; nothing outside it is fetched for the page. */
export const MARKET_ASSET_PREFIX = `${MARKET_ORIGIN}/plugins/`;
/** A screenshot is a few hundred kilobytes; this is room and no more. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
/** What a listing's file may be. Anything else is not passed on. */
const ASSET_TYPES: ReadonlySet<string> = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

/**
 * The prefixes a file may be fetched from: withbuddi.com's, and the origin
 * `BUDDI_MARKET_URL` names when set (a staging copy of the site), whose own
 * files sit at the same place under it.
 */
function assetPrefixes(env: NodeJS.ProcessEnv): string[] {
  const configured = env.BUDDI_MARKET_URL?.trim();
  const prefixes = [MARKET_ASSET_PREFIX];
  if (configured) prefixes.push(`${configured.replace(/\/+$/, '')}/plugins/`);
  return [...new Set(prefixes)];
}

/** The URL, when it is a listing's file; `undefined` for anything else. */
export function marketAssetUrl(env: NodeJS.ProcessEnv, raw: string | null | undefined): URL | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // Parsed, so `..` and encoded dots are resolved before the prefix is checked.
  if (url.username || url.password || url.search || url.hash) return undefined;
  return assetPrefixes(env).some((prefix) => url.href.startsWith(prefix)) && url.href.length > url.origin.length + '/plugins/'.length
    ? url
    : undefined;
}

interface Asset {
  bytes: Buffer;
  type: string;
  fetchedAt: string;
}

function assetPaths(env: NodeJS.ProcessEnv, url: URL): { bytes: string; meta: string } {
  const key = createHash('sha256').update(url.href).digest('hex');
  const dir = path.join(path.dirname(marketFile(env)), 'assets');
  return { bytes: path.join(dir, key), meta: path.join(dir, `${key}.json`) };
}

function readAsset(env: NodeJS.ProcessEnv, url: URL): Asset | undefined {
  try {
    const files = assetPaths(env, url);
    const meta = JSON.parse(readFileSync(files.meta, 'utf8')) as { url?: unknown; type?: unknown; fetchedAt?: unknown };
    if (meta.url !== url.href || typeof meta.type !== 'string' || typeof meta.fetchedAt !== 'string') return undefined;
    return { bytes: readFileSync(files.bytes), type: meta.type, fetchedAt: meta.fetchedAt };
  } catch {
    return undefined;
  }
}

function writeAsset(env: NodeJS.ProcessEnv, url: URL, asset: Asset, log: (line: string) => void): void {
  try {
    const files = assetPaths(env, url);
    mkdirSync(path.dirname(files.bytes), { recursive: true });
    const tmp = `${files.bytes}.${process.pid}.tmp`;
    writeFileSync(tmp, asset.bytes);
    renameSync(tmp, files.bytes);
    writeFileSync(files.meta, `${JSON.stringify({ url: url.href, type: asset.type, fetchedAt: asset.fetchedAt })}\n`);
  } catch (err) {
    log(`market: could not keep ${url.href} on disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchAsset(deps: MarketDeps, url: URL): Promise<Omit<Asset, 'fetchedAt'>> {
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(url.href, { signal: AbortSignal.timeout(MARKET_TIMEOUT_MS), redirect: 'error' });
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ASSET_TYPES.has(type)) throw new Error(`${url.href} is not a picture (${type || 'no type'})`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_ASSET_BYTES) throw new Error(`${url.href} is larger than a listing's picture should be`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) throw new Error(`${url.href} is larger than a listing's picture should be`);
  return { bytes, type };
}

/**
 * One listing's file: from the copy beside the index while it is under a day
 * old, else fetched and kept. A fetch that fails with a copy on hand answers
 * the copy; with none, it throws.
 */
export async function marketAsset(deps: MarketDeps, url: URL): Promise<Asset> {
  const now = deps.now ?? ((): Date => new Date());
  const kept = readAsset(deps.env, url);
  if (kept && now().getTime() - Date.parse(kept.fetchedAt) < MARKET_ASSET_TTL_MS) return kept;
  try {
    const asset = { ...(await fetchAsset(deps, url)), fetchedAt: now().toISOString() };
    writeAsset(deps.env, url, asset, deps.log);
    return asset;
  } catch (err) {
    if (kept) return kept;
    throw err;
  }
}

/** A reply that is a file rather than JSON. */
export interface AssetReply {
  status: number;
  body?: unknown;
  bytes?: Buffer;
  type?: string;
}

/**
 * `GET /api/market/asset?url=<a listing's file>` — a screenshot for the
 * detail sheet. An SVG goes out only as the sanitiser re-wrote it.
 */
export async function marketAssetRoute(deps: MarketDeps, url: URL): Promise<AssetReply> {
  const target = marketAssetUrl(deps.env, url.searchParams.get('url'));
  if (!target) return { status: 400, body: { error: `Only a listing's own files, under ${MARKET_ASSET_PREFIX}, come through here.` } };
  let asset: Asset;
  try {
    asset = await marketAsset(deps, target);
  } catch (err) {
    deps.log(`market: fetching ${target.href} failed: ${reason(err)}`);
    return { status: 502, body: { error: `buddi could not fetch that picture from withbuddi.com: ${reason(err)}` } };
  }
  if (asset.type === 'image/svg+xml') {
    const svg = sanitizeIconSvg(asset.bytes.toString('utf8'));
    if (svg === undefined) return { status: 415, body: { error: 'That picture is not one buddi will draw.' } };
    return { status: 200, bytes: Buffer.from(svg), type: asset.type };
  }
  return { status: 200, bytes: asset.bytes, type: asset.type };
}

/** A listing's icon, as markup the page may draw inline; `undefined` when there is none it will draw. */
async function iconSvgOf(deps: MarketDeps, entry: MarketEntry): Promise<string | undefined> {
  const icon = (entry as { icon?: unknown }).icon;
  const url = typeof icon === 'string' ? marketAssetUrl(deps.env, icon) : undefined;
  if (!url) return undefined;
  try {
    const asset = await marketAsset(deps, url);
    return asset.type === 'image/svg+xml' ? sanitizeIconSvg(asset.bytes.toString('utf8')) : undefined;
  } catch (err) {
    deps.log(`market: the icon of "${entry.name}" was left out: ${reason(err)}`);
    return undefined;
  }
}

/** The index as a caller gets it: the list and when it was fetched, or the sentence saying why there is none. */
export type LoadedMarket =
  | { fetchedAt: string; stale: boolean; index: MarketIndex }
  | { unavailable: string };

/**
 * The index: the copy kept under an hour old, else fetched and kept. A fetch
 * that fails with a copy on hand answers the copy, marked `stale`; with none,
 * the sentence. Browse and first run's chapter 3 both read it here.
 */
export async function loadMarketIndex(deps: MarketDeps, opts: { refresh?: boolean; cachedOnly?: boolean } = {}): Promise<LoadedMarket> {
  const now = deps.now ?? ((): Date => new Date());
  const file = marketFile(deps.env);
  let cached = memory.get(file) ?? readDisk(file);
  if (cached !== undefined) memory.set(file, cached);
  const fresh =
    cached !== undefined && now().getTime() - Date.parse(cached.fetchedAt) < MARKET_TTL_MS;
  // A read that must not reach withbuddi.com (an agent's page): the kept copy, however old, or nothing.
  if (opts.cachedOnly === true) {
    if (cached === undefined) return { unavailable: 'no copy of the list is kept yet' };
    return { fetchedAt: cached.fetchedAt, stale: !fresh, index: cached.index };
  }
  let stale = false;
  if (opts.refresh === true || !fresh) {
    try {
      const index = await fetchIndex(deps);
      cached = { fetchedAt: now().toISOString(), index };
      memory.set(file, cached);
      writeDisk(file, cached, deps.log);
    } catch (err) {
      const why = reason(err);
      deps.log(`market: fetching the plugin list failed: ${why}`);
      if (cached === undefined) return { unavailable: `buddi could not reach withbuddi.com: ${why}` };
      stale = true;
    }
  }
  return { fetchedAt: (cached as Cached).fetchedAt, stale, index: (cached as Cached).index };
}

/** `GET /api/market[?refresh=1]`. */
export async function marketRoute(deps: MarketDeps, url: URL): Promise<RouteReply> {
  const loaded = await loadMarketIndex(deps, { refresh: url.searchParams.get('refresh') === '1' });
  if ('unavailable' in loaded) return { status: 200, body: { plugins: [], unavailable: loaded.unavailable } };
  const { plugins: record } = installedRecord(deps.env);
  const listed = loaded.index.plugins;
  const icons = await Promise.all(listed.map((entry) => iconSvgOf(deps, entry)));
  return {
    status: 200,
    body: {
      fetchedAt: loaded.fetchedAt,
      ...(loaded.stale ? { stale: true } : {}),
      plugins: annotateMarket(listed, record).map((entry, i) =>
        icons[i] === undefined ? entry : { ...entry, iconSvg: icons[i] },
      ),
    },
  };
}
