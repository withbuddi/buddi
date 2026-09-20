/**
 * Settings: the installation, in four sections. Model accounts, the computer
 * and browser the agents may drive, the watchers that check, and the system
 * itself. Nothing here is a page an owner visits daily, which is why it is
 * behind the gear and not on the rail's first screen.
 */
import { useState } from 'react';
import type { PlaceProps } from '../App';
import { api } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { SETTINGS_SECTIONS, WELCOME_ROUTE, settingsRoute } from '../routes';
import { Button, Empty, ErrorBanner, KV, Notice, Panel, Pill, Section, Stack, Tab, Tabs, Toolbar, useAsync } from '../ui';
import { Browser } from './Browser';
import { Providers } from './Providers';
import { Watchers } from './Watchers';
import { You } from './You';
import { Memory } from './Memory';

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
