/**
 * Settings → Notifications (docs/notifications.md).
 *
 * Where buddi reaches you when you are not looking, which kinds go where,
 * the hours it keeps quiet, and the last twenty things it told you. The first
 * three save together; the list below is the record, read only.
 */
import { useState } from 'react';
import {
  ApiError,
  NOTIFICATION_KINDS,
  api,
  type NotificationChannel,
  type NotificationKind,
  type NotificationRow,
  type NotificationSettings,
} from '../api';
import { fmtTime } from '../format';
import { Button, Empty, ErrorBanner, Field, List, ListRow, Notice, Section, Stack, useAsync } from '../ui';

/** Approvals and questions are what the owner asked for by starting the run: never off. */
const ALWAYS_REACH: ReadonlySet<NotificationKind> = new Set(['approval', 'question']);

export const KIND_LABELS: Record<NotificationKind, { label: string; hint: string }> = {
  approval: { label: 'Approvals', hint: 'A run nobody is watching wants to do something gated.' },
  question: { label: 'Questions', hint: 'A run asked you something and waits.' },
  watcher: { label: 'Watchers', hint: 'A watcher or a source found something.' },
  reminder: { label: 'Reminders', hint: 'A reminder an agent promised you came due.' },
  failure: { label: 'Failures', hint: 'Background jobs died and will not be retried.' },
  recap: { label: 'Reports', hint: 'Mission reports, the weekly recap, answers to actions you tapped.' },
  plugin: { label: 'Plugins', hint: 'A plugin that may send you messages has something to say.' },
};

