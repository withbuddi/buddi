/**
 * Settings → Notifications (docs/notifications.md).
 *
 * Where buddi reaches you when you are not looking, which kinds go where,
 * the hours it keeps quiet, and the last twenty things it told you. The first
 * three save together; the list below is the record, read only.
 *
 * Above them, Telegram itself: the bot, the phones paired with it, and
 * pairing another — what the first-run thread offers, for later.
 */
import { useRef, useState } from 'react';
import {
  ApiError,
  NOTIFICATION_KINDS,
  api,
  type NotificationChannel,
  type NotificationKind,
  type NotificationRow,
  type NotificationSettings,
} from '../api';
import { fmtRelative, fmtTime } from '../format';
import { Button, Empty, ErrorBanner, Field, List, ListRow, Notice, Section, Stack, useAsync } from '../ui';
import { PairingSquare, useTelegramPairing } from './parts/TelegramPairing';

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
      <TelegramPanel timezone={timezone} onChange={view.reload} />

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

/**
 * Settings → Notifications → Telegram: the bot, the phones, pairing another.
 *
 * `onChange` is told whenever the bot or the phones change, so the channel
 * list below picks up Telegram the moment it can reach the owner.
 */
function TelegramPanel({ timezone, onChange }: { timezone: string; onChange: () => void }): JSX.Element {
  const bot = useAsync(() => api.telegramBot(), []);
  const devices = useAsync(() => api.telegramDevices(), []);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  /** The phones paired when the code was asked for: a new one is one not in here. */
  const known = useRef<ReadonlySet<string>>(new Set());

  const pairing = useTelegramPairing(
    () => api.telegramDevices().then((list) => list.devices.some((device) => !known.current.has(device.id))),
    () => {
      devices.reload();
      onChange();
    },
  );

  const configured = bot.data?.configured ?? false;
  const showField = !configured || replacing;

  const save = (): void => {
    if (token.trim() === '' || saving) return;
    setSaving(true);
    setNote(null);
    // A running bot keeps its token until buddi starts again.
    const swapped = replacing && (bot.data?.running ?? false);
    api
      .saveTelegramToken(token.trim())
      .then((saved) => {
        setToken('');
        setReplacing(false);
        setNote(
          saved.restartNeeded
            ? { ok: false, text: saved.note ?? 'Saved. It will be ready the next time buddi starts.' }
            : swapped
              ? { ok: true, text: 'Saved. The new bot takes over the next time buddi starts.' }
              : { ok: true, text: 'Saved.' },
        );
        bot.reload();
        onChange();
      })
      .catch((error: unknown) => setNote({ ok: false, text: error instanceof ApiError ? error.message : String(error) }))
      .finally(() => setSaving(false));
  };

  const pair = (): void => {
    setPairError(null);
    known.current = new Set((devices.data?.devices ?? []).map((device) => device.id));
    void pairing.ask().catch((error: unknown) => setPairError(error instanceof ApiError ? error.message : String(error)));
  };

  const { offer, square, paired, stale } = pairing;

  return (
    <Section title="Telegram" aside="Talk to buddi from your phone." panel>
      <Stack divided>
        <Section
          title="The bot"
          foot={showField ? (
            <>
              {replacing ? <Button variant="ghost" onClick={() => { setReplacing(false); setToken(''); }}>Cancel</Button> : null}
              <Button variant="accent" disabled={saving || token.trim() === ''} onClick={save}>Save token</Button>
            </>
          ) : undefined}
        >
          <Stack gap="sm">
            <ErrorBanner message={bot.error} />
            {!bot.data && !bot.error ? (
              <Empty>Loading…</Empty>
            ) : configured && !replacing ? (
              <div className="nt-channel">
                <span className="pref-label">{bot.data?.username ? `Bot: @${bot.data.username}` : 'A bot token is saved.'}</span>
                <Button variant="ghost" size="sm" onClick={() => { setReplacing(true); setNote(null); }}>Replace token</Button>
              </div>
            ) : null}
            {showField ? (
              <>
                <p className="ui-card-meta">Ask @BotFather for a bot and paste its token here.</p>
                <Field label="Bot token" grow>
                  <input
                    type="password"
                    value={token}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setToken(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        save();
                      }
                    }}
                  />
                </Field>
              </>
            ) : null}
            {note ? <Notice tone={note.ok ? 'good' : 'warning'} role="status">{note.text}</Notice> : null}
          </Stack>
        </Section>

        <Section title="Your devices">
          <ErrorBanner message={devices.error} />
          {!devices.data ? (
            devices.error ? null : <Empty>Loading…</Empty>
          ) : devices.data.devices.length === 0 ? (
            <p className="ui-card-meta">No phone is paired yet.</p>
          ) : (
            <List>
              {devices.data.devices.map((device) => (
                <ListRow
                  key={device.id}
                  title={device.name ?? `Telegram user ${device.userId}`}
                  sub={`Paired ${fmtTime(device.pairedAt, timezone)} · ${device.lastSeenAt ? `last spoke ${fmtRelative(device.lastSeenAt)}` : 'has not spoken yet'}`}
                  side={<UnpairButton id={device.id} onGone={() => { devices.reload(); onChange(); }} />}
                />
              ))}
            </List>
          )}
        </Section>

        <Section
          title="Pair a device"
          foot={configured && (!offer || paired) ? (
            <Button variant={offer ? undefined : 'accent'} onClick={pair}>Pair a phone</Button>
          ) : configured && stale ? (
            <Button variant="accent" onClick={pair}>New code</Button>
          ) : undefined}
        >
          <Stack gap="sm">
            <ErrorBanner message={pairError} />
            {!configured ? (
              <p className="ui-card-meta">Save a bot token first.</p>
            ) : paired ? (
              <Notice tone="good" role="status">Paired.</Notice>
            ) : offer && stale ? (
              <p className="ui-card-meta">That code has run out.</p>
            ) : offer ? (
              <>
                <p className="ui-card-meta">Open this on your phone, then send /start to the bot.</p>
                <PairingSquare offer={offer} square={square}>
                  <CopyButton text={offer.link} />
                </PairingSquare>
                <p className="ui-field-hint">The code works until {fmtTime(offer.expiresAt, timezone)}.</p>
              </>
            ) : (
              <p className="ui-card-meta">Pair another phone, or the first one if you skipped it.</p>
            )}
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}

/** "Unpair", then asked once more in place, then gone. */
function UnpairButton({ id, onGone }: { id: string; onGone: () => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!asking) return <Button size="sm" onClick={() => setAsking(true)}>Unpair</Button>;
  const unpair = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .unpairTelegramDevice(id)
      .then(onGone)
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="nt-channel">
      <span className="ui-field-hint" role={failed ? 'alert' : undefined}>{failed ?? 'It will no longer reach your agents.'}</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Keep</Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={unpair}>Unpair</Button>
    </span>
  );
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (): void => {
    if (!navigator.clipboard?.writeText) { setCopied('Select the link to copy it.'); return; }
    void navigator.clipboard.writeText(text).then(() => setCopied('Copied.'), () => setCopied('Select the link to copy it.'));
  };
  return (
    <span className="nt-channel">
      <Button size="sm" onClick={copy}>Copy</Button>
      {copied ? <span className="ui-field-hint" role="status">{copied}</span> : null}
    </span>
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
