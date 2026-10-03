/**
 * Settings → Plugins: what is installed, the two yeses that install one, and
 * the market.
 *
 * A plugin is somebody else's code running inside buddi with everything buddi
 * can do, so this page is shaped around reading before agreeing rather than
 * around a list with an install button. The trust sentence sits under the one
 * field that starts an install and is never paraphrased. Typing a package name
 * *stages* it — fetched, hashed and read, never imported — and what comes back
 * is a card of facts: who published it, the hash, how many dependencies arrived
 * and which of them run scripts, and, beside them, what the package's own prose
 * claims it owns and talks to.
 *
 * "Install" sends that hash back, so an approval can only ever mean the package
 * that was read about. If the plan then finds the prose and the manifest
 * disagreeing, a second card lists the differences and "Install anyway" is the
 * only thing that acknowledges them; the first approval never can.
 *
 * Installed plugins are compact rows; a row opens its detail in a sheet.
 * Disable and Remove ask in a small dialog centred over the page. Loading a
 * newly installed plugin needs a restart, which is the supervisor's job; a
 * checkout has no supervisor, so it gets the command instead.
 *
 * Browse is the second tab: the plugin list from withbuddi.com, asked for
 * through the gateway only when the tab is opened, as one grid behind filter
 * chips. Its Install stages the listed version, and from there it is the same
 * card and the same two yeses. A market link (`?install=<npm>@<version>`)
 * stages its spec once on arrival.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  type BuiltInPluginView,
  type InstalledPluginView,
  type MarketCategory,
  type MarketEntryView,
  type MarketView,
  type MarketWidgetView,
  type PluginAuthorView,
  type PluginDrift,
  type PluginJob,
  type PluginPlan,
  type PluginSource,
  type PluginUnlock,
  type StagedPluginView,
} from '../api';
import { fmtRelative } from '../format';
import { AGENTS_ROUTE, catalogueRoute, parseBrowseKind, parsePluginsInstall, parsePluginsTab, pluginPageRoute, pluginSettingsRoute, settingsRoute, type BrowseKind } from '../routes';
import type { PluginPageDescriptor } from '../pages/types';
import { announcePagesChanged } from '../pages/usePages';
import { ListedWidgetFrame, widgetSizesInOrder, widgetSizesWords } from './parts/ListedWidget';
import { pluginWords, restartWhile } from '../shell/restart';
import {
  ActionMenu,
  AppIcon,
  Button,
  ButtonLink,
  Card,
  Details,
  Empty,
  ErrorBanner,
  Field,
  FilterChips,
  Icon,
  KV,
  List,
  ListRow,
  Modal,
  Notice,
  Panel,
  Pill,
  SearchField,
  Section,
  Segment,
  Sheet,
  Spacer,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  useAsync,
  type Tone,
} from '../ui';
import { AgentReady, useAcceptPluginAgent } from './parts/AgentOffer';
import { PluginFolders } from './parts/PluginFolders';
import { CatCard, cardState, useLoadedPlugins } from './Catalogue';

/** The line under Plugins' title, which Settings draws. */
export const PLUGINS_LEDE =
  'New tools and pages for your team, written by someone else. Each one is read with you, fact by fact, before any of it runs.';

/** The quiet line that tells a plugin from a connection, the mirror of the one on Connections. */
function NotAConnection(): JSX.Element {
  return (
    <p className="plugins-quiet connections-quiet">
      <Icon name="globe" size={14} />
      <span>
        A plugin is code buddi installs and runs; a connection is a service or program buddi talks to.{' '}
        <a href={settingsRoute('connections')}>Connections</a>
      </span>
    </p>
  );
}

/** How often a running stage is asked where it has got to. */
const JOB_POLL_MS = 1_500;

/** What each phase of a stage is, in the words of the thing being waited for. */
const PHASE_WORDS: Record<PluginJob['phase'], string> = {
  fetching: 'Fetching the package.',
  'installing-dependencies': 'Installing its dependencies. Nothing of the plugin has run.',
  reading: 'Reading what it says it is.',
  done: 'Read. Nothing has been imported yet.',
  failed: 'That did not work.',
};

/** The one line a checkout gets instead of a restart button. */
const CHECKOUT_RESTART = 'Restart buddi to apply it. In a checkout, stop it and run: buddi serve';

/** Where a plugin comes from. Three ways in, and they ask for different things. */
type InstallMode = 'npm' | 'file' | 'directory';

const MODES: Array<{ value: InstallMode; label: string }> = [
  { value: 'npm', label: 'From npm' },
  { value: 'file', label: 'A file' },
  { value: 'directory', label: 'A directory I built' },
];

/** The last way in, so the developer path is not retyped every visit. */
const MODE_KEY = 'buddi.plugins.install-mode';

function rememberedMode(): InstallMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (MODES.some((mode) => mode.value === saved)) return saved as InstallMode;
  } catch {
    // Storage the browser refuses is not worth an error on this page.
  }
  return 'npm';
}

function rememberMode(mode: InstallMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Same: the choice just does not survive the visit.
  }
}

/** The one thing a file has to be. */
const PLUGIN_SUFFIX = '.tgz';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a plugin contributes, counted in words, leaving out what it has none of. */
function contributionWords(c: { tools: number; sentinels: number; views: number; agents: number }): string {
  const parts: string[] = [];
  if (c.tools > 0) parts.push(plural(c.tools, 'tool', 'tools'));
  if (c.sentinels > 0) parts.push(`${c.sentinels} on a timer`);
  if (c.views > 0) parts.push(plural(c.views, 'view', 'views'));
  if (c.agents > 0) parts.push(`${plural(c.agents, 'agent', 'agents')} proposed`);
  return parts.length === 0 ? 'nothing on its own' : parts.join(', ');
}

/** A source, in one readable phrase. */
function sourceWords(source: PluginSource): string {
  if (source.kind === 'registry') return `npm · ${source.name}@${source.version}`;
  if (source.kind === 'tarball') return `a file on this machine · ${source.path}`;
  return `a directory on this machine · ${source.path}`;
}

/** The same, in the two words a row has room for. */
function sourceShort(source: PluginSource): string {
  return source.kind === 'registry' ? 'npm' : source.kind === 'tarball' ? 'a file' : 'a directory';
}

/**
 * Who put this code here.
 *
 * Only the registry has a publisher to name. Code that came off this machine
 * was put there by the owner, and saying "nobody npm will name" about it reads
 * as a warning about something that is simply not npm's to vouch for.
 */
function publisherWords(source: PluginSource, publisher: string | null | undefined): string {
  if (source.kind === 'directory') return 'you, from this machine';
  if (source.kind === 'tarball') return 'a file on this machine';
  return publisher ?? 'nobody npm will name';
}

/** The "by" of a row: its author, else whoever put it here. */
function byWords(plugin: InstalledPluginView): string {
  if (plugin.author) return plugin.author.name;
  return plugin.source.kind === 'registry' ? plugin.publisher ?? 'nobody npm will name' : 'you';
}

/** An author's name, a link when they gave a URL. */
function AuthorName({ author }: { author: PluginAuthorView }): JSX.Element {
  return author.url ? (
    <a href={author.url} target="_blank" rel="noopener noreferrer">
      {author.name}
    </a>
  ) : (
    <>{author.name}</>
  );
}

/** A hash, small and allowed to break anywhere. */
function Hash({ value }: { value: string | undefined }): JSX.Element {
  return value === undefined || value === '' ? (
    <span className="muted">none — this came off a disk</span>
  ) : (
    <span className="plugins-hash">{value}</span>
  );
}

/** Hosts, or the sentence that says there are none. */
function hostsValue(hosts: string[]): ReactNode {
  return hosts.length === 0 ? 'none; nothing leaves this computer' : <span className="mono">{hosts.join(', ')}</span>;
}

/** Areas it reaches, as sentences. */
function reachesValue(uses: Array<{ words: string }>): string {
  return uses.length === 0
    ? "Nothing beyond its own tables, its own folder and its own tools' approvals."
    : uses.map((use) => `It ${use.words}.`).join(' ');
}

const errorText = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

/** A stage watched to its end. */
function useStageJob(id: string | null): { job: PluginJob | undefined; error: string | null } {
  const [job, setJob] = useState<PluginJob | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      setError(null);
      return undefined;
    }
    let stopped = false;
    const ask = (): void => {
      api
        .pluginJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          if (next.phase === 'done' || next.phase === 'failed') stopped = true;
        })
        .catch((err: unknown) => {
          if (stopped) return;
          setError(errorText(err));
          stopped = true;
        });
    };
    ask();
    const timer = window.setInterval(ask, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [id]);
  return { job, error };
}

/**
 * "Open" for each rail page a plugin contributes: the way to a page the owner
 * took off the rail (Settings → Appearance → In the rail), and a shortcut to
 * one that is still there.
 */
function OpenPages({
  plugin,
  pages,
  navigate,
  variant,
}: {
  plugin: string;
  pages: PluginPageDescriptor[];
  navigate?: ((route: string) => void) | undefined;
  variant?: 'ghost';
}): JSX.Element | null {
  const own = pages.filter((page) => page.plugin === plugin);
  if (own.length === 0) return null;
  return (
    <>
      {own.map((page) => {
        const route = pluginPageRoute(page.plugin, page.id);
        return (
          <ButtonLink
            key={page.id}
            size="sm"
            variant={variant}
            href={route}
            aria-label={`Open ${page.title}`}
            onClick={(event) => {
              // A row around it opens the detail; this goes to the page.
              event.stopPropagation();
              if (!navigate) return;
              event.preventDefault();
              navigate(route);
            }}
          >
            {own.length === 1 ? 'Open' : `Open ${page.title}`}
          </ButtonLink>
        );
      })}
    </>
  );
}

/** A plugin's state, in the tone it deserves. */
function StatePill({ plugin }: { plugin: InstalledPluginView }): JSX.Element {
  if (plugin.enabled === false) return <Pill>disabled</Pill>;
  // Held back by a requirement: what it needs first, named.
  const need = plugin.needs?.[0];
  if (need) return <Pill tone="warning">needs {need.plugin}</Pill>;
  // Installed or updated since buddi started: not a failure, a restart away.
  if (plugin.loadsAtRestart) return <Pill tone="accent">loads at restart</Pill>;
  if (plugin.loaded && plugin.setup) return <Pill tone="warning">needs setup</Pill>;
  return plugin.loaded ? (
    <Pill tone="good" dot>
      loaded
    </Pill>
  ) : (
    <Pill tone="critical">did not load</Pill>
  );
}

