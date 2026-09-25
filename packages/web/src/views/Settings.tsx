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
import { ApiError, api, type TailscaleView, type UpgradeAttempt, type UpgradeJob } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { parseProposalsFilter, parsePluginSettingsRoute, settingsSectionOf } from '../routes';
import { NARROW_QUERY, useMediaQuery } from '../useMediaQuery';
import { PluginSettingsPage } from '../pages/PluginPage';
import { usePluginPages } from '../pages/usePages';
import { useAppearance, type Ground, type PageWidth } from '../appearance';
import type { ThemeChoice } from '../theme';
import { Button, Empty, ErrorBanner, Field, KV, Notice, Pill, Section, Segment, Stack, Toolbar, useAsync } from '../ui';
import { Backup } from './Backup';
import { Browser } from './Browser';
import { Providers } from './Providers';
import { Secrets } from './Secrets';
import { Watchers } from './Watchers';
import { You } from './You';
import { Memory } from './Memory';
import { Markdown } from '../chat/markdown';
import { Proposals } from './Proposals';
import { Plugins } from './Plugins';
import { SettingsMenu, SettingsNav, settingsEntries } from './SettingsNav';

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
  const narrow = useMediaQuery(NARROW_QUERY);
  const entries = settingsEntries(plugins.settings);
  // The counts the sections already keep: the proposals still open.
  const proposals = useAsync(() => Promise.resolve().then(() => api.proposals()), [], 30_000);
  const counts = { proposals: proposals.data?.open?.length ?? 0 };
  const list = { entries, active: section, counts, navigate: (route: string) => navigate(route) };
  return (
    <div className="settings">
      {narrow ? null : <SettingsNav {...list} />}
      <div className="settings-body">
        <div className="ui-page">
          <header className="ui-page-head">
            <h2 className="ui-page-title">Settings</h2>
            <p className="ui-page-lede">How this installation runs, and where it reaches.</p>
          </header>
          {narrow ? <SettingsMenu {...list} /> : null}
          {pluginPage ? (
            <PluginSettingsPage
              page={pluginPage}
              navigate={navigate}
              timezone={timezone}
              siblings={plugins.all.filter((p) => p.plugin === pluginPage.plugin)}
            />
          ) : null}
          {section === 'you' ? <You embedded /> : null}
          {section === 'appearance' ? <AppearanceSection /> : null}
          {section === 'memory' ? <Memory embedded agents={agents} timezone={timezone} /> : null}
          {section === 'proposals' ? <Proposals embedded plugin={parseProposalsFilter(hash)} /> : null}
          {section === 'accounts' ? <Providers embedded /> : null}
          {section === 'computer' ? <Browser embedded timezone={timezone} /> : null}
          {section === 'secrets' ? <Secrets embedded timezone={timezone} /> : null}
          {section === 'watchers' ? <Watchers timezone={timezone} embedded /> : null}
          {section === 'backup' ? <Backup /> : null}
          {section === 'plugins' ? <Plugins /> : null}
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
function AppearanceSection(): JSX.Element {
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
      </Stack>
    </Section>
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
      <Tailscale />
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
    </Stack>
  );
}

/**
 * Settings → System: signing in through Tailscale.
 *
 * The switch is the whole feature, and the sentence under it is the part that
 * matters: turning this on means anyone signed in to Tailscale as that login,
 * on any device in the tailnet, is signed in to buddi. The command is printed
 * with this installation's own ports in it, because the proxy has to run on
 * the machine buddi runs on and nowhere else.
 *
 * Seen through Tailscale, everything here is read-only: the setting that let
 * this browser in cannot be widened from the far end of it.
 */
