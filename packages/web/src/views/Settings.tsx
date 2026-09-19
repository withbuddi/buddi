/**
 * Settings: the installation, in four sections. Model accounts, the computer
 * and browser the agents may drive, the sentinels that watch, and the system
 * itself. Nothing here is a page an owner visits daily, which is why it is
 * behind the gear and not on the rail's first screen.
 */
import type { PlaceProps } from '../App';
import { api } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { SETTINGS_SECTIONS, settingsRoute } from '../routes';
import { Button, Empty, ErrorBanner, KV, Notice, Panel, Pill, Stack, Tab, Tabs, useAsync } from '../ui';
import { Browser } from './Browser';
import { Providers } from './Providers';
import { Sentinels } from './Sentinels';

export function Settings({ hash, timezone, navigate }: PlaceProps): JSX.Element {
  const section = /^#\/settings\/([a-z]+)/.exec(hash)?.[1] ?? 'accounts';
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
      {section === 'accounts' ? <Providers embedded /> : null}
      {section === 'computer' ? <Browser embedded /> : null}
      {section === 'sentinels' ? <Sentinels timezone={timezone} embedded /> : null}
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

export function vaultLabel(kind: string): string {
  return kind === 'keychain' ? 'macOS Keychain' : kind === 'file' ? 'Encrypted file vault' : kind === 'none' ? 'None' : kind;
}
