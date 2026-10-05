/**
 * Settings: the installation, section by section. Model accounts, the computer
 * and browser the agents may drive, the watchers that check, the system itself
 * — and, under Plugins, an entry for each screen an installed plugin
 * contributes. Nothing here is a page an owner visits daily, which is why it
 * is behind the gear and not on the rail's first screen.
 *
 * The sections are a grouped list beside the rail (`SettingsNav`), and the
 * open one is drawn to its right; on a narrow window the list is a menu at the
 * top of the section instead.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlaceProps } from '../App';
import { ApiError, api, type UpgradeAttempt, type UpgradeJob } from '../api';
import { AccessSettings } from './Access';
import { fmtRelative, fmtTime } from '../format';
import { SECRETS_ADD_ROUTE, SETTINGS_ROUTE, parseAccountRoute, parseConnectionRoute, parseProposalsFilter, parseSecretRoute, parseSecretsAdd, parsePluginSettingsRoute, pluginRouteParams, resolvePluginSettingsRoute, settingsSectionOf } from '../routes';
import { NARROW_QUERY, useMediaQuery } from '../useMediaQuery';
import { PluginSettingsPage } from '../pages/PluginPage';
import { PluginTeammatePanel } from './parts/CatalogueSuggest';
import { usePluginPages } from '../pages/usePages';
import { useAppearance, type Ground, type PageWidth } from '../appearance';
import type { ThemeChoice } from '../theme';
import { Breadcrumb, Button, ButtonLink, Empty, ErrorBanner, Field, KV, Notice, PageHeader, Pill, Section, Segment, Stack, Toolbar, useAsync } from '../ui';
import { Backup } from './Backup';
import { Browser } from './Browser';
import { Providers } from './Providers';
import { SECRETS_LEDE, Secrets } from './Secrets';
import { CONNECTIONS_LEDE, Connections } from './Connections';
import { Watchers } from './Watchers';
import { LockSettings } from './LockSettings';
import { ApiTokens } from './ApiTokens';
import { You } from './You';
import { Memory } from './Memory';
import { Markdown } from '../chat/markdown';
import { Proposals } from './Proposals';
import { PLUGINS_LEDE, Plugins } from './Plugins';
import { Notifications, TelegramSettings } from './Notifications';
import { AppInstallSection } from './parts/KeepClose';
import { RemoveBuddi } from './parts/RemoveBuddi';
import { CommandLineTool } from './parts/CommandLineTool';
import { SettingsMenu, SettingsNav, settingsEntries } from './SettingsNav';
import { CONNECTION_DOT } from '../shell/Rail';
import { UPGRADE_PATIENCE_MS, cancelRestart, restartWhile, updateRestart } from '../shell/restart';
import { railKey, setRailHidden, useRailHidden } from '../shell/railHidden';
import type { PluginPageDescriptor } from '../pages/types';

export function Settings({ hash, timezone, navigate, agents, pluginPages }: PlaceProps): JSX.Element {
  const section = settingsSectionOf(hash);
  /*
   * A plugin's settings page is an entry like any other under Plugins: one
   * hash, one page, drawn from the descriptor. Nothing here knows which
   * plugin it is.
   */
  // Read by the shell and passed down; a Settings page opened on its own (a
  // test, a story) still reads for itself rather than listing no plugins.
  const own = usePluginPages(pluginPages !== undefined);
  const plugins = pluginPages ?? own;
  const located = parsePluginSettingsRoute(hash);
  const pluginPage = located ? plugins.find(located.plugin, located.page) : undefined;
  // A plugin's hash without a tab (`#/settings/p.news`) opens its first tab, replaced so Back skips it.
  const fallback = pluginPage ? null : resolvePluginSettingsRoute(hash, plugins.settings);
  useEffect(() => {
    if (fallback) navigate(fallback, true);
  }, [fallback, navigate]);
  const narrow = useMediaQuery(NARROW_QUERY);
  const entries = settingsEntries(plugins.settings);
  // The counts the sections already keep: the proposals still open.
  const proposals = useAsync(() => Promise.resolve().then(() => api.proposals()), [], 30_000);
  const counts = { proposals: proposals.data?.open?.length ?? 0 };
  // The rail's dot on Settings means a newer buddi is ready; the same dot on
  // System says where that is.
  const version = useAsync(() => api.version(), []);
  // …and on Connections, when one needs a sign-in or another review.
  const signals = useAsync(() => Promise.resolve().then(() => api.connectionSignals()), [], 60_000);
  const dots: Record<string, string> = {};
  if (version.data && !version.data.checkout && version.data.updateAvailable) dots.system = 'a newer buddi is ready';
  if ((signals.data?.signals ?? []).length > 0) dots.connections = CONNECTION_DOT;
  const list = { entries, active: section, counts, dots, navigate: (route: string) => navigate(route) };
  return (
    <div className="settings">
      {narrow ? null : <SettingsNav {...list} />}
      <div className="settings-body">
        <div className="ui-page">
          {section === 'secrets' ? (
            /* Keys and secrets as Plugins draws it: the way back, the title, one line, and Add a secret on the right. */
            <PageHeader
              before={<Breadcrumb inline items={[{ label: 'Settings', href: SETTINGS_ROUTE, onClick: () => navigate(SETTINGS_ROUTE) }]} />}
              title="Keys and secrets"
              lede={SECRETS_LEDE}
              actions={
                <ButtonLink variant="accent" size="sm" href={SECRETS_ADD_ROUTE} onClick={(event) => { event.preventDefault(); navigate(SECRETS_ADD_ROUTE); }}>
                  Add a secret
                </ButtonLink>
              }
            />
          ) : section === 'computer' ? (
            /* Browser & apps, as the kit draws it: the way back, the title, what it is; the apps page one step further. */
            <PageHeader
              before={<Breadcrumb inline items={[{ label: 'Settings', href: SETTINGS_ROUTE, onClick: () => navigate(SETTINGS_ROUTE) }]} />}
              title="Browser & apps"
              lede="Where agents may look"
            />
          ) : section === 'plugins' || section === 'connections' ? (
            /* Plugins and Connections are pages of their own inside Settings, as
               the kit draws them: the way back to Settings, then their own title and lede. */
            <PageHeader
              before={<Breadcrumb inline items={[{ label: 'Settings', href: SETTINGS_ROUTE, onClick: () => navigate(SETTINGS_ROUTE) }]} />}
              title={section === 'plugins' ? 'Plugins' : 'Connections'}
              lede={section === 'plugins' ? PLUGINS_LEDE : CONNECTIONS_LEDE}
            />
          ) : (
            <header className="ui-page-head">
              <h2 className="ui-page-title">Settings</h2>
              <p className="ui-page-lede">How this installation runs, and where it reaches.</p>
            </header>
          )}
          {narrow ? <SettingsMenu {...list} /> : null}
          {/* A plugin whose catalogue teammate is not on the team says so first, with Add. */}
          {pluginPage ? <PluginTeammatePanel key={pluginPage.plugin} plugin={pluginPage.plugin} title={pluginPage.title} navigate={navigate} /> : null}
          {pluginPage ? (
            <PluginSettingsPage
              page={pluginPage}
              params={pluginRouteParams(hash)}
              navigate={navigate}
              timezone={timezone}
              siblings={plugins.all.filter((p) => p.plugin === pluginPage.plugin)}
            />
          ) : null}
          {section === 'you' ? <You embedded /> : null}
          {section === 'appearance' ? <AppearanceSection railPages={plugins.rail} /> : null}
          {section === 'notifications' ? <Notifications timezone={timezone} /> : null}
          {section === 'telegram' ? <TelegramSettings timezone={timezone} /> : null}
          {section === 'memory' ? <Memory embedded agents={agents} timezone={timezone} initialTab={memoryTabOf(hash)} /> : null}
          {section === 'proposals' ? <Proposals embedded plugin={parseProposalsFilter(hash)} /> : null}
          {section === 'accounts' ? <Providers embedded account={parseAccountRoute(hash)} /> : null}
          {section === 'computer' ? <Browser embedded timezone={timezone} navigate={navigate} /> : null}
          {section === 'secrets' ? (
            <Secrets embedded timezone={timezone} secret={parseSecretRoute(hash)} adding={parseSecretsAdd(hash)} navigate={navigate} />
          ) : null}
          {section === 'connections' ? <Connections embedded timezone={timezone} connection={parseConnectionRoute(hash)} /> : null}
          {section === 'lock' ? <LockSettings navigate={navigate} /> : null}
          {section === 'api' ? <ApiTokens timezone={timezone} /> : null}
          {section === 'watchers' ? <Watchers timezone={timezone} embedded /> : null}
          {section === 'backup' ? <Backup /> : null}
          {section === 'plugins' ? <Plugins railPages={plugins.rail} settingsPages={plugins.settings} navigate={navigate} hash={hash} /> : null}
          {section === 'system' ? <System timezone={timezone} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * How the dashboard looks in this browser. Kept here, not on the server: a
 * second browser keeps its own choice, and nothing about it is reported.
 */
function AppearanceSection({ railPages }: { railPages: PluginPageDescriptor[] }): JSX.Element {
  const [appearance, set] = useAppearance();
  return (
    <Section title="Appearance" aside="Kept in this browser only. Another browser keeps its own." panel>
      <Stack divided gap="lg">
        <PrefRow label="Theme" hint="System follows your Mac.">
          <Segment<ThemeChoice>
            label="Theme"
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]}
            value={appearance.theme}
            onChange={(theme) => set({ theme })}
          />
        </PrefRow>
        <PrefRow label="Background" hint="Blue carries the first-run colours through the app. Sand is quieter.">
          <Segment<Ground>
            label="Background"
            options={[{ value: 'blue', label: 'Blue' }, { value: 'sand', label: 'Sand' }]}
            value={appearance.ground}
            onChange={(ground) => set({ ground })}
          />
        </PrefRow>
        <PrefRow label="Page width" hint="How far pages stretch on a wide screen.">
          <Segment<PageWidth>
            label="Page width"
            options={[{ value: 'narrow', label: 'Narrow' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full' }]}
            value={appearance.width}
            onChange={(width) => set({ width })}
          />
        </PrefRow>
        <RailPagesPref pages={railPages} />
        <HomeGlancesPref />
      </Stack>
    </Section>
  );
}

/**
 * Settings → Appearance → Home glances: every glance the plugins offer, with
 * a switch each. Unlike the rest of this section it is kept by the
 * installation, so a glance hidden on the laptop is hidden on the phone too.
 */
function HomeGlancesPref(): JSX.Element | null {
  const overview = useAsync(() => api.overview(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const glances = overview.data?.glances ?? [];
  const blocks = overview.data?.home ?? [];
  const dismissed = overview.data?.dismissed ?? {};
  if (glances.length === 0 && blocks.length === 0) return null;
  const toggle = (id: string, shown: boolean): void => {
    setBusy(id);
    void api
      .setGlanceHidden(id, !shown)
      .then(() => overview.reload())
      .finally(() => setBusy(null));
  };
  // A plugin's block hidden with its × on Home comes back from here.
  const toggleBlock = (id: string, shown: boolean): void => {
    setBusy(`block:${id}`);
    void api
      .homeDismiss(`block:${id}`, shown ? null : 'hidden')
      .then(() => overview.reload())
      .finally(() => setBusy(null));
  };
  return (
    <>
      {glances.length > 0 ? (
        <div className="pref-row ui-section">
          <div className="pref-text">
            <span className="pref-label">Home glances</span>
            <span className="ui-field-hint">The lines beside the date on Home, at most three. Kept for every browser.</span>
          </div>
          <Stack gap="sm">
            {glances.map((glance) => (
              <label key={glance.id} className="backup-check">
                <input type="checkbox" checked={!glance.hidden} disabled={busy === glance.id} onChange={(event) => toggle(glance.id, event.target.checked)} />
                <span>{glance.title}</span>
              </label>
            ))}
          </Stack>
        </div>
      ) : null}
      {blocks.length > 0 ? (
        <div className="pref-row ui-section">
          <div className="pref-text">
            <span className="pref-label">Home sections</span>
            <span className="ui-field-hint">What the plugins put on Home. Kept for every browser.</span>
          </div>
          <Stack gap="sm">
            {blocks.map((block) => (
              <label key={block.id} className="backup-check">
                <input type="checkbox" checked={dismissed[`block:${block.id}`] !== 'hidden'} disabled={busy === `block:${block.id}`} onChange={(event) => toggleBlock(block.id, event.target.checked)} />
                <span>{block.title}</span>
              </label>
            ))}
          </Stack>
        </div>
      ) : null}
    </>
  );
}

/**
 * Settings → Appearance → In the rail: every page the plugins put in the rail
 * (Mail, Calendar), with a switch each, all on until the owner turns one off.
 * Kept by the installation, like the glances. A page taken off the rail is
 * still opened from Settings → Plugins.
 */
export function RailPagesPref({ pages }: { pages: PluginPageDescriptor[] }): JSX.Element | null {
  const hidden = useRailHidden();
  const [failed, setFailed] = useState<string | null>(null);
  if (pages.length === 0) return null;
  const toggle = (page: PluginPageDescriptor, shown: boolean): void => {
    setFailed(null);
    setRailHidden(page, !shown).catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div className="pref-row ui-section">
      <div className="pref-text">
        <span className="pref-label">In the rail</span>
        <span className="ui-field-hint">The plugin pages beside Home and Chat. One you turn off still opens from Settings → Plugins. Kept for every browser.</span>
      </div>
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        {pages.map((page) => (
          <label key={railKey(page)} className="backup-check">
            <input type="checkbox" checked={!hidden.has(railKey(page))} onChange={(event) => toggle(page, event.target.checked)} />
            <span>{page.title}</span>
          </label>
        ))}
      </Stack>
    </div>
  );
}

function PrefRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pref-row ui-section">
      <div className="pref-text">
        <span className="pref-label">{label}</span>
        <span className="ui-field-hint">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function System({ timezone }: { timezone: string }): JSX.Element {
  const overview = useAsync(() => api.overview(), [], 15_000);
  const session = useAsync(() => api.session(), []);
  const accounts = useAsync(() => api.providerAccounts(), []);
  const data = overview.data;
  return (
    <Stack gap="lg">
      <ErrorBanner message={overview.error} />
      <Version />
      {data ? (
        <Section
          title="The queue"
          panel
          actions={
            <Button size="sm" variant={data.paused ? 'accent' : undefined} onClick={() => { void api.setPaused(!data.paused).then(() => overview.reload()); }}>
              {data.paused ? 'Resume the queue' : 'Pause the queue'}
            </Button>
          }
        >
          <p className="ui-card-meta">
            {data.paused ? 'Paused. Nothing is being claimed until you resume.' : 'Running. Jobs are claimed as they come due.'}{' '}
            {data.paused ? <Pill tone="warning">paused</Pill> : <Pill tone="good">running</Pill>}
          </p>
        </Section>
      ) : null}
      <Section title="This host" panel>
        <KV
          items={[
            { label: 'Time zone', value: timezone },
            { label: 'Server time', value: data ? fmtTime(data.now, timezone) : '…' },
            { label: 'Bound to', value: session.data ? `${session.data.host}:${session.data.port}` : '…' },
            { label: 'Credential vault', value: accounts.data ? vaultLabel(accounts.data.vault.kind) : '…' },
          ]}
        />
        {accounts.data && (accounts.data.vault.locked || accounts.data.vault.kind === 'none') ? (
          <Notice tone="warning">{accounts.data.vault.advice || 'Run buddi init on the host to configure secure credential storage.'}</Notice>
        ) : null}
      </Section>
      <Service />
      <AppInstallSection />
      <CommandLineTool />
      <AccessSettings />
      <Section title="Mail and sources" panel>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.mail.length === 0 ? (
          <Empty>No sources are installed.</Empty>
        ) : (
          <KV
            items={data.mail.map((source) => ({
              key: source.sourceId,
              label: <span className="mono">{source.sourceId}</span>,
              value: source.lastError ? (
                <span className="critical">{source.lastError}</span>
              ) : (
                <span>polled {fmtRelative(source.lastRunAt)}</span>
              ),
            }))}
          />
        )}
      </Section>
      {/* The last row, on purpose: nothing here is something to do often. */}
      <RemoveBuddi />
    </Stack>
  );
}

// Sign in from elsewhere lives in its own file; the Tailscale row is exported
// from here too, as it always was.
export { Tailscale } from './Access';

/**
 * The supervisor's switches, when there is a supervisor.
 *
 * A packaged installation runs the gateway as a supervised child, so the
 * database can stay up while the gateway restarts. A developer checkout has no
 * supervisor and this section is simply absent — there is nothing here to
 * control and no command to recommend.
 *
 * Stop and restart end the process serving this page, which is why both ask
 * once before they act and say what will happen. Either then draws its
 * full-window screen (`shell/Restarting.tsx`), which reloads the page once a
 * new process answers.
 */
export function Service(): JSX.Element | null {
  const view = useAsync(() => api.service(), [], 10_000);
  const [pending, setPending] = useState<'stop' | 'restart' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const status = view.data?.supervised ? view.data.status : undefined;
  if (!status) return null;
  const act = (action: 'stop' | 'restart'): void => {
    setBusy(true);
    setFailed(null);
    void restartWhile({ kind: action }, () => api.serviceAction(action))
      .then(() => { setPending(null); })
      .catch((error: Error) => { setFailed(error.message); view.reload(); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Section title="Service" panel>
      <Stack divided>
        <Section>
          <KV
            items={[
              { label: 'Database', value: <ProcessState state={status.database} pid={status.databasePid} /> },
              { label: 'Gateway', value: <ProcessState state={status.gateway} pid={status.gatewayPid} /> },
              { label: 'Supervisor', value: <span className="mono">pid {status.supervisorPid}</span> },
            ]}
          />
        </Section>
        <Section>
          <Stack gap="sm">
            <ErrorBanner message={failed} />
            {pending ? (
              <Notice tone="warning" role="alert">
                {pending === 'stop'
                  ? 'Stopping the gateway closes this dashboard. The database keeps running; run buddi in a terminal to bring the dashboard back.'
                  : 'Restarting the gateway takes a few seconds. This page waits for it and comes back by itself.'}
              </Notice>
            ) : (
              <p className="ui-card-meta">Stopping the gateway ends this dashboard until buddi is run again.</p>
            )}
            <Toolbar align="end">
              {pending ? (
                <>
                  <Button variant="ghost" disabled={busy} onClick={() => { setPending(null); setFailed(null); }}>
                    Cancel
                  </Button>
                  <Button variant={pending === 'stop' ? 'danger' : 'accent'} disabled={busy} onClick={() => { act(pending); }}>
                    {pending === 'stop' ? 'Stop it' : 'Restart it'}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => { setPending('stop'); }}>
                    Stop gateway
                  </Button>
                  <Button variant="accent" onClick={() => { setPending('restart'); }}>
                    Restart gateway
                  </Button>
                </>
              )}
            </Toolbar>
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}

function ProcessState({ state, pid }: { state: string; pid: number | null }): JSX.Element {
  return (
    <span>
      <Pill tone={state === 'running' ? 'good' : state === 'stopped' ? 'warning' : state === 'failed' ? 'critical' : 'muted'}>{state}</Pill>{' '}
      {pid === null ? <span className="ui-card-meta">no process</span> : <span className="mono">pid {pid}</span>}
    </span>
  );
}

export function vaultLabel(kind: string): string {
  return kind === 'keychain' ? 'macOS Keychain' : kind === 'file' ? 'Encrypted file vault' : kind === 'none' ? 'None' : kind;
}

/* ------------------------------------------------------------------ *
 * The version, and upgrading to the next one
 * ------------------------------------------------------------------ */

/** How often a running upgrade, or a gateway that has gone, is asked again. */
const UPGRADE_POLL_MS = 2_000;

/** What each phase of an upgrade is, in the words of the thing being waited for. */
const UPGRADE_PHASES: Record<string, string> = {
  starting: 'Getting started.',
  backup: 'Taking a backup first, so there is a way back.',
  stopping: 'Stopping the gateway. The database stays up.',
  installing: 'Installing the new version.',
  verifying: 'Checking that the new version can start its database.',
  'rolling-back': 'The new version could not start its database. Putting the previous one back.',
  restarting: 'Restarting buddi on the new version.',
  migrating: 'Bringing the database up to date.',
  done: 'Done.',
  failed: 'That did not work.',
};

/** A phase nothing follows. */
const UPGRADE_ENDED = new Set(['done', 'failed', 'rolled-back']);

/** The disclosure that sits beside the switch, because it is an outbound call. */
const CHECK_DISCLOSURE = 'The check asks the npm registry for the newest version and sends nothing else.';

/** What an upgrade does, said before it is allowed to start. */
const UPGRADE_WARNING =
  'This takes a backup, installs the new version and restarts buddi. This page waits for it and comes back by itself.';

/** How often buddi.app's panel asks the supervisor again (cheap: its cached answer). */
const APP_VERSION_POLL_MS = 60_000;

/** buddi.app's words for the same upgrade, as its menu's "Update to …" says them. */
export function updateWords(app: boolean, latest: string | undefined): { button: string; warning: string } {
  return app
    ? { button: latest ? `Update to ${latest}` : 'Update', warning: `buddi takes a backup first, installs ${latest ?? 'the new version'} and restarts; it takes a minute or two. This page waits for it and comes back by itself.` }
    : { button: latest ? `Upgrade to ${latest}` : 'Upgrade', warning: UPGRADE_WARNING };
}

/** The one line a checkout gets instead of an upgrade button. */
const CHECKOUT_UPGRADE_LINE = 'A checkout upgrades with git pull, then buddi upgrade in a terminal.';

/**
 * How long after it ended a failed upgrade is still news on this page.
 *
 * An upgrade that fails after the hand-over comes back as the old version,
 * and the restart screen reloads the page onto it: the reloaded page is where
 * the owner reads what happened and the way back.
 */
const RECENT_FAILURE_MS = 15 * 60_000;

/** The way back from an upgrade that failed under the new code. */
export function recoveryLine(attempt: UpgradeAttempt, app = false): string {
  const where = attempt.step === 'starting' ? 'while starting' : `at ${attempt.step ?? 'an unknown step'}`;
  const head = `The upgrade to ${attempt.to} failed ${where}: ${attempt.error ?? 'no reason given'}. ` +
    `The backup taken first is ${attempt.backup ?? 'not available'}. `;
  // buddi.app keeps the version that ran before; its menu goes back to it.
  return app
    ? head + `To go back to ${attempt.from}, choose Advanced → Restart with the Previous Version in the buddi menu.`
    : head + 'Run buddi doctor in a terminal; it prints the way back.';
}

/** The last attempt, when it failed in the last quarter of an hour. */
export function recentFailure(history: UpgradeAttempt[], now = Date.now()): UpgradeAttempt | null {
  const last = history[history.length - 1];
  if (last?.outcome !== 'failed') return null;
  const at = Date.parse(last.finishedAt ?? last.startedAt);
  return Number.isFinite(at) && now - at < RECENT_FAILURE_MS ? last : null;
}

/** What the page is watching, and what it has to say about it. */
interface UpgradeWatch {
  job: UpgradeJob | undefined;
  error: string | null;
}

/**
 * One upgrade, followed for as long as the gateway reporting it answers.
 *
 * The restart screen (`shell/Restarting.tsx`) is up from the moment the
 * upgrade starts, and this feeds it the step. A gateway that stops answering
 * is the upgrade doing what it said it would: the screen waits for the new
 * process and reloads the page, and a failure after the hand-over is read off
 * the record on the reloaded page (`recentFailure`). A failure *before* the
 * hand-over is the end of it here: the screen goes and the page says so.
 */
function useUpgrade(id: string | null, onFailed?: (job: UpgradeJob) => void): UpgradeWatch {
  const [job, setJob] = useState<UpgradeJob | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref so that a caller passing a fresh closure on every render
  // does not tear the poll down and start it again on every render.
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      return undefined;
    }
    let stopped = false;
    let lost = false;
    const ask = (): void => {
      if (stopped || lost) return;
      api
        .upgradeJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          setError(null);
          updateRestart({ step: UPGRADE_PHASES[next.phase] ?? next.detail ?? next.phase });
          if (UPGRADE_ENDED.has(next.phase) || next.finishedAt) {
            // Nothing follows an ended job: a failure before the hand-over is
            // the end of this upgrade, and the button is the owner's again.
            stopped = true;
            if (next.phase === 'failed') {
              cancelRestart();
              failedRef.current?.(next);
            }
          }
        })
        .catch((err: unknown) => {
          if (stopped) return;
          // A refusal while the old gateway still answers is news; a gateway
          // that stopped answering is the upgrade, and the screen's to watch.
          if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
            stopped = true;
            cancelRestart();
            setError(err.message);
          } else lost = true;
        });
    };
    ask();
    const timer = window.setInterval(ask, UPGRADE_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [id]);
  return { job, error };
}

/**
 * Settings → System, first panel: what is running, what is newest, and the one
 * button that changes the first into the second.
 *
 * The check is an outbound call and says so next to the switch that makes it
 * daily. The upgrade is the supervisor's work; this page only starts it and
 * then waits to be replaced. A checkout has neither, and gets the command.
 */
export function Version(): JSX.Element {
  /*
   * In buddi.app the app reads the same supervisor answer for its menu and
   * its one alert; asked again every minute here, the panel never says
   * "latest" while the menu says "Update to …".
   */
  const [inApp, setInApp] = useState(false);
  const view = useAsync(() => api.version(), [], inApp ? APP_VERSION_POLL_MS : undefined);
  useEffect(() => { if (view.data?.app === true) setInApp(true); }, [view.data?.app]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /*
   * An upgrade that failed before the hand-over: buddi is still running on the
   * version it had, so the page keeps what happened on screen and gives the
   * button back rather than following a job that has already ended.
   */
  const [ended, setEnded] = useState<UpgradeJob | null>(null);
  const onFailed = useCallback((job: UpgradeJob): void => { setJobId(null); setEnded(job); }, []);
  const upgrade = useUpgrade(jobId, onFailed);
  const data = view.data;

  const check = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .checkVersion()
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => { setBusy(false); view.reload(); });
  };
  const daily = (enabled: boolean): void => {
    setBusy(true);
    setFailed(null);
    api
      .setVersionCheck(enabled)
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => { setBusy(false); view.reload(); });
  };
  const start = (): void => {
    setBusy(true);
    setFailed(null);
    setEnded(null);
    void restartWhile(
      {
        kind: 'upgrade',
        line: data?.latest ? `Upgrading to ${data.latest}…` : 'Upgrading…',
        step: UPGRADE_PHASES.starting,
        patienceMs: UPGRADE_PATIENCE_MS,
      },
      () => api.startUpgrade(data?.latest),
    )
      .then((answer) => { setAsking(false); setJobId(answer?.job?.id ?? null); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  if (data?.checkout) {
    return (
      <Section title="Version" panel>
        <Stack divided>
          <Section>
            <KV items={[{ label: 'Running', value: <span className="mono">{data.current}</span> }]} />
          </Section>
          <Section>
            <p className="ui-card-meta">{CHECKOUT_UPGRADE_LINE}</p>
          </Section>
        </Stack>
      </Section>
    );
  }

  return (
    <Section title="Version" panel>
      <Stack divided>
        <Section>
          <Stack gap="sm">
            <ErrorBanner message={view.error ?? failed} />
            <KV
              items={[
                { label: 'Running', value: data ? <span className="mono">{data.current}</span> : '…' },
                {
                  label: 'Newest',
                  value: !data
                    ? '…'
                    : data.updateAvailable && data.latest
                      ? <span>A newer buddi is available: <span className="mono">{data.latest}</span></span>
                      : data.processing
                        ? <span>{data.processing.message}</span>
                        : data.checkedAt
                        ? <span>This is the latest, as of {fmtRelative(data.checkedAt)}.</span>
                        : <span>Not checked yet.</span>,
                },
              ]}
            />
            {data?.error ? <Notice tone="warning">The last check did not get an answer: {data.error}</Notice> : null}
            <Toolbar align="end">
              <Button disabled={busy} onClick={check}>
                Check now
              </Button>
            </Toolbar>
          </Stack>
        </Section>
        <Section>
          <Stack gap="sm">
            <label className="backup-check">
              <input
                type="checkbox"
                checked={data?.checkEnabled ?? false}
                disabled={busy || !data}
                onChange={(event) => daily(event.target.checked)}
              />
              <span>Check once a day</span>
            </label>
            <p className="ui-card-meta">{CHECK_DISCLOSURE}</p>
          </Stack>
        </Section>
        {data?.updateAvailable && data.latest && data.latestNotes ? (
          <Section title={`What changes in ${data.latest}`}>
            <Markdown text={data.latestNotes} />
          </Section>
        ) : null}
        <Section>
          <Stack gap="sm">
            <UpgradeProgress {...upgrade} job={upgrade.job ?? ended ?? undefined} />
            {!upgrade.job && !ended && !upgrade.error && data && recentFailure(data.history) ? (
              <Notice tone="critical" role="alert">{recoveryLine(recentFailure(data.history)!, data.app === true)}</Notice>
            ) : null}
            {asking ? (
              <Notice tone="warning" role="alert">
                {updateWords(data?.app === true, data?.latest).warning}
              </Notice>
            ) : null}
            <Toolbar align="end">
              {asking ? (
                <>
                  <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
                    Cancel
                  </Button>
                  <Button variant="accent" disabled={busy} onClick={start}>
                    {updateWords(data?.app === true, data?.latest).button}
                  </Button>
                </>
              ) : data?.processing && jobId === null ? null : (
                <Button
                  variant="accent"
                  disabled={busy || jobId !== null || !data?.updateAvailable}
                  onClick={() => setAsking(true)}
                >
                  {updateWords(data?.app === true, data?.updateAvailable ? data.latest : undefined).button}
                </Button>
              )}
            </Toolbar>
          </Stack>
        </Section>
        {data && data.history.length > 0 ? (
          <Section title="Upgrades so far">
            <KV
              items={data.history
                .slice()
                .reverse()
                .map((attempt) => ({
                  key: attempt.startedAt,
                  label: <span className="mono">{attempt.from} → {attempt.to}</span>,
                  value: <UpgradeOutcome attempt={attempt} />,
                }))}
            />
          </Section>
        ) : null}
      </Stack>
    </Section>
  );
}

/** Where an upgrade has got to, or what it left behind when it stopped. */
function UpgradeProgress({ job, error }: UpgradeWatch): JSX.Element | null {
  if (error) return <ErrorBanner message={error} />;
  if (!job) return null;
  if (job.phase === 'failed') {
    return (
      <Notice tone="critical" role="alert">
        {UPGRADE_PHASES.failed} {job.error ?? ''} buddi is still running on the version it had.
      </Notice>
    );
  }
  return (
    <Notice tone={job.phase === 'done' ? 'good' : undefined} role="status">
      {UPGRADE_PHASES[job.phase] ?? job.detail ?? job.phase}
    </Notice>
  );
}

/** One line of history: when, how it ended, and the backup it took first. */
function UpgradeOutcome({ attempt }: { attempt: UpgradeAttempt }): JSX.Element {
  return (
    <span>
      <Pill tone={attempt.outcome === 'done' ? 'good' : attempt.outcome === 'failed' ? 'critical' : 'warning'}>
        {attempt.outcome}
      </Pill>{' '}
      {fmtRelative(attempt.startedAt)}
      {attempt.step ? `, at ${attempt.step}` : ''}
      {attempt.error ? `: ${attempt.error}` : ''}
      {attempt.backup ? <span className="ui-card-meta"> Backup: <span className="mono">{attempt.backup}</span></span> : null}
    </span>
  );
}

/** `#/settings/memory?tab=notes` opens that tab; anything else opens People. */
export function memoryTabOf(hash: string): 'people' | 'preferences' | 'notes' {
  const tab = /[?&]tab=(people|preferences|notes)\b/.exec(hash)?.[1];
  return (tab as 'people' | 'preferences' | 'notes' | undefined) ?? 'people';
}