export function Tailscale(): JSX.Element {
  const view = useAsync(() => api.tailscale(), []);
  const [login, setLogin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const data: TailscaleView | undefined = view.data;
  // A stored login wins; with none, the machine's own is the obvious guess.
  const value = login ?? (data?.login || data?.self?.login || '');
  const locked = data?.proxied === true;
  const save = (enabled: boolean): void => {
    setBusy(true);
    setFailed(null);
    setSaved(false);
    api
      .setTailscale({ enabled, login: value.trim() })
      .then(() => { setSaved(true); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => { setBusy(false); view.reload(); });
  };
  return (
    <Section
      title="Sign in through Tailscale"
      panel
      foot={
        <Button variant="accent" disabled={busy || !data || locked} onClick={() => save(data?.enabled ?? false)}>
          Save
        </Button>
      }
    >
      <Stack divided>
        <Section>
          <Stack gap="sm">
            <ErrorBanner message={view.error ?? failed} />
            <p className="ui-card-meta">
              {!data
                ? '…'
                : data.available && data.self
                  ? `Tailscale is running on this machine as ${data.self.login}.`
                  : data.available
                    ? 'Tailscale is running on this machine.'
                    : 'Tailscale is not running here.'}
            </p>
            {locked ? (
              <>
                <Notice tone="warning">Change this from the computer buddi runs on.</Notice>
                {/* Locked controls are greyed, and greyed controls are read by
                    squinting. The setting says itself in a sentence instead. */}
                <p className="ui-card-meta">{data?.enabled ? `On, for ${value}` : 'Off'}</p>
              </>
            ) : null}
            <label className="backup-check">
              <input
                type="checkbox"
                checked={data?.enabled ?? false}
                disabled={busy || !data || locked}
                onChange={(event) => save(event.target.checked)}
              />
              <span>Let this Tailscale login sign in</span>
            </label>
            <Field label="Tailscale login">
              <input
                type="text"
                value={value}
                placeholder="you@example.com"
                disabled={busy || !data || locked}
                onChange={(event) => setLogin(event.target.value)}
              />
            </Field>
            <p className="ui-card-meta">
              Anyone signed in to Tailscale as this login, on any device in your tailnet, is signed in to buddi.
              The proxy must run on this machine:
            </p>
            {/* The command is a thing to copy, not a phrase to read: its own
                line, with the button that takes it beside it. */}
            <div className="tailscale-command">
              <code className="mono">{data?.serveCommand ?? 'tailscale serve'}</code>
              <Button size="sm" disabled={busy || !data} onClick={() => { void copyText(data?.serveCommand ?? ''); }}>
                Copy
              </Button>
            </div>
            <p className="ui-card-meta">
              This gives your tailnet the trust this machine already has: buddi cannot tell the Tailscale proxy from
              another program running here, and any program that can reach the dashboard on this machine can already
              read buddi&rsquo;s files.
            </p>
            {saved ? <Notice tone="good" role="status">Saved.</Notice> : null}
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}

/** Put a command on the clipboard, where there is one. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* A browser that refuses the clipboard leaves the command on screen to select. */
  }
}

/**
 * The supervisor's switches, when there is a supervisor.
 *
 * A packaged installation runs the gateway as a supervised child, so the
 * database can stay up while the gateway restarts. A developer checkout has no
 * supervisor and this section is simply absent — there is nothing here to
 * control and no command to recommend.
 *
 * Stop and restart end the process serving this page, which is why both ask
 * once before they act and say what will happen.
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
    void api
      .serviceAction(action)
      .then(() => { setPending(null); })
      .catch((error: Error) => { setFailed(error.message); })
      .finally(() => { setBusy(false); view.reload(); });
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
                  : 'Restarting the gateway closes this dashboard for a few seconds. If it does not come back on its own, run buddi in a terminal.'}
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
  'This takes a backup, installs the new version and restarts buddi. This page closes and comes back on its own.';

/** The one line a checkout gets instead of an upgrade button. */
const CHECKOUT_UPGRADE_LINE = 'A checkout upgrades with git pull, then buddi upgrade in a terminal.';

/**
 * How long a page waits for a buddi that went away to come back.
 *
 * Long enough for a backup-sized restart on a slow disk, short enough that an
 * owner is not left watching a spinner into the evening. What ends the wait is
 * a sentence naming the one command that can still say what happened.
 */
const UPGRADE_RETURN_MS = 10 * 60_000;

/** The end of the wait, when nothing came back. */
const NEVER_CAME_BACK = 'buddi did not come back. Run buddi doctor in a terminal.';

/** The way back from an upgrade that failed under the new code. */
export function recoveryLine(attempt: UpgradeAttempt): string {
  const where = attempt.step === 'starting' ? 'while starting' : `at ${attempt.step ?? 'an unknown step'}`;
  return `The upgrade to ${attempt.to} failed ${where}: ${attempt.error ?? 'no reason given'}. ` +
    `The backup taken first is ${attempt.backup ?? 'not available'}. Run buddi doctor in a terminal; it prints the way back.`;
}

/** What the page is watching, and what it has to say about it. */
interface UpgradeWatch {
  job: UpgradeJob | undefined;
  away: boolean;
  error: string | null;
}

/**
 * One upgrade, watched past the death of the gateway reporting it.
 *
 * An upgrade restarts buddi, so losing contact is part of the job rather than
 * an error: the poll keeps asking, and once the gateway is gone the question
 * becomes `/api/session` — which answers again when the *new* gateway is up.
 * A different version in that answer is what "it came back" means, and then
 * the only honest thing is to reload, because this page was served by code
 * that no longer runs.
 *
 * Two things end the wait instead. A gateway that answers again on the old
 * version while `/api/version` — which the supervisor writes to disk, so it
 * outlives both — says the last attempt failed: that is the upgrade having
 * failed and buddi having been started again, and the page says so rather
 * than waiting for a version that is never coming. And a deadline, because
 * "restarting" with nothing behind it is the one state a page must not show
 * for ever.
 */
function useUpgrade(
  id: string | null,
  startedOn: string | undefined,
  reload: () => void,
  onFailed?: (job: UpgradeJob) => void,
): UpgradeWatch {
  const [job, setJob] = useState<UpgradeJob | undefined>(undefined);
  const [away, setAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lost = useRef(false);
  // Held in refs so that a caller passing a fresh closure on every render does
  // not tear the poll down and start it again on every render.
  const reloadRef = useRef(reload);
  const failedRef = useRef(onFailed);
  reloadRef.current = reload;
  failedRef.current = onFailed;
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      setAway(false);
      lost.current = false;
      return undefined;
    }
    let stopped = false;
    let deadline = 0;
    const gone = (): void => {
      lost.current = true;
      deadline = Date.now() + UPGRADE_RETURN_MS;
      setAway(true);
    };
    const waiting = (): void => {
      if (Date.now() < deadline) {
        // Has a gateway come back, and is it a new one?
        void api.session()
          .then((next) => {
            if (stopped) return;
            if (next.version !== undefined && next.version === startedOn) return;
            stopped = true;
            reloadRef.current();
          })
          .catch(() => {});
        // Whatever is answering, the record on disk is what says how it ended.
        void api.version()
          .then((view) => {
            const last = view.history[view.history.length - 1];
            if (stopped || last?.outcome !== 'failed') return;
            stopped = true;
            setAway(false);
            setError(recoveryLine(last));
          })
          .catch(() => {});
        return;
      }
      stopped = true;
      setAway(false);
      setError(NEVER_CAME_BACK);
    };
    const ask = (): void => {
      if (stopped) return;
      if (lost.current) return waiting();
      api
        .upgradeJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          setError(null);
          if (UPGRADE_ENDED.has(next.phase) || next.finishedAt) {
            // Nothing follows an ended job: a failure before the hand-over is
            // the end of this upgrade, and the button is the owner's again.
            stopped = true;
            if (next.phase === 'failed') failedRef.current?.(next);
          }
        })
        .catch((err: unknown) => {
          if (stopped) return;
          // A refusal is news; a gateway that stopped answering is the upgrade
          // doing exactly what it said it would.
          if (err instanceof ApiError && err.status !== 0 && err.status < 500) setError(err.message);
          else gone();
        });
    };
    ask();
    const timer = window.setInterval(ask, UPGRADE_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [id, startedOn]);
  return { job, away, error };
}

