/**
 * Where the agent catalogue comes from on this installation: the market list
 * `/api/market` already keeps (`market.ts`), read for its `agents`, plus what
 * the install sheet's picks can be answered with here, and each package's
 * picture (agent-catalogue.md §5).
 *
 * Opening the catalogue fetches the list when the kept copy is stale; offline
 * it answers the copy, marked stale, or says it needs withbuddi.com. Each
 * listing is read strictly (`parseAgentPackage`): one that does not parse, or
 * does not hash to its integrity, is left out and said so in `problems`, never
 * shown half-read.
 */
import { listOwnerPlaces, type CoreToolContext, type ToolRegistry } from '@buddi/core';
import { parseAgentPackage, PackageRefusal, sriSha256, type AgentPackage, type PackageNeed } from '../agents/catalogue-package.js';
import type { CatalogueService, FillChoices, LoadedCatalogue } from '../agents/platform-catalogue.js';
import { loadMarketIndex, marketAsset, marketAssetUrl, type MarketDeps } from './market.js';
import { runPageQuery } from './pages.js';
import { installedRecord } from './plugins.js';
import { currentVersion } from './version.js';

export interface CatalogueSourceDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  registry: ToolRegistry;
  ctx: CoreToolContext;
  now: () => Date;
  fetch?: MarketDeps['fetch'];
  /** For tests: the version `buddi` ranges are read against. */
  version?: () => Promise<string>;
}

/** The packages a market index carries, each read strictly. */
export function readPackages(index: Record<string, unknown>, log: (line: string) => void = () => {}): { packages: AgentPackage[]; problems: string[] } {
  const raw = Array.isArray(index.agents) ? (index.agents as unknown[]) : [];
  const packages: AgentPackage[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    try {
      const pkg = parseAgentPackage(entry);
      if (seen.has(pkg.manifest.name)) throw new PackageRefusal(`${pkg.manifest.name}: listed twice`);
      seen.add(pkg.manifest.name);
      packages.push(pkg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(message);
      log(`catalogue: left out a listing: ${message}`);
    }
  }
  const order = ['work', 'money', 'home', 'health', 'learning', 'life'];
  packages.sort(
    (a, b) => order.indexOf(a.manifest.category) - order.indexOf(b.manifest.category) || a.manifest.title.localeCompare(b.manifest.title),
  );
  return { packages, problems };
}

async function queryData(deps: CatalogueSourceDeps, plugin: string, name: string): Promise<Record<string, unknown> | null> {
  if (!deps.registry.queries().some((q) => q.plugin === plugin && q.name === name)) return null;
  const answer = await runPageQuery(
    { registry: deps.registry, ctx: deps.ctx, now: deps.now, log: deps.log },
    plugin,
    name,
    new URLSearchParams(),
  ).catch(() => null);
  if (answer?.status !== 200) return null;
  const data = (answer.body as { data?: unknown } | null)?.data;
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object') : [];
}

export function createCatalogueService(deps: CatalogueSourceDeps): CatalogueService {
  const market: MarketDeps = { env: deps.env, log: deps.log, now: deps.now, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  let read: { fetchedAt: string; index: unknown; packages: AgentPackage[]; problems: string[] } | undefined;
  return {
    async load(opts = {}): Promise<LoadedCatalogue> {
      const loaded = await loadMarketIndex(market, opts.refresh === true ? { refresh: true } : opts.cachedOnly === true ? { cachedOnly: true } : {});
      if ('unavailable' in loaded) return { unavailable: loaded.unavailable };
      // Read once per copy: an agent's page asks on every load, and each read hashes every package.
      if (read?.fetchedAt !== loaded.fetchedAt || read.index !== loaded.index) {
        read = { fetchedAt: loaded.fetchedAt, index: loaded.index, ...readPackages(loaded.index as unknown as Record<string, unknown>, deps.log) };
      }
      return { fetchedAt: loaded.fetchedAt, stale: loaded.stale, packages: read.packages, problems: read.problems };
    },
    async choices(): Promise<FillChoices> {
      const mail = await queryData(deps, 'email', 'accounts');
      const calendar = await queryData(deps, 'calendar', 'settings');
      let places: FillChoices['places'] = [];
      try {
        places = (await listOwnerPlaces(deps.ctx.db as never)).map((p) => ({ id: p.id, label: p.label }));
      } catch {
        places = [];
      }
      return {
        mailboxes: rows(mail?.accounts)
          .map((a) => a.address)
          .filter((a): a is string => typeof a === 'string' && a !== ''),
        calendars: rows(calendar?.calendars)
          .map((c) => c.name)
          .filter((n): n is string => typeof n === 'string' && n !== ''),
        places,
      };
    },
    async needs(): Promise<Record<PackageNeed, boolean>> {
      const mail = await queryData(deps, 'email', 'accounts');
      const image = await queryData(deps, 'image', 'settings');
      return {
        mailbox: rows(mail?.accounts).length > 0,
        // An account the image plugin will draw with: the one chosen in Settings → Image. A linked
        // account nobody chose yet is refused by image.generate, so it does not count.
        'image-account': typeof image?.account === 'string' && image.account !== '',
      };
    },
    async avatar(pkg: AgentPackage): Promise<Buffer | null> {
      if (!pkg.avatar || !pkg.avatarSha256) return null;
      const url = marketAssetUrl(deps.env, pkg.avatar);
      if (!url) {
        deps.log(`catalogue: the picture of "${pkg.manifest.name}" is not a market file: ${pkg.avatar}`);
        return null;
      }
      try {
        const asset = await marketAsset(market, url);
        if (sriSha256(asset.bytes) !== pkg.avatarSha256) {
          deps.log(`catalogue: the picture of "${pkg.manifest.name}" does not hash to what its listing names; left out`);
          return null;
        }
        return asset.bytes;
      } catch (err) {
        deps.log(`catalogue: the picture of "${pkg.manifest.name}" could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    version: deps.version ?? (() => currentVersion(deps.env)),
    plugins: () => installedRecord(deps.env).plugins,
  };
}
