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
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compareVersions, resolveDataDir, type InstalledPlugin } from '@buddi/core';
import { installedRecord, usesWords, type RouteReply } from './plugins.js';

export const MARKET_ORIGIN = 'https://withbuddi.com';
export const MARKET_TTL_MS = 24 * 60 * 60 * 1000;
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
function installedAs(entry: MarketEntry, record: readonly InstalledPlugin[]): InstalledPlugin | undefined {
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
      ...(here === undefined ? {} : { installed: { version: here.version, name: here.name } }),
      ...(newer ? { update: entry.version } : {}),
    };
  });
}

/** `GET /api/market[?refresh=1]`. */
export async function marketRoute(deps: MarketDeps, url: URL): Promise<RouteReply> {
  const now = deps.now ?? ((): Date => new Date());
  const file = marketFile(deps.env);
  const refresh = url.searchParams.get('refresh') === '1';
  let cached = memory.get(file) ?? readDisk(file);
  if (cached !== undefined) memory.set(file, cached);
  const fresh =
    cached !== undefined && now().getTime() - Date.parse(cached.fetchedAt) < MARKET_TTL_MS;
  let stale = false;
  if (refresh || !fresh) {
    try {
      const index = await fetchIndex(deps);
      cached = { fetchedAt: now().toISOString(), index };
      memory.set(file, cached);
      writeDisk(file, cached, deps.log);
    } catch (err) {
      const why = reason(err);
      deps.log(`market: fetching the plugin list failed: ${why}`);
      if (cached === undefined) {
        return {
          status: 200,
          body: { plugins: [], unavailable: `buddi could not reach withbuddi.com: ${why}` },
        };
      }
      stale = true;
    }
  }
  const { plugins: record } = installedRecord(deps.env);
  return {
    status: 200,
    body: {
      fetchedAt: (cached as Cached).fetchedAt,
      ...(stale ? { stale: true } : {}),
      plugins: annotateMarket((cached as Cached).index.plugins, record),
    },
  };
}