/**
 * Settings → System, first panel: what is running, what is newest, and the one
 * button that changes the first into the second.
 *
 * The check is an outbound call and says so next to the switch that makes it
 * daily. The upgrade is the supervisor's work; this page only starts it and
 * then waits to be replaced. A checkout has neither, and gets the command.
 */
export function Version({ reload }: { reload?: () => void }): JSX.Element {
  const view = useAsync(() => api.version(), []);
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
  const startedOn = view.data?.current;
  const reloadPage = reload ?? ((): void => window.location.reload());
  const onFailed = useCallback((job: UpgradeJob): void => { setJobId(null); setEnded(job); }, []);
  const upgrade = useUpgrade(jobId, startedOn, reloadPage, onFailed);
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
    api
      .startUpgrade(data?.latest)
      .then((answer) => { setAsking(false); setJobId(answer.job?.id ?? null); })
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
            {asking ? (
              <Notice tone="warning" role="alert">
                {UPGRADE_WARNING}
              </Notice>
            ) : null}
            <Toolbar align="end">
              {asking ? (
                <>
                  <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
                    Cancel
                  </Button>
                  <Button variant="accent" disabled={busy} onClick={start}>
                    Upgrade to {data?.latest}
                  </Button>
                </>
              ) : (
                <Button
                  variant="accent"
                  disabled={busy || jobId !== null || !data?.updateAvailable}
                  onClick={() => setAsking(true)}
                >
                  {data?.updateAvailable && data.latest ? `Upgrade to ${data.latest}` : 'Upgrade'}
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
function UpgradeProgress({ job, away, error }: UpgradeWatch): JSX.Element | null {
  if (error) return <ErrorBanner message={error} />;
  if (away) {
    return (
      <Notice tone="warning" role="status">
        buddi is restarting. This page comes back on its own when it answers again.
      </Notice>
    );
  }
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
