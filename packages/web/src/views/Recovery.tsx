/**
 * Recovery mode: what a restored installation says, and how it is left.
 *
 * A buddi that came back from a backup holds everything except the things a
 * backup deliberately never carries — keys, tokens, the plugins themselves —
 * and it deliberately runs nothing on its own until a person has looked at
 * what is missing. That is two pieces of screen: a banner on every page, and
 * the checklist at the top of Settings → Backup, which ends in the one action
 * that turns the installation back on.
 *
 * The banner is read from `/api/recovery` rather than from the shell's own
 * state, because recovery outlives a reload and is true of the installation
 * rather than of this page.
 */
import { useState } from 'react';
import { api, ApiError, type RecoveryView } from '../api';
import { BACKUP_ROUTE } from '../routes';
import { Button, Empty, ErrorBanner, KV, Notice, Panel, Section, Stack, Toolbar, useAsync } from '../ui';

/** How often a page asks whether recovery is still on. Slow: it rarely changes. */
const POLL_MS = 30_000;

export function useRecovery(): { data: RecoveryView | undefined; reload: () => void } {
  const { data, reload } = useAsync(() => api.recovery(), [], POLL_MS);
  return { data, reload };
}

export const RECOVERY_BANNER =
  'This buddi was restored from a backup. Nothing runs on its own until you finish the checklist.';

/**
 * The banner, above every page.
 *
 * It is a link rather than a button: the owner may be halfway through
 * something, and the checklist is a place, not an action.
 */
export function RecoveryBanner({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate: (route: string) => void;
}): JSX.Element | null {
  if (!active) return null;
  return (
    <div className="recovery-banner" role="status">
      <span>{RECOVERY_BANNER}</span>
      <a
        href={BACKUP_ROUTE}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(BACKUP_ROUTE);
        }}
      >
        Finish the checklist
      </a>
    </div>
  );
}

/**
 * What is left to do, and the one way out.
 *
 * Every row is something the restore could not bring back or deliberately did
 * not start. The defaults are the safe ones: pending work is dropped, because
 * a job queued days ago on another machine is usually not wanted now, and a
 * standing permission is dropped unless the owner says to keep it.
 */
export function RecoveryChecklist({
  view,
  onLeft,
}: {
  view: RecoveryView;
  onLeft?: () => void;
}): JSX.Element {
  const { secrets, plugins, pending, grants } = view.checklist;
  const [dropPending, setDropPending] = useState(true);
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const missingPlugins = plugins.filter((plugin) => !plugin.installed);
  const pendingTotal = pending.jobs + pending.missions + pending.approvals + pending.telegramChats;

  const toggle = (id: string): void => {
    setKeep((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  };

  const leave = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .leaveRecovery({ dropPending, keepGrants: keep })
      .then(() => {
        setLeft(true);
        onLeft?.();
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Panel title="Back from a backup">
      <Stack divided>
        <Section>
          <KV
            items={[
              { label: 'Restored', value: view.restoredAt ?? 'just now' },
              { label: 'From', value: <span className="mono">{view.archive ?? '—'}</span> },
            ]}
          />
          <p className="ui-card-meta">
            Nothing runs on its own yet: no schedules, no watchers, no phone. Chat works. Go through
            what is below, then turn this buddi back on.
          </p>
        </Section>

        <Section title="Keys to paste again">
          {secrets.length === 0 ? (
            <Empty>Nothing is missing.</Empty>
          ) : (
            <ul className="recovery-list">
              {secrets.map((secret) => (
                <li key={`${secret.kind}:${secret.name}`}>
                  {secret.settingsRoute ? <a href={secret.settingsRoute}>{secret.name}</a> : secret.name}{' '}
                  <span className="ui-card-meta">{secret.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Add-ons to install again">
          {missingPlugins.length === 0 ? (
            <Empty>Everything the backup named is installed.</Empty>
          ) : (
            <ul className="recovery-list">
              {missingPlugins.map((plugin) => (
                <li key={plugin.name}>
                  <span className="mono">{plugin.name}</span> {plugin.version}{' '}
                  <span className="ui-card-meta">{plugin.source}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Work that was waiting">
          {pendingTotal === 0 ? (
            <Empty>Nothing was in flight when the backup was taken.</Empty>
          ) : (
            <Stack gap="sm">
              <KV
                items={[
                  { label: 'Jobs', value: String(pending.jobs) },
                  { label: 'Missions', value: String(pending.missions) },
                  { label: 'Waiting for an answer', value: String(pending.approvals) },
                  { label: 'Phones', value: String(pending.telegramChats) },
                ]}
              />
              <label className="recovery-check">
                <input
                  type="checkbox"
                  checked={dropPending}
                  onChange={(event) => setDropPending(event.target.checked)}
                />
                <span>Drop it. It was queued somewhere else, days ago.</span>
              </label>
            </Stack>
          )}
        </Section>

        <Section title="Standing permissions">
          {grants.length === 0 ? (
            <Empty>No agent had a standing permission.</Empty>
          ) : (
            <Stack gap="sm">
              <p className="ui-card-meta">Each of these lets an agent act without asking. Keep only the ones you meant.</p>
              <ul className="recovery-list">
                {grants.map((grant) => (
                  <li key={grant.id}>
                    <label className="recovery-check">
                      <input
                        type="checkbox"
                        checked={keep.includes(grant.id)}
                        onChange={() => toggle(grant.id)}
                        aria-label={`Keep ${grant.tool} for ${grant.agent}`}
                      />
                      <span>
                        <span className="mono">{grant.tool}</span> for {grant.agent}{' '}
                        <span className="ui-card-meta">{grant.scope}</span>
                        {grant.description ? <span className="ui-card-meta"> — {grant.description}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Stack>
          )}
        </Section>

        <Section>
          <Stack gap="sm">
            <ErrorBanner message={failed} />
            {left ? (
              <Notice tone="good" role="status">
                Turning everything back on. This page comes back in a few seconds.
              </Notice>
            ) : (
              <p className="ui-card-meta">
                Leaving starts the schedules, the watchers and the phone again. buddi restarts itself to do it.
              </p>
            )}
            <Toolbar align="end">
              <Button variant="accent" disabled={busy || left} onClick={leave}>
                Leave recovery mode
              </Button>
            </Toolbar>
          </Stack>
        </Section>
      </Stack>
    </Panel>
  );
}
