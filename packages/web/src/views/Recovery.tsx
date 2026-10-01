/**
 * Recovery mode: what a restored installation says, and how it is left.
 *
 * A buddi that came back from a backup holds everything except the things a
 * backup deliberately never carries — keys, tokens, the plugins themselves —
 * and it deliberately runs nothing on its own until a person has looked at
 * what is missing. That is two pieces of screen: the shell's banner (its slot
 * puts recovery first), and
 * the checklist at the top of Settings → Backup, which ends in the one action
 * that turns the installation back on.
 *
 * The banner is read from `/api/recovery` rather than from the shell's own
 * state, because recovery outlives a reload and is true of the installation
 * rather than of this page.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RecoveryView } from '../api';
import {
  PLUGINS_BROWSE_ROUTE,
  accountRoute,
  connectionRoute,
  pluginInstallRoute,
  settingsRoute,
} from '../routes';
import { Button, ButtonLink, Empty, ErrorBanner, KV, List, ListRow, Notice, Panel, Section, Stack, Toolbar, useAsync } from '../ui';
import { cancelRestart, restartWhile } from '../shell/restart';

/** How often a page asks whether recovery is still on. Slow: it rarely changes. */
const POLL_MS = 30_000;

/**
 * The checklist, read again whenever the owner comes back to it: the tab
 * regains focus or becomes visible (they pasted a key in another tab), and on
 * every mount (they followed a Fix link and came back). A fixed item is simply
 * gone from the next read.
 */
export function useRecovery(): { data: RecoveryView | undefined; reload: () => void } {
  const { data, reload } = useAsync(() => api.recovery(), [], POLL_MS);
  // `reload` is a new function every render; the listeners read the latest.
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const again = (): void => latest.current();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return { data, reload };
}

type RecoverySecret = RecoveryView['checklist']['secrets'][number];
type RecoveryPlugin = RecoveryView['checklist']['plugins'][number];

/** Where a missing key is fixed: the account itself, the Telegram setting, or Keys and secrets. */
export function secretFixRoute(secret: RecoverySecret): string {
  if (secret.kind === 'account') return secret.accountId ? accountRoute(secret.accountId) : settingsRoute('accounts');
  if (secret.kind === 'telegram') return settingsRoute('telegram');
  if (secret.kind === 'connection') return secret.connectionId ? connectionRoute(secret.connectionId) : settingsRoute('connections');
  // A mailbox: the gateway says where (its secret's Replace value, or the Email page).
  if (secret.kind === 'email') return secret.settingsRoute;
  return settingsRoute('secrets');
}

/** Where a missing plugin is installed again: staged when it came from npm, else the market. */
export function pluginFixRoute(plugin: RecoveryPlugin): string {
  return plugin.install ? pluginInstallRoute(plugin.install) : PLUGINS_BROWSE_ROUTE;
}

/** Settings → System, where Restart gateway is. */
const SYSTEM_ROUTE = settingsRoute('system');

/** The row's sentence: installed and waiting for a restart, its kept data, or where it came from. */
export function pluginSentence(plugin: RecoveryPlugin): string {
  if (plugin.loadsAtRestart) {
    const data = plugin.waiting ? `; ${plugin.waiting.note}` : '';
    return `installed — loads at the next restart${data}`;
  }
  return plugin.waiting ? `${plugin.name} — ${plugin.waiting.note}` : plugin.source;
}

export const RECOVERY_BANNER =
  'This buddi was restored from a backup. Nothing runs on its own until you finish the checklist.';


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
  const keptTables = view.checklist.keptTables ?? [];
  const [dropPending, setDropPending] = useState(true);
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  // An installed plugin still shows while the data kept for it has not loaded,
  // or while it waits for the restart that loads it.
  const missingPlugins = plugins.filter(
    (plugin) => !plugin.installed || plugin.waiting !== undefined || plugin.loadsAtRestart === true,
  );
  const pendingTotal = pending.jobs + pending.missions + pending.approvals + pending.telegramChats;

  const toggle = (id: string): void => {
    setKeep((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  };

  const leave = (): void => {
    setBusy(true);
    setFailed(null);
    // Leaving is finished by a restart, under "Restarting buddi"; a checkout
    // has no supervisor to restart it and says so in the answer.
    void restartWhile({ kind: 'recovery' }, () => api.leaveRecovery({ dropPending, keepGrants: keep }))
      .then((answer) => {
        if (answer && answer.restarting === false) cancelRestart();
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
            <List>
              {secrets.map((secret) => (
                <ListRow
                  key={`${secret.kind}:${secret.accountId ?? secret.name}`}
                  title={secret.label ?? secret.name}
                  sub={secret.name ? <span className="mono">{secret.name}</span> : undefined}
                  side={
                    secret.signIn ? (
                      <ButtonLink size="sm" href={secretFixRoute(secret)} aria-label={`Sign in again: ${secret.label ?? secret.name}`}>
                        Sign in again
                      </ButtonLink>
                    ) : (
                      <ButtonLink size="sm" href={secretFixRoute(secret)} aria-label={`Fix ${secret.label ?? secret.name}`}>
                        Fix
                      </ButtonLink>
                    )
                  }
                />
              ))}
            </List>
          )}
        </Section>

        <Section title="Add-ons to install again">
          {missingPlugins.length === 0 && keptTables.length === 0 ? (
            <Empty>Everything the backup named is installed.</Empty>
          ) : (
            <List>
              {missingPlugins.map((plugin) => (
                <ListRow
                  key={plugin.name}
                  title={<><span className="mono">{plugin.name}</span> {plugin.version}</>}
                  sub={pluginSentence(plugin)}
                  side={
                    plugin.loadsAtRestart ? (
                      <ButtonLink size="sm" href={SYSTEM_ROUTE} aria-label={`Restart to load ${plugin.name}`}>
                        Restart
                      </ButtonLink>
                    ) : plugin.installed ? undefined : (
                      <ButtonLink size="sm" href={pluginFixRoute(plugin)} aria-label={`Install ${plugin.name} again`}>
                        {plugin.install ? 'Install' : 'Find it'}
                      </ButtonLink>
                    )
                  }
                />
              ))}
              {keptTables.map((kept) => (
                <ListRow
                  key={`kept:${kept.table}`}
                  title={<span className="mono">{kept.table}</span>}
                  sub={kept.sentence}
                />
              ))}
            </List>
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
