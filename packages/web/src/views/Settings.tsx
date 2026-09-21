/**
 * Settings: the installation, in four sections. Model accounts, the computer
 * and browser the agents may drive, the watchers that check, and the system
 * itself. Nothing here is a page an owner visits daily, which is why it is
 * behind the gear and not on the rail's first screen.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlaceProps } from '../App';
import { ApiError, api, type UpgradeAttempt, type UpgradeJob } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { SETTINGS_SECTIONS, WELCOME_ROUTE, settingsRoute } from '../routes';
import { Button, Empty, ErrorBanner, KV, Notice, Panel, Pill, Section, Stack, Tab, Tabs, Toolbar, useAsync } from '../ui';
import { Backup } from './Backup';
import { Browser } from './Browser';
import { Providers } from './Providers';
import { Watchers } from './Watchers';
import { You } from './You';
import { Memory } from './Memory';
import { Plugins } from './Plugins';

export function Settings({ hash, timezone, navigate, agents }: PlaceProps): JSX.Element {
  const section = /^#\/settings\/([a-z]+)/.exec(hash)?.[1] ?? 'you';
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  return (
    <div className="ui-page">
      <header className="ui-page-head">
        <h2 className="ui-page-title">Settings</h2>
        <p className="ui-page-lede">How this installation runs. Changes here apply to new runs; a run already in flight finishes on what it started with.</p>
      </header>
      <Tabs>
        {SETTINGS_SECTIONS.map((s) => (
          <Tab key={s.id} href={settingsRoute(s.id)} active={section === s.id} onClick={go(settingsRoute(s.id))}>
            {s.label}
          </Tab>
        ))}
      </Tabs>
      {section === 'you' ? <You embedded /> : null}
      {section === 'memory' ? <Memory embedded agents={agents} timezone={timezone} /> : null}
      {section === 'accounts' ? <Providers embedded /> : null}
      {section === 'computer' ? <Browser embedded /> : null}
      {section === 'watchers' ? <Watchers timezone={timezone} embedded /> : null}
      {section === 'backup' ? <Backup /> : null}
      {section === 'plugins' ? <Plugins /> : null}
      {section === 'system' ? <System timezone={timezone} /> : null}
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
        <Panel title="The queue">
          <Stack>
            <p className="ui-card-meta">
              {data.paused ? 'Paused. Nothing is being claimed until you resume.' : 'Running. Jobs are claimed as they come due.'}{' '}
              {data.paused ? <Pill tone="warning">paused</Pill> : <Pill tone="good">running</Pill>}
            </p>
            <div className="ui-toolbar">
              <Button variant={data.paused ? 'accent' : undefined} onClick={() => { void api.setPaused(!data.paused).then(() => overview.reload()); }}>
                {data.paused ? 'Resume the queue' : 'Pause the queue'}
              </Button>
            </div>
          </Stack>
        </Panel>
      ) : null}
      <Panel title="This host">
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
      </Panel>
      <Panel title="First run">
        <p className="ui-card-meta">
          The setup screens — you, a model account, an agent — are always there.{' '}
          <a href={WELCOME_ROUTE}>Run setup again</a>. Nothing is undone by opening them; each screen saves
          what you change and leaves the rest alone.
        </p>
      </Panel>
      <Service />
      <Panel title="Mail and sources">
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
      </Panel>
    </Stack>
  );
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
    <Panel title="Service">
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
    </Panel>
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
 * One upgrade, watched past the death of the gateway reporting it.
 *
 * An upgrade restarts buddi, so losing contact is part of the job rather than
 * an error: the poll keeps asking, and once the gateway is gone the question
 * becomes `/api/session` — which answers again when the *new* gateway is up.
 * A different version in that answer is what "it came back" means, and then
 * the only honest thing is to reload, because this page was served by code
 * that no longer runs.
 */
function useUpgrade(
  id: string | null,
  startedOn: string | undefined,
  reload: () => void,
): { job: UpgradeJob | undefined; away: boolean; error: string | null } {
  const [job, setJob] = useState<UpgradeJob | undefined>(undefined);
  const [away, setAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lost = useRef(false);
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      setAway(false);
      lost.current = false;
      return undefined;
    }
    let stopped = false;
    const gone = (): void => {
      lost.current = true;
      setAway(true);
    };
    const ask = (): void => {
      if (lost.current) {
        // The gateway is away. What is being waited for now is a new one, and
        // it is new only if it answers with a version this page did not start on.
        api
          .session()
          .then((next) => {
            if (stopped) return;
            if (next.version !== undefined && next.version === startedOn) return;
            stopped = true;
            reload();
          })
          .catch(() => {});
        return;
      }
      api
        .upgradeJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          setError(null);
          if (UPGRADE_ENDED.has(next.phase) || next.finishedAt) stopped = true;
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
  }, [id, startedOn, reload]);
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
  const startedOn = view.data?.current;
  const reloadPage = reload ?? ((): void => window.location.reload());
  const upgrade = useUpgrade(jobId, startedOn, reloadPage);
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
    api
      .startUpgrade(data?.latest)
      .then((answer) => { setAsking(false); setJobId(answer.job?.id ?? null); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  if (data?.checkout) {
    return (
      <Panel title="Version">
        <Stack divided>
          <Section>
            <KV items={[{ label: 'Running', value: <span className="mono">{data.current}</span> }]} />
          </Section>
          <Section>
            <p className="ui-card-meta">{CHECKOUT_UPGRADE_LINE}</p>
          </Section>
        </Stack>
      </Panel>
    );
  }

  return (
    <Panel title="Version">
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
        <Section>
          <Stack gap="sm">
            <UpgradeProgress {...upgrade} />
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
    </Panel>
  );
}

/** Where an upgrade has got to, or what it left behind when it stopped. */
function UpgradeProgress({ job, away, error }: ReturnType<typeof useUpgrade>): JSX.Element | null {
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