/** How a listing is trusted: published by buddi, or reviewed at a version. */
function TrustPill({ entry }: { entry: MarketEntryView }): JSX.Element {
  return entry.trust === 'by-buddi' ? (
    <Pill tone="accent">by buddi</Pill>
  ) : (
    <Pill tone="good">reviewed {entry.reviewed?.version ?? entry.version}</Pill>
  );
}

type PluginsTab = 'installed' | 'browse';

const PLUGINS_ROUTE = settingsRoute('plugins');
const TAB_ROUTES: Record<PluginsTab, string> = { installed: PLUGINS_ROUTE, browse: `${PLUGINS_ROUTE}?tab=browse` };

/** What the sheet is showing: an installed plugin, a listing, or a waiting stage (by id). */
type Opened = { kind: 'installed' | 'market' | 'staged'; name: string };
/** What the dialog is asking. */
type Asking = { kind: 'disable' | 'remove'; name: string };

export function Plugins({
  railPages = [],
  settingsPages = [],
  navigate,
  hash = '',
}: {
  /** The plugin pages whose place is the rail, hidden or not: each plugin's row opens its own. */
  railPages?: PluginPageDescriptor[];
  /** The plugin pages whose place is Settings: a plugin with one gets a Settings action. */
  settingsPages?: PluginPageDescriptor[];
  navigate?: (route: string) => void;
  /** The hash this section was opened on: `?tab=browse`, or a market link's `?install=`. */
  hash?: string;
} = {}): JSX.Element {
  const view = useAsync(() => api.plugins(), [], 20_000);
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, error: jobError } = useStageJob(jobId);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginsTab>(() => parsePluginsTab(hash));
  useEffect(() => setTab(parsePluginsTab(hash)), [hash]);
  const [kind, setKind] = useState<BrowseKind>(() => parseBrowseKind(hash));
  useEffect(() => setKind(parseBrowseKind(hash)), [hash]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  /** What the last disable, enable or remove said, and about which plugin. */
  const [said, setSaid] = useState<{ name: string; notes: string[] } | null>(null);

  /*
   * The market list is asked for the first time Browse opens, and not before:
   * it is the one thing on this page that reaches past this machine. Once
   * loaded it stays for the visit, and the Installed tab uses it for the
   * version an Update would bring and for each listed plugin's icon.
   */
  const [market, setMarket] = useState<MarketView | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const loadMarket = (refresh: boolean): void => {
    setMarketLoading(true);
    api
      .market(refresh)
      .then(setMarket)
      .catch((error: unknown) => setMarket({ plugins: [], unavailable: errorText(error) }))
      .finally(() => setMarketLoading(false));
  };
  useEffect(() => {
    if (tab === 'browse' && market === null && !marketLoading) loadMarket(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const onStaged = (id: string): void => {
    setFailed(null);
    setJobId(id);
  };
  const fail = (error: unknown): void => setFailed(errorText(error));
  const [stagingBusy, setStagingBusy] = useState(false);
  /** Install or update, from a listing or a row: stage it, then read the card on Installed. */
  const stageFrom = (work: Promise<{ job: PluginJob }>): void => {
    setStagingBusy(true);
    setOpened(null);
    work
      .then((answer) => {
        onStaged(answer.job.id);
        setTab('installed');
      })
      .catch(fail)
      .finally(() => setStagingBusy(false));
  };

  /*
   * A market link stages its spec once, on arrival, and the query is taken
   * off the hash so a reload or a back button does not stage it again.
   */
  const linked = useRef<string | null>(null);
  useEffect(() => {
    const spec = parsePluginsInstall(hash);
    if (spec === null || linked.current === spec) return;
    linked.current = spec;
    setTab('installed');
    stageFrom(api.stagePlugin(spec));
    try {
      window.history.replaceState(window.history.state, '', PLUGINS_ROUTE);
    } catch {
      // A history the browser will not rewrite leaves the query; the ref still stages once.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const choose = (next: PluginsTab) => (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    setTab(next);
    setOpened(null);
    navigate?.(TAB_ROUTES[next]);
  };

  // A finished stage puts a card on the page, which comes from the list.
  useEffect(() => {
    if (job?.phase === 'done' || job?.phase === 'failed') view.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase]);

  const data = view.data;
  const checkout = data?.checkout ?? true;
  const list = data?.installed ?? [];
  const listingOf = (plugin: InstalledPluginView): MarketEntryView | undefined =>
    market?.plugins.find((entry) => entry.installed !== undefined && (entry.installed.name ?? entry.name) === plugin.name);
  const hasPages = (name: string): boolean => railPages.some((page) => page.plugin === name);
  const openFor = (name: string, variant?: 'ghost'): ReactNode =>
    hasPages(name) ? <OpenPages plugin={name} pages={railPages} navigate={navigate} variant={variant} /> : undefined;
  const goToPage = (name: string): void => {
    const page = railPages.find((p) => p.plugin === name);
    if (page && navigate) navigate(pluginPageRoute(page.plugin, page.id));
  };
  /** Its settings page, when it ships one: the way to set a plugin up. */
  const settingsFor = (name: string): (() => void) | undefined => {
    const page = settingsPages.find((p) => p.plugin === name);
    if (!page || !navigate) return undefined;
    return () => navigate(pluginSettingsRoute(page.plugin, page.id));
  };
  const updates = (market?.plugins ?? []).filter((entry) => entry.update).length;

  /** Disable or enable: it takes effect at once, so the rail reads its pages again. */
  const toggle = (name: string, enabled: boolean): Promise<void> =>
    api.setPluginEnabled(name, enabled).then((reply) => {
      announcePagesChanged();
      setSaid({ name, notes: reply.notes ?? [] });
      view.reload();
    });
  const remove = (name: string, purge: boolean, confirm: string): Promise<void> =>
    api.uninstallPlugin(name, purge ? { purge: true, confirm } : {}).then((reply) => {
      setOpened(null);
      setSaid({ name, notes: reply.notes ?? [] });
      view.reload();
    });
  const enable = (name: string): void => {
    setFailed(null);
    toggle(name, true).catch(fail);
  };
  /*
   * A listed version comes from npm whatever the installed copy came from: a
   * plugin installed from a directory, once it is on withbuddi.com, moves to
   * the published package. Without a listing the update follows its source.
   */
  const update = (name: string, version?: string): void => {
    const listed = market?.plugins.find((entry) => (entry.installed?.name ?? entry.name) === name && entry.installed !== undefined);
    const from = listed && version ? `${listed.npm}@${version}` : undefined;
    stageFrom(from ? api.updatePlugin(name, version, from) : api.updatePlugin(name, version));
  };

  /*
   * A requirement that is not installed: read it from withbuddi.com, the way
   * Browse's Install does — the card, then the two yeses. The list is asked
   * for here when Browse never was, because the owner just asked for it.
   */
  const installFirst = (name: string): void => {
    setFailed(null);
    const stage = (list: MarketView): void => {
      const entry = list.plugins.find((e) => e.name === name || e.installed?.name === name);
      if (!entry) {
        setFailed(`${name} is not listed on withbuddi.com. Add it from npm, a file or a directory above, then install this one.`);
        return;
      }
      stageFrom(api.stagePlugin(`${entry.npm}@${entry.version}`));
    };
    if (market && market.plugins.length > 0) return stage(market);
    setStagingBusy(true);
    api
      .market(false)
      .then((list) => {
        setMarket(list);
        stage(list);
      })
      .catch(fail)
      .finally(() => setStagingBusy(false));
  };
  const routeOf = (plugin: string, page: { id: string; place: 'rail' | 'settings' } | undefined): string | undefined =>
    page === undefined ? undefined : page.place === 'settings' ? pluginSettingsRoute(plugin, page.id) : pluginPageRoute(plugin, page.id);
  /** The one thing that would let a waiting plugin start: its own setup, or what it requires. */
  const firstStepFor = (plugin: InstalledPluginView): { label: string; run: () => void } | undefined => {
    if (plugin.enabled === false) return undefined;
    const need = plugin.needs?.[0];
    if (need) {
      switch (need.state) {
        case 'missing':
          return { label: `Install ${need.plugin}`, run: () => installFirst(need.plugin) };
        case 'disabled':
          return { label: `Enable ${need.plugin}`, run: () => enable(need.plugin) };
        case 'range':
          return { label: `Update ${need.plugin}`, run: () => update(need.plugin) };
        case 'setup': {
          const route = routeOf(need.plugin, need.page);
          const go = route && navigate ? () => navigate(route) : settingsFor(need.plugin);
          return go ? { label: `Set up ${need.plugin}`, run: go } : undefined;
        }
        default:
          return { label: `See ${need.plugin}`, run: () => setOpened({ kind: 'installed', name: need.plugin }) };
      }
    }
    if (plugin.loaded && plugin.setup) {
      const route = routeOf(plugin.name, plugin.setup.page);
      const go = route && navigate ? () => navigate(route) : settingsFor(plugin.name);
      return go ? { label: 'Set it up', run: go } : undefined;
    }
    return undefined;
  };

  const tabs = (
    <Tabs label="Plugins">
      <Tab href={TAB_ROUTES.installed} active={tab === 'installed'} count={updates} onClick={choose('installed')}>
        Installed
      </Tab>
      <Tab href={TAB_ROUTES.browse} active={tab === 'browse'} onClick={choose('browse')}>
        Browse
      </Tab>
    </Tabs>
  );

  const allStaged = data?.staged ?? [];
  const freshId = freshStageId(allStaged, job?.phase === 'done' ? job.stagedId : undefined);
  const fresh = allStaged.find((entry) => entry.id === freshId);
  const waiting = allStaged.filter((entry) => entry.id !== freshId);
  const onStagedInstalled = (name: string): void => {
    setOpened(null);
    rememberInstalled(name);
    setJobId(null);
    view.reload();
  };
  const openedStage = opened?.kind === 'staged' ? waiting.find((entry) => entry.id === opened.name) : undefined;
  const openedPlugin = opened?.kind === 'installed' ? list.find((p) => p.name === opened.name) : undefined;
  const openedEntry =
    opened?.kind === 'market' ? market?.plugins.find((entry) => entry.name === opened.name) : undefined;
  const pageNotes = said && !(openedPlugin && openedPlugin.name === said.name) && said.notes.length > 0 ? said.notes : null;

  const sheet = openedStage ? (
    <StagedSheet
      key={openedStage.id}
      staged={openedStage}
      onClose={() => setOpened(null)}
      onInstalled={onStagedInstalled}
      onInstallFirst={installFirst}
      onGone={() => {
        setOpened(null);
        view.reload();
      }}
    />
  ) : openedPlugin ? (
    <InstalledSheet
      plugin={openedPlugin}
      listing={listingOf(openedPlugin)}
      notes={said?.name === openedPlugin.name ? said.notes : null}
      canOpen={hasPages(openedPlugin.name) && openedPlugin.enabled !== false}
      onOpen={() => goToPage(openedPlugin.name)}
      onClose={() => setOpened(null)}
      onDisable={() => setAsking({ kind: 'disable', name: openedPlugin.name })}
      onEnable={() => enable(openedPlugin.name)}
      onRemove={() => setAsking({ kind: 'remove', name: openedPlugin.name })}
      onUpdate={(version) => update(openedPlugin.name, version)}
      onSettings={openedPlugin.enabled === false ? undefined : settingsFor(openedPlugin.name)}
      firstStep={firstStepFor(openedPlugin)}
      busy={stagingBusy}
    />
  ) : openedEntry ? (
    <ListingSheet
      entry={openedEntry}
      canOpen={openedEntry.installed !== undefined && hasPages(openedEntry.installed.name ?? openedEntry.name)}
      onOpen={() => goToPage(openedEntry.installed?.name ?? openedEntry.name)}
      onClose={() => setOpened(null)}
      onInstall={() => stageFrom(api.stagePlugin(`${openedEntry.npm}@${openedEntry.version}`))}
      onUpdate={(version) => update(openedEntry.installed?.name ?? openedEntry.name, version)}
      busy={stagingBusy}
    />
  ) : null;

  const askingPlugin = asking ? list.find((p) => p.name === asking.name) : undefined;
  const dialog = asking ? (
    <Confirm
      key={`${asking.kind}:${asking.name}`}
      kind={asking.kind}
      name={asking.name}
      canDisable={askingPlugin?.enabled !== false}
      onCancel={() => setAsking(null)}
      onDisableInstead={() => setAsking({ kind: 'disable', name: asking.name })}
      onDisable={() => toggle(asking.name, false).then(() => setAsking(null))}
      onRemove={(purge, confirm) => remove(asking.name, purge, confirm).then(() => setAsking(null))}
    />
  ) : null;

  if (tab === 'browse') {
    return (
      <Stack gap="lg">
        <NotAConnection />
        {tabs}
        <ErrorBanner message={failed} />
        <Browse
          kind={kind}
          onKind={setKind}
          navigate={navigate}
          market={market}
          loading={marketLoading}
          busy={stagingBusy}
          onRetry={() => loadMarket(true)}
          onOpen={(entry) => setOpened({ kind: 'market', name: entry.name })}
          onInstall={(entry) => stageFrom(api.stagePlugin(`${entry.npm}@${entry.version}`))}
          onUpdate={(entry, version) => update(entry.installed?.name ?? entry.name, version)}
        />
        {sheet}
      </Stack>
    );
  }

  const builtIn = data?.builtIn ?? [];
  return (
    <Stack gap="lg">
      <NotAConnection />
      {tabs}
      <ErrorBanner message={view.error ?? failed ?? jobError} />
      {data?.unavailable ? <Notice tone="warning">{data.unavailable}</Notice> : null}
      {pageNotes ? <Notice role="status">{pageNotes.join(' ')}</Notice> : null}

      <AddPlugin
        trust={data?.trust ?? ''}
        job={job}
        busy={job !== undefined && job.phase !== 'done' && job.phase !== 'failed'}
        onStaged={onStaged}
        onFailed={setFailed}
      />

      {fresh ? (
        <Staged key={fresh.id} staged={fresh} onInstalled={onStagedInstalled} onGone={() => view.reload()} onInstallFirst={installFirst} />
      ) : null}

      {waiting.length > 0 ? (
        <Panel flush title="Waiting for you" tool={plural(waiting.length, 'package', 'packages')}>
          <div className="plugins-rows">
            <List>
              {waiting.map((staged) => (
                <WaitingRow
                  key={staged.id}
                  staged={staged}
                  onReview={() => {
                    tellOpened(staged);
                    setOpened({ kind: 'staged', name: staged.id });
                  }}
                  onReject={() => {
                    setFailed(null);
                    api
                      .rejectStaged(staged.id)
                      .then(() => view.reload())
                      .catch(fail);
                  }}
                />
              ))}
            </List>
          </div>
        </Panel>
      ) : null}

      {data?.restartNeeded ? <RestartToLoad checkout={checkout} waiting={list.filter((plugin) => plugin.loadsAtRestart)} /> : null}
      <FirstStep list={list} firstStepFor={firstStepFor} />

      <Panel flush title="Installed" tool={data ? plural(list.length, 'plugin', 'plugins') : undefined}>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : list.length === 0 ? (
          <Empty>Nothing installed yet. Only what buddi ships with is here.</Empty>
        ) : (
          <div className="plugins-rows">
            <List>
              {list.map((plugin) => (
                <InstalledRow
                  key={plugin.name}
                  plugin={plugin}
                  listing={listingOf(plugin)}
                  open={plugin.enabled === false ? undefined : openFor(plugin.name, 'ghost')}
                  canOpen={hasPages(plugin.name) && plugin.enabled !== false}
                  busy={stagingBusy}
                  onDetails={() => setOpened({ kind: 'installed', name: plugin.name })}
                  onOpen={() => goToPage(plugin.name)}
                  onSettings={plugin.enabled === false ? undefined : settingsFor(plugin.name)}
                  onDisable={() => setAsking({ kind: 'disable', name: plugin.name })}
                  onEnable={() => enable(plugin.name)}
                  onRemove={() => setAsking({ kind: 'remove', name: plugin.name })}
                  onUpdate={(version) => update(plugin.name, version)}
                  firstStep={firstStepFor(plugin)}
                />
              ))}
            </List>
          </div>
        )}
      </Panel>

      {builtIn.length > 0 ? <ShipsWithBuddi plugins={builtIn} openFor={openFor} /> : null}
      {sheet}
      {dialog}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * Asking for one
 * ------------------------------------------------------------------ */

/** The one quiet panel that starts an install: where it comes from, one field, one button. */
function AddPlugin({
  trust,
  job,
  busy,
  onStaged,
  onFailed,
}: {
  trust: string;
  job: PluginJob | undefined;
  busy: boolean;
  onStaged: (jobId: string) => void;
  onFailed: (message: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<InstallMode>(rememberedMode);
  const [spec, setSpec] = useState('');
  const [sending, setSending] = useState(false);
  /** The file the zone is holding, and why it is holding none. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  const fail = (error: unknown): void => onFailed(errorText(error));

  const choose = (next: InstallMode): void => {
    setMode(next);
    rememberMode(next);
    setRefused(null);
  };

  const go = (): void => {
    setSending(true);
    api
      .stagePlugin(spec.trim())
      .then((answer) => {
        onStaged(answer.job.id);
        setSpec('');
      })
      .catch(fail)
      .finally(() => setSending(false));
  };

  /*
   * A picked or dropped file is the whole act: there is nothing left to type,
   * so the upload — and with it the read — starts here rather than behind a
   * second click. A file that is not a .tgz never leaves the browser.
   */
  const take = (file: File | undefined): void => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(PLUGIN_SUFFIX)) {
      setChosen(null);
      setRefused(`${file.name} is not a ${PLUGIN_SUFFIX}. A packed plugin is the file npm pack writes.`);
      return;
    }
    setRefused(null);
    setChosen(file.name);
    setSending(true);
    api
      .uploadPlugin(file)
      .then((answer) => onStaged(answer.job.id))
      .catch(fail)
      .finally(() => setSending(false));
  };

  return (
    <Panel
      title="Add a plugin"
      actions={<Segment<InstallMode> label="Where it comes from" options={MODES} value={mode} onChange={choose} />}
    >
      <div className="plugins-add">
        {mode === 'file' ? (
          <div
            className="plugins-drop"
            role="group"
            aria-label="A plugin file"
            data-state={over ? 'over' : refused ? 'refused' : chosen ? 'chosen' : undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              take(event.dataTransfer?.files?.[0]);
            }}
          >
            <Icon name="drop" size={20} />
            <span className="plugins-drop-text">
              {refused ??
                (chosen ? (
                  `${chosen} — reading it.`
                ) : (
                  <>
                    Drop a <span className="mono">{PLUGIN_SUFFIX}</span> here: the file <span className="mono">npm pack</span>{' '}
                    writes. It is read the moment it lands.
                  </>
                ))}
            </span>
            <Button variant="accent" disabled={busy || sending} onClick={() => picker.current?.click()}>
              Choose a file
            </Button>
            <input
              ref={picker}
              type="file"
              accept={PLUGIN_SUFFIX}
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                take(event.target.files?.[0]);
                // So picking the same file twice still counts as picking it.
                event.target.value = '';
              }}
            />
          </div>
        ) : (
          <div className="plugins-add-row">
            <Toolbar valign="end">
              <Field grow label={mode === 'npm' ? 'Package' : 'The directory it is in'}>
                <input
                  type="text"
                  value={spec}
                  placeholder={mode === 'npm' ? 'buddi-plugin-weather' : '/home/you/code/buddi-plugin-weather'}
                  onChange={(event) => setSpec(event.target.value)}
                />
              </Field>
              {mode === 'directory' ? <Button onClick={() => setBrowsing(true)}>Browse…</Button> : null}
              <Button variant="accent" disabled={busy || sending || spec.trim() === ''} onClick={go}>
                Read it first
              </Button>
            </Toolbar>
            <span className="ui-field-hint">
              {mode === 'npm'
                ? 'A package name, or a name@version. Reading fetches it and hashes it; nothing of it runs.'
                : 'The folder with its package.json, already built. Nothing of it runs until you say yes.'}
            </span>
          </div>
        )}
        {job ? (
          <p className="plugins-status" role="status" data-tone={job.phase === 'failed' ? 'critical' : undefined}>
            {PHASE_WORDS[job.phase]} {job.error ?? ''}
          </p>
        ) : null}
        {/* Verbatim, never paraphrased: it is what the two approvals are approving. */}
        <div className="plugins-trust">
          <Notice tone="warning">{trust}</Notice>
        </div>
      </div>
      {browsing ? (
        <PluginFolders
          start={spec.trim().startsWith('/') ? spec.trim() : undefined}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setSpec(path);
            setBrowsing(false);
          }}
        />
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * A staged package, and the two approvals
 * ------------------------------------------------------------------ */

/**
 * What it reaches in buddi beyond itself, one plain sentence each — read from
 * its package.json, before anything of it runs. On an update, what this
 * version adds is marked, and what it no longer asks for is said.
 */
function StagedUses({ staged }: { staged: StagedPluginView }): JSX.Element {
  const areas = staged.uses?.areas ?? [];
  const dropped = staged.uses?.dropped ?? [];
  return (
    <span className="plugins-uses">
      {areas.length === 0
        ? reachesValue([])
        : areas.map((area) => (
            <span key={area.use}>
              It {area.words}. {area.added ? <Pill tone="warning">new in {staged.version}</Pill> : null}
            </span>
          ))}
      {dropped.length > 0 ? <span className="muted">No longer: {dropped.map((area) => area.words).join('; ')}.</span> : null}
    </span>
  );
}

/** Approving and rejecting one stage: the card's and the sheet's answers. */
function useStagedDecision(
  staged: StagedPluginView,
  onInstalled: (name: string) => void,
  onGone: () => void,
): {
  plan: PluginPlan | null;
  busy: boolean;
  failed: string | null;
  approve: (acknowledgeDrift: boolean) => void;
  reject: () => void;
} {
  const [plan, setPlan] = useState<PluginPlan | null>(staged.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * The hash the card is showing goes back with the approval. The server
   * refuses when it is not the one on disk, which is what stops a click aimed
   * at one package approving another.
   */
  const approve = (acknowledgeDrift: boolean): void => {
    setBusy(true);
    setFailed(null);
    api
      .approveStaged(staged.id, {
        /*
         * Always sent, empty string included. A directory source has no
         * integrity at all, and dropping the field for it — which is what a
         * falsy check did — made the server answer "send back the integrity
         * you were shown" to a card that was showing none.
         */
        integrity: staged.integrity ?? '',
        ...(acknowledgeDrift ? { acknowledgeDrift: true } : {}),
      })
      .then((answer) => {
        if (answer.installed) onInstalled(staged.name);
        else if (answer.plan) setPlan(answer.plan);
      })
      .catch((error: unknown) => setFailed(errorText(error)))
      .finally(() => setBusy(false));
  };

  const reject = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .rejectStaged(staged.id)
      .then(() => onGone())
      .catch((error: unknown) => setFailed(errorText(error)))
      .finally(() => setBusy(false));
  };

  return { plan, busy, failed, approve, reject };
}

/**
 * Tell the gateway the owner has seen this stage: an opened stage is kept a
 * day instead of two hours. The server keeps only the first time, so saying
 * it twice is harmless; losing the call costs nothing worse than two hours.
 */
function tellOpened(staged: StagedPluginView): void {
  if (staged.openedAt) return;
  void api.openedStaged(staged.id).catch(() => {});
}

/** What a read package is and what it says about itself: the card's body, and the sheet's. */
/**
 * What a staged package requires, each with where it stands here; a missing
 * one offers to install it first, through the same read-then-approve.
 */
function StagedRequires({ staged, onInstallFirst }: { staged: StagedPluginView; onInstallFirst?: ((name: string) => void) | undefined }): JSX.Element {
  return (
    <span className="plugins-requires">
      {(staged.requires ?? []).map((need) => (
        <span key={need.plugin} className="plugins-require">
          <span title={need.range}>
            <span className="mono">{need.plugin}</span> {need.rangeWords ?? need.range}
          </span>
          {need.state === 'ok' ? (
            <span className="plugins-require-ok">{need.installed ? `${need.installed} is here` : 'here'}</span>
          ) : need.state === 'missing' ? (
            <>
              <Pill tone="warning">not installed</Pill>
              {onInstallFirst ? (
                <Button size="sm" onClick={() => onInstallFirst(need.plugin)}>
                  Install {need.plugin} first
                </Button>
              ) : null}
            </>
          ) : (
            <Pill tone="warning">
              {need.state === 'disabled'
                ? 'disabled here'
                : need.state === 'range'
                  ? `${need.installed ?? 'another version'} is here`
                  : need.state === 'failed'
                    ? 'did not load here'
                    : 'waiting here'}
            </Pill>
          )}
        </span>
      ))}
      {(staged.requires ?? []).some((need) => need.state !== 'ok') ? (
        <span className="muted">It installs either way, and waits — tools and widgets off, nothing lost — until each is here and set up.</span>
      ) : null}
    </span>
  );
}

function StagedFacts({
  staged,
  inSheet,
  onInstallFirst,
}: {
  staged: StagedPluginView;
  inSheet?: boolean;
  onInstallFirst?: ((name: string) => void) | undefined;
}): JSX.Element {
  const deps = staged.dependencies;
  return (
    <div className="plugins-staged" data-in={inSheet ? 'sheet' : undefined}>
      <div className="plugins-facts">
        <KV
          items={[
            ...(staged.author ? [{ label: 'By', value: <AuthorName author={staged.author} /> }] : []),
            {
              label: 'From',
              value: staged.uploadedName ? `a file you chose · ${staged.uploadedName}` : sourceWords(staged.source),
            },
            { label: 'Published by', value: publisherWords(staged.source, staged.publisher) },
            ...(staged.previousSource && staged.previous
              ? [{ label: 'Replaces', value: `${staged.previous.version}, installed from ${sourceWords(staged.previousSource)}` }]
              : staged.source.kind === 'directory' && staged.previous?.version === staged.version
                ? [{ label: 'Reinstalls', value: `${staged.version}, the same version, its files read again from the folder` }]
                : []),
            ...(staged.source.kind === 'directory'
              ? []
              : [
                  {
                    label: 'Installs as',
                    value: staged.installsAs ? (
                      <span className="mono">{staged.installsAs}</span>
                    ) : (
                      'the name its manifest gives, read when you approve — it declares no buddi.name'
                    ),
                  },
                ]),
            ...(staged.coreAsDependency
              ? [{ label: 'Core', value: "It asks npm for buddi's core; buddi provides its own." }]
              : []),
            {
              label: 'Dependencies',
              value:
                deps.count === 0
                  ? 'none'
                  : `${deps.count}${
                      deps.withScripts.length === 0
                        ? ', none of which run install scripts'
                        : `, of which these run install scripts: ${deps.withScripts.join(', ')}`
                    }`,
            },
            { label: 'What it reaches', value: <StagedUses staged={staged} /> },
            ...((staged.requires ?? []).length > 0
              ? [{ label: 'Needs', value: <StagedRequires staged={staged} onInstallFirst={onInstallFirst} /> }]
              : []),
            { label: 'Integrity', value: <Hash value={staged.integrity} /> },
            ...(staged.stagedHash ? [{ label: 'Files on disk', value: <Hash value={staged.stagedHash} /> }] : []),
          ]}
        />
      </div>
      <div className="plugins-claim">
        <div className="plugins-claim-head">What it says about itself</div>
        <div className="plugins-claim-note">From its own buddi.md. Nothing has checked it yet.</div>
        {staged.claims.missing ? (
          <p className="plugins-claim-text">It ships no buddi.md, so it says nothing about itself at all.</p>
        ) : (
          <p className="plugins-claim-text">“{staged.claims.text}”</p>
        )}
        <div className="plugins-facts">
          <KV
            items={[
              {
                label: 'Schema it owns',
                value: staged.claims.schema ? <span className="mono">{staged.claims.schema}</span> : 'it claims none',
              },
              {
                label: 'Hosts it reaches',
                value:
                  staged.claims.hosts.length === 0 ? (
                    'it claims none'
                  ) : (
                    <span className="mono">{staged.claims.hosts.join(', ')}</span>
                  ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/** The second card: the package's prose and its manifest disagree. */
function DriftCard({
  plan,
  busy,
  onReject,
  onInstallAnyway,
}: {
  plan: PluginPlan;
  busy: boolean;
  onReject: () => void;
  onInstallAnyway: () => void;
}): JSX.Element {
  return (
    <Card
      tone="warning"
      title="What it said, and what it does"
      meta={<Pill tone="warning">read this first</Pill>}
      foot={
        <Toolbar>
          <span className="plugins-foot-note">Install anyway says you read these.</span>
          <Spacer />
          <Button variant="ghost" disabled={busy} onClick={onReject}>
            Not this one
          </Button>
          <Button variant="danger" disabled={busy} onClick={onInstallAnyway}>
            Install anyway
          </Button>
        </Toolbar>
      }
    >
      <p className="plugins-note">
        Its prose and its manifest do not agree. Neither is authoritative; the manifest is what actually runs.
      </p>
      <ul className="plugins-drift">
        {plan.drift.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Unlocks unlocks={plan.agents ?? []} />
    </Card>
  );
}

/**
 * The package the owner just read: the facts, and the first yes. Only that
 * one is drawn as a card; anything else waiting is a row (`WaitingRow`).
 */
function Staged({
  staged,
  onInstalled,
  onGone,
  onInstallFirst,
}: {
  staged: StagedPluginView;
  onInstalled: (name: string) => void;
  onGone: () => void;
  onInstallFirst?: (name: string) => void;
}): JSX.Element {
  const { plan, busy, failed, approve, reject } = useStagedDecision(staged, onInstalled, onGone);
  // Shown in full is seen: it is kept a day.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => tellOpened(staged), [staged.id]);
  const drift = plan?.drift ?? [];
  return (
    <Stack gap="sm">
      <Card
        tone="accent"
        title={
          <>
            {staged.name} <span className="plugins-ver">{staged.version}</span>
          </>
        }
        meta={<Pill>read, not installed</Pill>}
        foot={
          <Toolbar>
            <span className="plugins-foot-note">Nothing of it has run.</span>
            <Spacer />
            <Button variant="ghost" disabled={busy} onClick={reject}>
              Not this one
            </Button>
            <Button variant="accent" disabled={busy || drift.length > 0} onClick={() => approve(false)}>
              Install
            </Button>
          </Toolbar>
        }
      >
        <ErrorBanner message={failed} />
        <StagedFacts staged={staged} onInstallFirst={onInstallFirst} />
      </Card>

      {plan && drift.length > 0 ? (
        <DriftCard plan={plan} busy={busy} onReject={reject} onInstallAnyway={() => approve(true)} />
      ) : null}
    </Stack>
  );
}

/** Read earlier, not decided on: one row, in the Installed list's style. */
function WaitingRow({
  staged,
  onReview,
  onReject,
}: {
  staged: StagedPluginView;
  onReview: () => void;
  onReject: () => void;
}): JSX.Element {
  const read = fmtRelative(staged.createdAt);
  return (
    <ListRow
      onClick={onReview}
      label={`${staged.name}: review`}
      lead={<AppIcon svg={undefined} />}
      title={
        <>
          {staged.name} <span className="plugins-ver">{staged.version}</span>
        </>
      }
      sub={`from ${sourceShort(staged.source)}${read ? ` · read ${read}` : ''}`}
      side={
        <span className="plugins-side">
          {/* Below 720px only Review stays on the row; the sheet has Not this one. */}
          <span className="plugins-wait-extra">
            <Pill>read, not installed</Pill>
            <Button size="sm" variant="ghost" onClick={stop(onReject)}>
              Not this one
            </Button>
          </span>
          <Button size="sm" onClick={stop(onReview)}>
            Review
          </Button>
        </span>
      }
    />
  );
}

/** Review: the full card of one waiting package, in the sheet, with its two answers. */
function StagedSheet({
  staged,
  onClose,
  onInstalled,
  onGone,
  onInstallFirst,
}: {
  staged: StagedPluginView;
  onClose: () => void;
  onInstalled: (name: string) => void;
  onGone: () => void;
  onInstallFirst?: (name: string) => void;
}): JSX.Element {
  const { plan, busy, failed, approve, reject } = useStagedDecision(staged, onInstalled, onGone);
  const drift = plan?.drift ?? [];
  return (
    <Sheet
      title={
        <SheetTitle
          svg={undefined}
          name={staged.name}
          version={staged.version}
          by={staged.author ? <AuthorName author={staged.author} /> : publisherWords(staged.source, staged.publisher)}
          pills={
            <>
              {' · '}
              <Pill>read, not installed</Pill>
            </>
          }
        />
      }
      onClose={onClose}
      foot={
        <Toolbar>
          <span className="plugins-foot-note">Nothing of it has run.</span>
          <Spacer />
          <Button variant="ghost" disabled={busy} onClick={reject}>
            Not this one
          </Button>
          <Button variant="accent" disabled={busy || drift.length > 0} onClick={() => approve(false)}>
            Install
          </Button>
        </Toolbar>
      }
    >
      <ErrorBanner message={failed} />
      <StagedFacts staged={staged} inSheet onInstallFirst={onInstallFirst} />
      {plan && drift.length > 0 ? (
        <DriftCard plan={plan} busy={busy} onReject={reject} onInstallAnyway={() => approve(true)} />
      ) : null}
    </Sheet>
  );
}

/** How recent a stage must be to open as the card when this visit did not make it. */
const FRESH_MS = 10 * 60 * 1000;

/**
 * The one stage drawn as the full card: the one this visit's own "Read it
 * first" or install made, or else the newest, if it was read minutes ago.
 */
export function freshStageId(staged: StagedPluginView[], ownId: string | undefined, now = Date.now()): string | null {
  if (ownId && staged.some((entry) => entry.id === ownId)) return ownId;
  const newest = [...staged].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  if (!newest?.createdAt) return null;
  const age = now - Date.parse(newest.createdAt);
  return Number.isFinite(age) && age < FRESH_MS ? newest.id : null;
}

/* ------------------------------------------------------------------ *
 * After an install
 * ------------------------------------------------------------------ */

/**
 * The restart that actually loads it.
 *
 * Drawn from what the gateway says — `restartNeeded`, and each plugin whose
 * installed version this process has not loaded — never from what this page
 * remembers doing, so it is gone the moment the plugins are loaded. A packaged
 * installation restarts through the supervisor, under "Restarting buddi"
 * (`shell/Restarting.tsx`), which reloads the page once buddi is back. A
 * checkout has no supervisor and gets the command.
 */
function RestartToLoad({ checkout, waiting }: { checkout: boolean; waiting: InstalledPluginView[] }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const named = pluginWords(waiting);
  const what = named
    ? `${named} ${waiting.length === 1 ? 'is' : 'are'} installed.`
    : 'A plugin was installed, disabled or enabled since buddi started, and this buddi has not caught up.';
  return (
    <Stack gap="sm">
      <ErrorBanner message={failed} />
      <Notice
        tone={checkout ? 'warning' : 'accent'}
        role="status"
        action={
          checkout ? undefined : (
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(null);
                void restartWhile(
                  { kind: 'plugins', ...(named ? { line: `Loading ${named}…` } : { line: 'Applying your plugin changes…' }) },
                  () => api.serviceAction('restart'),
                )
                  .catch((error: unknown) => setFailed(errorText(error)))
                  .finally(() => setBusy(false));
              }}
            >
              Restart to load it
            </Button>
          )
        }
      >
        {what}{' '}
        {checkout
          ? CHECKOUT_RESTART
          : `${named ? (waiting.length === 1 ? 'Its tools appear' : 'Their tools appear') : 'It takes effect'} once buddi restarts, which takes a few seconds. This page waits and comes back by itself.`}
      </Notice>
    </Stack>
  );
}

/** Where the plugin just installed is remembered across the restart that loads it. */
const JUST_INSTALLED_KEY = 'buddi.plugins.justInstalled';

function rememberInstalled(name: string): void {
  try {
    window.sessionStorage.setItem(JUST_INSTALLED_KEY, name);
  } catch {
    // No session storage: no first-step notice after the restart, nothing worse.
  }
}

function justInstalled(): string | null {
  try {
    return window.sessionStorage.getItem(JUST_INSTALLED_KEY);
  } catch {
    return null;
  }
}

/**
 * After the restart that loads a plugin: what to do first, when it says it
 * cannot do anything yet or waits for another. Said once; Later or the step
 * itself puts it away, and a plugin that is simply loaded says nothing.
 */
function FirstStep({
  list,
  firstStepFor,
}: {
  list: InstalledPluginView[];
  firstStepFor: (plugin: InstalledPluginView) => { label: string; run: () => void } | undefined;
}): JSX.Element | null {
  const [name, setName] = useState<string | null>(() => justInstalled());
  const plugin = name ? list.find((p) => p.name === name) : undefined;
  const settled = plugin !== undefined && (plugin.loaded || plugin.needs !== undefined);
  const waits = settled && (plugin.needs !== undefined || plugin.setup !== undefined);
  const done = (): void => {
    try {
      window.sessionStorage.removeItem(JUST_INSTALLED_KEY);
    } catch {
      // Nothing kept, nothing to forget.
    }
    setName(null);
  };
  useEffect(() => {
    // Loaded and ready: nothing to say, and nothing to remember.
    if (settled && !waits) done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, waits]);
  if (!plugin || !waits) return null;
  const step = firstStepFor(plugin);
  return (
    <Notice
      tone="accent"
      role="status"
      action={
        <>
          <Button size="sm" variant="ghost" onClick={done}>Later</Button>
          {step ? (
            <Button size="sm" variant="accent" onClick={() => { done(); step.run(); }}>
              {step.label}
            </Button>
          ) : null}
        </>
      }
    >
      {plugin.needs ? `${plugin.name} is installed and waits. ${waitingWords(plugin)}.` : `${plugin.name} is loaded. First: ${plugin.setup?.note ?? 'set it up on its settings page.'}`}
    </Notice>
  );
}

/* ------------------------------------------------------------------ *
 * What is installed
 * ------------------------------------------------------------------ */

/** Buttons inside a clickable row keep the click to themselves. */
const stop =
  (fn: () => void) =>
  (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
    fn();
  };

/** How many of its agents the owner has not accepted yet. */
const pendingUnlocks = (plugin: InstalledPluginView): number =>
  plugin.unlocks.filter((unlock) => unlock.drift.state === 'not-accepted').length;

/** A waiting plugin's line: what to do first, or what it lacks. */
function waitingWords(plugin: InstalledPluginView): string {
  if (plugin.needs && plugin.needs.length > 0) {
    return plugin.needs.map((need) => (need.state === 'setup' && need.note ? `${need.words}: ${need.note}` : need.words)).join(' · ');
  }
  return plugin.setup?.note ?? 'Not set up yet. Its settings say what it needs.';
}

function InstalledRow({
  plugin,
  listing,
  open,
  canOpen,
  busy,
  onDetails,
  onOpen,
  onSettings,
  onDisable,
  onEnable,
  onRemove,
  onUpdate,
  firstStep,
}: {
  plugin: InstalledPluginView;
  /** Its listing on withbuddi.com, once Browse was opened and found it. */
  listing: MarketEntryView | undefined;
  /** Its rail pages' Open buttons, when it has any and is on. */
  open: ReactNode;
  canOpen: boolean;
  busy: boolean;
  onDetails: () => void;
  onOpen: () => void;
  /** Its settings page, when it ships one and is on. */
  onSettings?: (() => void) | undefined;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
  /** No version: reread it from where it came (a folder: the same version too). */
  onUpdate: (version?: string) => void;
  /** Its first step when it waits: set itself up, or get what it requires. */
  firstStep?: { label: string; run: () => void } | undefined;
}): JSX.Element {
  const disabled = plugin.enabled === false;
  const pending = pendingUnlocks(plugin);
  const waiting = !disabled && (plugin.needs !== undefined || (plugin.loaded && plugin.setup !== undefined));
  return (
    <ListRow
      onClick={onDetails}
      label={`${plugin.name}: details`}
      dimmed={disabled}
      lead={<AppIcon svg={listing?.iconSvg} />}
      title={
        <>
          {plugin.name} <span className="plugins-ver">{plugin.version}</span>
          {pending > 0 ? <span className="plugins-ask">{plural(pending, 'agent', 'agents')} to accept</span> : null}
        </>
      }
      sub={
        waiting ? (
          <span className="plugins-sub" data-tone="warning">{waitingWords(plugin)}</span>
        ) : (
          `by ${byWords(plugin)} · from ${sourceShort(plugin.source)} · ${contributionWords(plugin.contribution)}`
        )
      }
      side={
        <span className="plugins-side">
          {waiting && firstStep ? (
            <Button size="sm" onClick={stop(firstStep.run)}>
              {firstStep.label}
            </Button>
          ) : null}
          {listing?.update ? (
            <Button size="sm" disabled={busy} onClick={stop(() => onUpdate(listing.update as string))}>
              Update to {listing.update}
            </Button>
          ) : null}
          {waiting ? null : open}
          {/* A plugin with no page of its own but a settings tab is set up there. */}
          {!waiting && !canOpen && onSettings ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation(); // the row underneath opens the detail
                onSettings();
              }}
            >
              Settings
            </Button>
          ) : null}
          <StatePill plugin={plugin} />
          <ActionMenu
            label={`More for ${plugin.name}`}
            items={[
              { label: 'Details', onSelect: onDetails },
              canOpen ? { label: 'Open its page', onSelect: onOpen } : null,
              onSettings ? { label: 'Its settings', onSelect: onSettings } : null,
              // A folder you build in: read it again, the same version included.
              plugin.source.kind === 'directory' && !busy
                ? { label: 'Reinstall from folder', hint: 'reads its files again', onSelect: () => onUpdate() }
                : null,
              disabled
                ? { label: 'Enable', hint: 'all of it comes back', onSelect: onEnable }
                : { label: 'Disable…', hint: 'keeps its data', onSelect: onDisable },
              'separator',
              { label: 'Remove…', tone: 'critical', onSelect: onRemove },
            ]}
          />
        </span>
      }
    />
  );
}

/** The words and tone for where an agent a plugin proposes stands. */
const DRIFT_WORDS: Record<PluginDrift['state'], [Tone | undefined, string]> = {
  'not-accepted': ['warning', 'not accepted'],
  'up-to-date': ['good', 'up to date'],
  'owner-edited': ['accent', 'yours, edited'],
  'proposal-changed': ['warning', 'proposal changed'],
  'owner-edited-and-proposal-changed': ['warning', 'edited, and changed'],
  gone: [undefined, 'gone'],
};

/**
 * The agents a plugin proposes, and where the owner's copy stands.
 *
 * `plugin` is the installed plugin's name, and it is what makes each row
 * actionable: a staged package proposes agents too, but nothing of it is
 * installed yet, so there those rows are a list and nothing more.
 */
function Unlocks({ plugin, unlocks }: { plugin?: string; unlocks: PluginUnlock[] }): JSX.Element | null {
  if (unlocks.length === 0) return null;
  return (
    <Section title="Agents it would unlock">
      <div className="plugins-unlocks">
        <List>
          {unlocks.map((unlock) => (
            <Unlock key={unlock.id} plugin={plugin} unlock={unlock} />
          ))}
        </List>
      </div>
      {/* Accepting one here is the approval: the click creates it. */}
      <p className="plugins-note">
        Nothing here is created by installing. Accept creates the agent with the tools listed; change or remove it{' '}
        <a href={AGENTS_ROUTE}>on the Agents page</a>.
      </p>
    </Section>
  );
}

/** One proposed agent: what it is, and the button that creates it. */
function Unlock({ plugin, unlock }: { plugin?: string; unlock: PluginUnlock }): JSX.Element {
  // The same accept Home and a plugin's own page offer (`parts/AgentOffer`).
  const offer = useAcceptPluginAgent(plugin, unlock.id);
  const state = offer.created ? 'up-to-date' : unlock.drift.state;
  const [tone, word] = DRIFT_WORDS[state];
  return (
    <div className="plugins-unlock">
      <ListRow
        title={<span className="plugins-handle">@{unlock.handle}</span>}
        sub={offer.created ? 'Accepted just now. It is on the Agents page.' : unlock.drift.message}
        side={
          <span className="plugins-side">
            <Pill tone={tone}>{word}</Pill>
            {plugin && state === 'not-accepted' ? (
              <Button size="sm" variant="accent" disabled={offer.busy} onClick={offer.accept}>
                Accept
              </Button>
            ) : null}
          </span>
        }
      />
      <ErrorBanner message={offer.failure} />
      {offer.created ? <AgentReady agent={offer.created} /> : null}
    </div>
  );
}

/** The sheet's title: the face, the name and version, who made it and how it stands. */
function SheetTitle({
  svg,
  name,
  version,
  by,
  pills,
}: {
  svg: string | undefined;
  name: string;
  version: string;
  by: ReactNode;
  pills: ReactNode;
}): JSX.Element {
  return (
    <span className="plugins-sheet-title">
      <AppIcon svg={svg} size="lg" />
      <span className="plugins-sheet-name">
        <span>
          {name} <span className="plugins-ver">{version}</span>
        </span>
        <span className="plugins-sheet-by">
          by {by}
          {pills}
        </span>
      </span>
    </span>
  );
}

/** The detail of one installed plugin. */
function InstalledSheet({
  plugin,
  listing,
  notes,
  canOpen,
  busy,
  onOpen,
  onSettings,
  onClose,
  onDisable,
  onEnable,
  onRemove,
  onUpdate,
  firstStep,
}: {
  plugin: InstalledPluginView;
  listing: MarketEntryView | undefined;
  /** What the last disable or enable said about it. */
  notes: string[] | null;
  canOpen: boolean;
  busy: boolean;
  onOpen: () => void;
  onSettings?: (() => void) | undefined;
  onClose: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onRemove: () => void;
  /** No version: fetch whatever is newest and read it, like any update. */
  onUpdate: (version?: string) => void;
  /** Its first step when it waits, as on its row. */
  firstStep?: { label: string; run: () => void } | undefined;
}): JSX.Element {
  const disabled = plugin.enabled === false;
  /*
   * Code off this machine was put there by the owner, so "you, from this
   * machine" says nothing an author line does not say better. A registry's
   * publisher is a different fact (who holds the npm name) and stays.
   */
  const authorReplacesPublisher = plugin.author !== undefined && plugin.source.kind === 'directory';
  const description = listing?.summary ?? plugin.description;
  const hosts = (plugin.network ?? listing?.claims?.manifest?.network ?? []).map((use) => use.host);
  const uses = plugin.uses ?? listing?.usesWords;
  return (
    <Sheet
      title={
        <SheetTitle
          svg={listing?.iconSvg}
          name={plugin.name}
          version={plugin.version}
          by={plugin.author ? <AuthorName author={plugin.author} /> : byWords(plugin)}
          pills={
            <>
              {listing ? (
                <>
                  {' · '}
                  <TrustPill entry={listing} />
                </>
              ) : null}
              {' · '}
              <StatePill plugin={plugin} />
            </>
          }
        />
      }
      onClose={onClose}
      foot={
        <Toolbar>
          <Button variant="danger-ghost" onClick={onRemove}>
            Remove…
          </Button>
          <Spacer />
          {onSettings ? (
            <Button variant="ghost" onClick={onSettings}>
              Settings
            </Button>
          ) : null}
          {canOpen ? <Button onClick={onOpen}>Open</Button> : null}
          {disabled ? (
            <Button onClick={onEnable}>Enable</Button>
          ) : (
            <Button variant="ghost" onClick={onDisable}>
              Disable…
            </Button>
          )}
          {listing?.update ? (
            <Button variant="accent" disabled={busy} onClick={() => onUpdate(listing.update)}>
              Update to {listing.update}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => onUpdate()}>
              {plugin.source.kind === 'directory' ? 'Reinstall from folder' : 'Check for an update'}
            </Button>
          )}
        </Toolbar>
      }
    >
      {plugin.error ? <Notice tone="critical">{plugin.error}</Notice> : null}
      {notes && notes.length > 0 ? <Notice role="status">{notes.join(' ')}</Notice> : null}
      {disabled ? (
        <Notice>Disabled: its tools, pages and watchers are off and its missions are paused. Its data is kept.</Notice>
      ) : null}
      {!disabled && plugin.needs && plugin.needs.length > 0 ? (
        <Notice
          tone="warning"
          action={firstStep ? <Button size="sm" variant="accent" onClick={firstStep.run}>{firstStep.label}</Button> : undefined}
        >
          Waiting: {waitingWords(plugin)}. Its tools and widgets stay off until then; its data is kept.
        </Notice>
      ) : !disabled && plugin.loaded && plugin.setup ? (
        <Notice
          tone="warning"
          action={firstStep ? <Button size="sm" variant="accent" onClick={firstStep.run}>{firstStep.label}</Button> : undefined}
        >
          Not set up yet. {plugin.setup.note ?? 'Its settings say what it needs.'}
        </Notice>
      ) : null}
      {description ? <p className="plugins-summary-full">{description}</p> : null}
      <div className="plugins-facts">
        <KV
          items={[
            { label: 'From', value: sourceWords(plugin.source) },
            // The title already says who made it; for code off this machine that is the whole answer.
            ...(authorReplacesPublisher
              ? []
              : [{ label: 'Published by', value: publisherWords(plugin.source, plugin.publisher) }]),
            { label: 'Integrity', value: <Hash value={plugin.integrity} /> },
            { label: 'Installed', value: fmtRelative(plugin.installedAt) },
            ...(plugin.installedAs ? [{ label: 'Installed as', value: plugin.installedAs }] : []),
            { label: 'Contributes', value: contributionWords(plugin.contribution) },
            ...(plugin.network || listing ? [{ label: 'Talks to hosts', value: hostsValue(hosts) }] : []),
            ...(uses ? [{ label: 'Reaches in buddi', value: reachesValue(uses) }] : []),
          ]}
        />
      </div>
      <Unlocks plugin={plugin.name} unlocks={plugin.unlocks} />
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Disable and Remove, asked once
 * ------------------------------------------------------------------ */

function Confirm({
  kind,
  name,
  canDisable,
  onCancel,
  onDisableInstead,
  onDisable,
  onRemove,
}: {
  kind: 'disable' | 'remove';
  name: string;
  /** It is on, so "Disable instead" is an answer. */
  canDisable: boolean;
  onCancel: () => void;
  onDisableInstead: () => void;
  onDisable: () => Promise<void>;
  onRemove: (purge: boolean, confirm: string) => Promise<void>;
}): JSX.Element {
  const [purge, setPurge] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailed(null);
    work()
      .catch((error: unknown) => setFailed(errorText(error)))
      .finally(() => setBusy(false));
  };
  if (kind === 'disable') {
    return (
      <Modal
        title={`Disable ${name}?`}
        onClose={onCancel}
        foot={
          <>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="accent" disabled={busy} onClick={() => run(onDisable)}>
              Disable
            </Button>
          </>
        }
      >
        <p className="plugins-dialog-text">
          Its tools, pages and watchers stop now and its missions pause. Its data and the agents you accepted from it
          are kept; enable it to have it all back.
        </p>
        <ErrorBanner message={failed} />
      </Modal>
    );
  }
  const ready = !purge || typed.trim() === name;
  return (
    <Modal
      title={`Remove ${name}?`}
      onClose={onCancel}
      foot={
        <>
          {canDisable ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDisableInstead}>
              Disable instead
            </Button>
          ) : null}
          <Spacer />
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !ready} onClick={() => run(() => onRemove(purge, typed.trim()))}>
            {purge ? 'Remove and drop its data' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className="plugins-dialog-text">
        This takes {name} off this machine and stops its code loading. Its tables and the agents you accepted from it
        stay.
      </p>
      <div className="plugins-purge" data-on={purge ? 'true' : undefined}>
        <label className="plugins-check">
          <input
            type="checkbox"
            checked={purge}
            onChange={(event) => {
              setPurge(event.target.checked);
              setTyped('');
            }}
          />
          <span>
            <span className="plugins-check-title">Also drop its data</span>
            <span className="plugins-check-hint">Its tables are gone for good; there is no undo.</span>
          </span>
        </label>
        {purge ? (
          <Field
            label={
              <>
                Type <span className="mono">{name}</span> to confirm
              </>
            }
          >
            <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <ErrorBanner message={failed} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * What was already here
 * ------------------------------------------------------------------ */

/**
 * The plugins buddi ships with, folded: nothing to approve and nothing to
 * remove, so a name and how many tools each adds — the part of the tool list
 * that came with the box. What each does, who made it and the hosts it talks
 * to are its tooltip.
 */
function ShipsWithBuddi({
  plugins,
  openFor,
}: {
  plugins: BuiltInPluginView[];
  openFor: (name: string, variant?: 'ghost') => ReactNode;
}): JSX.Element {
  return (
    <Details boxed summary={`Ships with buddi · ${plural(plugins.length, 'plugin', 'plugins')}`}>
      <p className="plugins-note">
        Compiled into this buddi: nothing to approve, nothing to remove. An agent still reaches one only if its own
        tools line names it.
      </p>
      <div className="plugins-builtins">
        {plugins.map((plugin) => {
          const hosts = (plugin.network ?? []).map((use) => use.host);
          const about = [
            plugin.description,
            plugin.author ? `By ${plugin.author.name}.` : null,
            hosts.length > 0 ? `Talks to ${hosts.join(', ')}.` : null,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div key={plugin.name} className="plugins-builtin" title={about || undefined}>
              <span className="mono">{plugin.name}</span>
              <span className="plugins-builtin-n">
                {openFor(plugin.name, 'ghost')}
                {plural(plugin.contribution.tools, 'tool', 'tools')}
              </span>
            </div>
          );
        })}
      </div>
    </Details>
  );
}

/* ------------------------------------------------------------------ *
 * Browse: the list withbuddi.com keeps
 * ------------------------------------------------------------------ */

type Shelf = 'all' | 'recommended' | MarketCategory;

/** The shelves after All and Recommended, in this order, each only when it has a listing. */
const CATEGORIES: Array<{ value: MarketCategory; label: string }> = [
  { value: 'days', label: 'Your days' },
  { value: 'money', label: 'Money' },
  { value: 'voice', label: 'Voice' },
  { value: 'work', label: 'Work' },
  { value: 'home', label: 'Home' },
  { value: 'other', label: 'Other' },
];

function matches(entry: MarketEntryView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [entry.title, entry.summary, entry.npm, ...(entry.widgets ?? []).map((w) => w.title)].some((text) => text.toLowerCase().includes(q));
}

/** What it costs, in words: "free", or "a subscription · 14 days to try · its maker's page". */
function PriceWords({ pricing }: { pricing: MarketEntryView['pricing'] }): JSX.Element {
  if (pricing.kind === 'free') return <>free</>;
  return (
    <>
      {pricing.kind === 'paid' ? 'paid' : 'a subscription'}
      {pricing.trialDays ? ` · ${pricing.trialDays} days to try` : ''}
      {pricing.note ? ` · ${pricing.note}` : ''}
      {pricing.vendor ? (
        <>
          {' · '}
          <a href={pricing.vendor} target="_blank" rel="noopener noreferrer">
            its maker&apos;s page
          </a>
        </>
      ) : null}
    </>
  );
}

/** One listing: its face, what it is, how it is trusted, and the one button. */
function MarketCard({
  entry,
  busy,
  onOpen,
  onInstall,
  onUpdate,
}: {
  entry: MarketEntryView;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onUpdate: (version: string) => void;
}): JSX.Element {
  return (
    <Card onClick={onOpen} label={`${entry.title}: details`}>
      <div className="plugins-card-head">
        <AppIcon svg={entry.iconSvg} size="lg" />
        <div className="plugins-card-name">
          <h3 className="ui-card-title">{entry.title}</h3>
          <div className="plugins-card-by">
            by {entry.author?.name ?? 'someone who gave no name'}
            {entry.widgets?.length ? ` · ${plural(entry.widgets.length, 'widget', 'widgets')}` : ''}
          </div>
        </div>
      </div>
      <p className="plugins-summary">{entry.summary}</p>
      <div className="plugins-card-foot">
        <TrustPill entry={entry} />
        {entry.installed ? <Pill>installed {entry.installed.version}</Pill> : null}
        <Spacer />
        {entry.update ? (
          <Button size="sm" disabled={busy} onClick={stop(() => onUpdate(entry.update as string))}>
            Update to {entry.update}
          </Button>
        ) : entry.installed ? null : (
          <Button size="sm" variant="accent" disabled={busy} onClick={stop(onInstall)}>
            Install
          </Button>
        )}
      </div>
    </Card>
  );
}

/** "6 run without asking, 1 asks you first, 1 on a timer", from its manifest as listed. */
function toolsWords(entry: MarketEntryView): string | undefined {
  const manifest = entry.claims?.manifest;
  const tools = manifest?.tools;
  if (!tools) return undefined;
  const auto = tools.filter((tool) => tool.tier === 'auto').length;
  const asks = tools.length - auto;
  const timers = manifest?.sentinels?.length ?? 0;
  const parts = [
    auto > 0 ? `${auto} run without asking` : null,
    asks > 0 ? `${asks} ask${asks === 1 ? 's' : ''} you first` : null,
    timers > 0 ? `${timers} on a timer` : null,
  ].filter(Boolean);
  return parts.length === 0 ? 'none' : parts.join(', ');
}

/** The detail of one listing: its screenshot, what it is, and what it would reach. */
function ListingSheet({
  entry,
  canOpen,
  busy,
  onOpen,
  onClose,
  onInstall,
  onUpdate,
}: {
  entry: MarketEntryView;
  canOpen: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onInstall: () => void;
  onUpdate: (version: string) => void;
}): JSX.Element {
  const shot = entry.screenshots?.[0];
  const hosts = (entry.claims?.manifest?.network ?? []).map((use) => use.host);
  const tools = toolsWords(entry);
  const agents = entry.claims?.manifest?.agents?.length ?? 0;
  const deps = entry.claims?.package?.dependencies;
  return (
    <Sheet
      title={
        <SheetTitle
          svg={entry.iconSvg}
          name={entry.title}
          version={entry.version}
          by={entry.author ? <AuthorName author={entry.author} /> : 'someone who gave no name'}
          pills={
            <>
              {' · '}
              <TrustPill entry={entry} />
              {entry.installed ? (
                <>
                  {' · '}
                  <Pill>installed {entry.installed.version}</Pill>
                </>
              ) : null}
            </>
          }
        />
      }
      onClose={onClose}
      foot={
        <Toolbar>
          <span className="plugins-foot-note">
            {entry.installed && !entry.update
              ? 'This is the version you have.'
              : 'Install reads it first. Nothing of it runs until you say yes.'}
          </span>
          <Spacer />
          {canOpen ? <Button onClick={onOpen}>Open</Button> : null}
          {entry.update ? (
            <Button variant="accent" disabled={busy} onClick={() => onUpdate(entry.update as string)}>
              Update to {entry.update}
            </Button>
          ) : entry.installed ? null : (
            <Button variant="accent" disabled={busy} onClick={onInstall}>
              Install
            </Button>
          )}
        </Toolbar>
      }
    >
      {shot ? <img className="plugins-shot" src={api.marketAssetUrl(shot)} alt={`${entry.title}, as it looks in buddi`} /> : null}
      <p className="plugins-summary-full">{entry.summary}</p>
      <ListingWidgets entry={entry} />
      <div className="plugins-facts">
        <KV
          items={[
            { label: 'Package', value: <span className="mono">{`${entry.npm}@${entry.version}`}</span> },
            ...(tools ? [{ label: 'Tools', value: tools }] : []),
            ...(agents > 0
              ? [{ label: 'Proposes', value: `${plural(agents, 'agent', 'agents')}, created only if you accept` }]
              : []),
            { label: 'Talks to hosts', value: hostsValue(hosts) },
            { label: 'Reaches in buddi', value: reachesValue(entry.usesWords ?? []) },
            ...(deps
              ? [
                  {
                    label: 'Dependencies',
                    value:
                      deps.count === 0
                        ? 'none'
                        : `${deps.count}${
                            deps.withScripts.length === 0
                              ? ', none of which run install scripts'
                              : `, of which these run install scripts: ${deps.withScripts.join(', ')}`
                          }`,
                  },
                ]
              : []),
            {
              label: 'Licence',
              value: (
                <>
                  {entry.license ?? 'not stated'} · <PriceWords pricing={entry.pricing} />
                </>
              ),
            },
          ]}
        />
      </div>
    </Sheet>
  );
}

/** One widget's line: its sizes, whether each placement has settings, whether it hides on screen. */
function widgetLine(widget: MarketWidgetView): string {
  return [
    widgetSizesWords(widget.sizes),
    widget.settings > 0 ? 'settings per placement' : null,
    widget.sensitive ? 'hidden until you show it, never on the lock screen' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A listing's widgets in its sheet: each one at every size it offers, from the plugin's sample. */
function ListingWidgets({ entry }: { entry: MarketEntryView }): JSX.Element | null {
  const widgets = entry.widgets ?? [];
  if (widgets.length === 0) return null;
  return (
    <Section title="Widgets" aside={<span className="plugins-note">Sample data, drawn as Home draws it</span>}>
      <div className="plugins-widgets">
        {widgets.map((widget) => (
          <div key={widget.id} className="plugins-widget">
            <div className="plugins-widget-head">
              <span className="plugins-widget-title">{widget.title}</span>
              <span className="plugins-widget-sub">{widgetLine(widget)}</span>
            </div>
            <div className="plugins-widget-frames">
              {widgetSizesInOrder(widget.sizes).map((size) => (
                <ListedWidgetFrame key={size} widget={widget} size={size} svg={entry.iconSvg} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Whether a listing is only widgets: no tools, nothing on a timer, no agents. */
function widgetOnly(entry: MarketEntryView): boolean {
  const manifest = entry.claims?.manifest;
  return (entry.widgets?.length ?? 0) > 0 && (manifest?.tools?.length ?? 0) === 0 && (manifest?.sentinels?.length ?? 0) === 0 && (manifest?.agents?.length ?? 0) === 0;
}

/**
 * Browse's Widgets shelf: every listed widget at the size it starts at, on
 * Home's grid and row height, the plugin it comes with under it. The frame
 * opens the listing; Install stages the plugin, as on its card.
 */
function WidgetShelf({
  entries,
  busy,
  onOpen,
  onInstall,
}: {
  entries: MarketEntryView[];
  busy: boolean;
  onOpen: (entry: MarketEntryView) => void;
  onInstall: (entry: MarketEntryView) => void;
}): JSX.Element {
  return (
    <div className="plugins-wgrid" data-testid="browse-widgets">
      {entries.flatMap((entry) =>
        (entry.widgets ?? []).map((widget) => {
          const size = widget.sizes[0] ?? 'small';
          return (
            <div key={`${entry.npm}:${widget.id}`} className="plugins-witem" data-size={size}>
              <button type="button" className="plugins-witem-frame" aria-label={`${widget.title}, from ${entry.title}: details`} onClick={() => onOpen(entry)}>
                <ListedWidgetFrame widget={widget} size={size} svg={entry.iconSvg} />
              </button>
              <div className="plugins-witem-foot">
                <span className="plugins-witem-text">
                  <span className="plugins-witem-title">{widget.title}</span>
                  <span className="plugins-witem-sub">
                    {widgetOnly(entry) ? 'A widget' : `${entry.title} plugin`} · by {entry.author?.name ?? 'someone who gave no name'} · {widgetSizesWords(widget.sizes)}
                  </span>
                </span>
                {/* An update is the plugin's business: its card and its sheet offer it. */}
                {entry.installed ? (
                  <span className="plugins-witem-have">Installed</span>
                ) : (
                  <Button size="sm" variant="accent" disabled={busy} aria-label={`Install ${entry.title}`} onClick={() => onInstall(entry)}>
                    Install
                  </Button>
                )}
              </div>
            </div>
          );
        }),
      )}
    </div>
  );
}

function Browse({
  kind = 'all',
  onKind,
  navigate,
  market,
  loading,
  busy,
  onRetry,
  onOpen,
  onInstall,
  onUpdate,
}: {
  /** All, only plugins, the plugins' widgets (`&kind=widgets`), or the catalogue's agents (`&kind=agents`). */
  kind?: BrowseKind;
  onKind?: (kind: BrowseKind) => void;
  navigate?: ((route: string) => void) | undefined;
  market: MarketView | null;
  loading: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpen: (entry: MarketEntryView) => void;
  onInstall: (entry: MarketEntryView) => void;
  onUpdate: (entry: MarketEntryView, version: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<Shelf>('all');
  const listed = market?.plugins ?? [];
  const shelves: Array<{ value: Shelf; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'recommended', label: 'Recommended' },
    ...CATEGORIES.filter((category) => listed.some((entry) => entry.category === category.value)),
  ];
  const shown = listed.filter((entry) => {
    if (kind === 'widgets' && (entry.widgets?.length ?? 0) === 0) return false;
    if (shelf === 'recommended' && (entry.trust !== 'by-buddi' || entry.installed)) return false;
    if (shelf !== 'all' && shelf !== 'recommended' && entry.category !== shelf) return false;
    return matches(entry, query);
  });
  const q = query.trim();
  const kinds = (
    <div className="plugins-kind">
      <Segment<BrowseKind> label="Show" options={BROWSE_KINDS} value={kind} onChange={(next) => onKind?.(next)} />
    </div>
  );
  const teammates = kind === 'plugins' || kind === 'widgets' ? null : <BrowseAgents kind={kind} navigate={navigate} />;
  if (kind === 'agents') {
    return (
      <Stack gap="lg">
        {kinds}
        <p className="plugins-quiet">
          <Icon name="globe" size={14} />
          Opening this tab fetched the list from withbuddi.com. Nothing else leaves.
        </p>
        {teammates}
      </Stack>
    );
  }
  return (
    <Stack gap="lg">
      {kinds}
      <Toolbar>
        <SearchField
          grow
          label={kind === 'widgets' ? 'Search widgets' : 'Search plugins'}
          value={query}
          placeholder={kind === 'widgets' ? 'Search widgets: weather, calendar, news…' : 'Search plugins: weather, money, calendar…'}
          onChange={setQuery}
        />
        <FilterChips<Shelf> label="Show" options={shelves} value={shelf} onChange={setShelf} />
      </Toolbar>
      <p className="plugins-quiet">
        <Icon name="globe" size={14} />
        Opening this tab fetched the list from withbuddi.com. Nothing else leaves.{' '}
        <button type="button" className="plugins-link" disabled={loading} onClick={onRetry}>
          Refresh
        </button>
      </p>
      {market === null || (loading && market.unavailable) ? (
        <Empty>Asking withbuddi.com…</Empty>
      ) : market.unavailable ? (
        <Notice
          tone="warning"
          action={
            <Button size="sm" disabled={loading} onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {market.unavailable}
        </Notice>
      ) : (
        <>
          {market.stale ? (
            <Notice
              tone="warning"
              action={
                <Button size="sm" disabled={loading} onClick={onRetry}>
                  Try again
                </Button>
              }
            >
              withbuddi.com did not answer, so this is the list as it was
              {market.fetchedAt ? ` ${fmtRelative(market.fetchedAt)}` : ' last time'}.
            </Notice>
          ) : null}
          {shown.length > 0 && kind === 'widgets' ? (
            <WidgetShelf entries={shown} busy={busy} onOpen={onOpen} onInstall={onInstall} />
          ) : shown.length > 0 ? (
            <div className="plugins-grid">
              {shown.map((entry) => (
                <MarketCard
                  key={entry.npm}
                  entry={entry}
                  busy={busy}
                  onOpen={() => onOpen(entry)}
                  onInstall={() => onInstall(entry)}
                  onUpdate={(version) => onUpdate(entry, version)}
                />
              ))}
            </div>
          ) : (
            <Empty warm title="Nothing listed matches">
              {q !== ''
                ? `No ${kind === 'widgets' ? 'widget' : 'plugin'} on withbuddi.com mentions “${q}”.`
                : kind === 'widgets' && !listed.some((entry) => (entry.widgets?.length ?? 0) > 0)
                  ? 'No plugin on withbuddi.com brings a widget yet.'
                  : listed.length === 0
                  ? 'withbuddi.com lists no plugins yet.'
                  : 'Nothing on this shelf yet.'}
            </Empty>
          )}
        </>
      )}
      {teammates}
    </Stack>
  );
}

const BROWSE_KINDS: ReadonlyArray<{ value: BrowseKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'plugins', label: 'Plugins' },
  { value: 'widgets', label: 'Widgets' },
  { value: 'agents', label: 'Agents' },
];

/**
 * The catalogue's teammates in Browse, drawn with its cards: three ready ones
 * under All with "See all N", every one under Agents with "Open the
 * catalogue". A card, Add or Update opens the teammate's catalogue page,
 * where the sheets are.
 */
function BrowseAgents({ kind, navigate }: { kind: BrowseKind; navigate?: ((route: string) => void) | undefined }): JSX.Element | null {
  const read = useAsync(() => api.catalogue(), []);
  const loaded = useLoadedPlugins();
  const go = (route: string): void => navigate?.(route);
  const view = read.data;
  if (!view) return read.error ? <Notice tone="warning">{read.error}</Notice> : <Empty>Asking withbuddi.com…</Empty>;
  if (view.unavailable) return kind === 'agents' ? <Notice tone="warning">{view.unavailable}</Notice> : null;
  const ready = view.agents.filter((a) => cardState(a) === 'ready');
  const shown = kind === 'all' ? ready.slice(0, 3) : view.agents;
  if (shown.length === 0) return null;
  return (
    <Section
      title={kind === 'all' ? 'Teammates' : undefined}
      aside={
        <a href={catalogueRoute()} onClick={(e) => { e.preventDefault(); go(catalogueRoute()); }}>
          {kind === 'all' ? `See all ${view.agents.length}` : 'Open the catalogue'}
        </a>
      }
    >
      <div className="plugins-grid" data-testid="browse-agents">
        {shown.map((a) => (
          <CatCard
            key={a.name}
            entry={a}
            loaded={loaded}
            onOpen={() => go(catalogueRoute(a.name))}
            onAdd={() => go(catalogueRoute(a.name))}
            onUpdate={() => go(catalogueRoute(a.name))}
          />
        ))}
      </div>
    </Section>
  );
}