export function Notifications({ timezone }: { timezone: string }): JSX.Element {
  const view = useAsync(() => api.notificationSettings(), []);
  const recent = useAsync(() => api.notifications(20), [], 30_000);
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const channels = view.data?.channels ?? [];
  const settings = draft ?? view.data?.settings;
  const change = (patch: Partial<NotificationSettings>): void => {
    if (!settings) return;
    setSaved(false);
    setDraft({ ...settings, ...patch });
  };

  const save = (): void => {
    if (!settings) return;
    setBusy(true);
    setSaved(false);
    setFailed(null);
    api
      .saveNotificationSettings(settings)
      .then(() => { setSaved(true); setDraft(null); view.reload(); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Stack gap="lg">
      <Section
        title="Notifications"
        aside="What buddi tells you when you are not looking at this page."
        panel
        foot={<Button variant="accent" disabled={busy || !settings} onClick={save}>Save</Button>}
      >
        <Stack divided>
          <ErrorBanner message={view.error ?? failed} />
          <Section title="Where buddi reaches you">
            {!settings ? (
              <Empty>Loading…</Empty>
            ) : channels.length === 0 ? (
              <p className="ui-card-meta">
                No channel yet, so everything waits for you here. Pair Telegram and buddi can reach you on your phone.
              </p>
            ) : (
              <Stack gap="sm">
                {channels.map((channel) => (
                  <ChannelRow
                    key={channel.kind}
                    channel={channel}
                    checked={(settings.defaultChannel ?? channels[0]?.kind) === channel.kind}
                    onPick={() => change({ defaultChannel: channel.kind })}
                  />
                ))}
              </Stack>
            )}
          </Section>

          <Section title="By kind">
            {settings ? (
              <Stack gap="sm">
                {NOTIFICATION_KINDS.map((kind) => (
                  <div key={kind} className="pref-row nt-kind">
                    <div className="pref-text">
                      <span className="pref-label">{KIND_LABELS[kind].label}</span>
                      <span className="ui-field-hint">{KIND_LABELS[kind].hint}</span>
                    </div>
                    <select
                      aria-label={KIND_LABELS[kind].label}
                      value={kindValue(settings, kind, channels)}
                      onChange={(e) => {
                        const perKind = { ...settings.perKind };
                        if (e.target.value === 'default') delete perKind[kind];
                        else perKind[kind] = e.target.value;
                        change({ perKind });
                      }}
                    >
                      <option value="default">Default</option>
                      {channels.map((channel) => (
                        <option key={channel.kind} value={channel.kind}>{channel.label}</option>
                      ))}
                      {ALWAYS_REACH.has(kind) ? null : <option value="off">Off</option>}
                    </select>
                  </div>
                ))}
                <p className="ui-field-hint">Off keeps it in the list below and never sends it.</p>
              </Stack>
            ) : null}
          </Section>

          <Section title="Quiet hours">
            {settings ? (
              <Stack gap="sm">
                <div className="nt-times">
                  <Field label="From">
                    <input type="time" value={settings.quietStart ?? ''} onChange={(e) => change({ quietStart: e.target.value || null })} />
                  </Field>
                  <Field label="Until">
                    <input type="time" value={settings.quietEnd ?? ''} onChange={(e) => change({ quietEnd: e.target.value || null })} />
                  </Field>
                  <Field label="End of the day">
                    <input type="time" value={settings.endOfDay} onChange={(e) => change({ endOfDay: e.target.value })} />
                  </Field>
                </div>
                <p className="ui-field-hint">
                  Messages wait until quiet hours end. Approvals and questions still come through. At the end of the day,
                  what could wait goes out as one message. Times are on your clock ({timezone}).
                </p>
              </Stack>
            ) : null}
          </Section>
          {saved ? <Notice tone="good" role="status">Saved.</Notice> : null}
        </Stack>
      </Section>

      <Section title="The last twenty" panel flush>
        <ErrorBanner message={recent.error} />
        {!recent.data ? (
          <Empty>Loading…</Empty>
        ) : recent.data.notifications.length === 0 ? (
          <Empty>Nothing yet. What buddi tells you will be listed here.</Empty>
        ) : (
          <List>
            {recent.data.notifications.map((row) => (
              <ListRow
                key={row.id}
                title={row.title}
                sub={`${fmtTime(row.createdAt, timezone)} · ${KIND_LABELS[row.kind].label.toLowerCase()} · ${whereItWent(row, channels)}`}
                side={<RowState row={row} />}
              />
            ))}
          </List>
        )}
      </Section>
    </Stack>
  );
}

function ChannelRow({ channel, checked, onPick }: { channel: NotificationChannel; checked: boolean; onPick: () => void }): JSX.Element {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const test = (): void => {
    setSending(true);
    setResult(null);
    api
      .testChannel(channel.kind)
      .then(() => setResult({ ok: true, text: 'Sent. Check that it arrived.' }))
      .catch((error: unknown) => setResult({ ok: false, text: error instanceof ApiError ? error.message : String(error) }))
      .finally(() => setSending(false));
  };
  return (
    <div className="nt-channel">
      <label>
        <input type="radio" name="nt-default-channel" checked={checked} onChange={onPick} />
        <span className="nt-channel-text">
          <span className="pref-label">{channel.label}{channel.where ? `, ${channel.where}` : ''}</span>
          <span className="ui-field-hint">The title and a few lines of each message go to {channel.label}.</span>
          {result ? <span className="nt-channel-sent" data-tone={result.ok ? undefined : 'critical'} role="status">{result.text}</span> : null}
        </span>
      </label>
      <Button size="sm" disabled={sending} onClick={test}>Send a test</Button>
    </div>
  );
}

/** The select's value for a kind: its own channel, `off`, or `default` when it names nothing there is. */
function kindValue(settings: NotificationSettings, kind: NotificationKind, channels: readonly NotificationChannel[]): string {
  const own = settings.perKind[kind];
  if (own === 'off') return ALWAYS_REACH.has(kind) ? 'default' : 'off';
  if (own && channels.some((c) => c.kind === own)) return own;
  return 'default';
}

function whereItWent(row: NotificationRow, channels: readonly NotificationChannel[]): string {
  if (row.channel && row.channel !== 'dashboard') return channels.find((c) => c.kind === row.channel)?.label ?? row.channel;
  return 'dashboard';
}

function RowState({ row }: { row: NotificationRow }): JSX.Element {
  if (row.state === 'failed') return <span className="nt-state" data-tone="critical">Failed: {row.error ?? 'no reason given'}</span>;
  if (row.actedAt) return <span className="nt-state">Acted on</span>;
  if (row.seenAt) return <span className="nt-state">Seen</span>;
  if (row.state === 'held') return <span className="nt-state">Waiting</span>;
  if (row.state === 'stored') return <span className="nt-state">Kept</span>;
  if (row.state === 'sent') return <span className="nt-state">Sent</span>;
  return <span className="nt-state">Not seen</span>;
}
