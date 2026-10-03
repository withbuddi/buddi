/**
 * Settings → System: Sign in from elsewhere (specs/trusted-access.md §6.6).
 *
 * One panel, one row per trusted access provider: something in front of buddi
 * that proves who is knocking, checked by buddi itself on every visit. A row
 * is the provider's glyph, its name, its status in one line and a pill; it
 * opens in place on its setup. The kit's `ui_kits/dashboard/Access.jsx` is
 * the source of truth for how it looks.
 *
 * Seen through any provider, the whole block is read-only: the setting that
 * let this browser in cannot be widened from the far end of it.
 */
import { Fragment, useState } from 'react';
import { ApiError, api, type AccessState, type CloudflareAccessChange, type CloudflareAccessView, type TailscaleView } from '../api';
import { Button, ErrorBanner, Field, Icon, List, ListRow, Notice, Pill, Section, Stack, Toolbar, useAsync } from '../ui';

/** Put a command on the clipboard, where there is one. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* A browser that refuses the clipboard leaves the command on screen to select. */
  }
}

/** A command to copy: its own line, with the button that takes it beside it. */
function Command({ text, disabled }: { text: string; disabled?: boolean }): JSX.Element {
  return (
    <div className="tailscale-command">
      <code className="mono">{text}</code>
      <Button size="sm" disabled={disabled} onClick={() => { void copyText(text); }}>
        Copy
      </Button>
    </div>
  );
}

function AccessGlyph({ id }: { id: string }): JSX.Element {
  const paths = id === 'tailscale'
    ? (
      <>
        <circle cx="5" cy="5" r="1.6" /><circle cx="10" cy="5" r="1.6" /><circle cx="15" cy="5" r="1.6" />
        <circle cx="5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15" cy="10" r="1.6" />
        <circle cx="10" cy="15" r="1.6" />
      </>
    )
    : (
      <>
        <path d="M5.6 14.8h8.6a3.2 3.2 0 0 0 .4-6.4 4.6 4.6 0 0 0-8.9-.9A3.7 3.7 0 0 0 5.6 14.8Z" />
        <path d="M8.4 11.4l1.4 1.4 2.8-2.8" />
      </>
    );
  return (
    <span className="access-glyph" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
    </span>
  );
}

const PILL: Record<AccessState, JSX.Element | null> = {
  ready: <Pill tone="good">Ready</Pill>,
  waiting: <Pill>Waiting</Pill>,
  'needs-setup': <Pill tone="warning">Needs setup</Pill>,
  unanswered: <Pill tone="warning">Not answering</Pill>,
  off: null,
};

/**
 * The block: every provider's row, one open at a time.
 */
export function AccessSettings(): JSX.Element {
  const view = useAsync(() => api.access(), []);
  const [open, setOpen] = useState<string | null>(null);
  const locked = view.data?.proxied === true;
  const rows = (view.data?.providers ?? []).filter((p) => p.id === 'tailscale' || p.id === 'cloudflare-access');
  return (
    <Section title="Sign in from elsewhere" aside="checked by buddi on every visit" panel flush>
      <ErrorBanner message={view.error} />
      {locked ? (
        <div className="access-locked">
          <Notice tone="warning">Change this from the computer buddi runs on.</Notice>
        </div>
      ) : null}
      <List>
        {rows.map((row) => (
          <Fragment key={row.id}>
            <ListRow
              onClick={() => setOpen(open === row.id ? null : row.id)}
              label={`${row.title}: ${row.status.sentence}`}
              lead={<AccessGlyph id={row.id} />}
              title={row.title}
              sub={row.status.sentence}
              side={(
                <span className="access-side">
                  {PILL[row.status.state]}
                  <span className="access-chevron" data-open={open === row.id ? 'true' : undefined}><Icon name="chevron-right" size={14} /></span>
                </span>
              )}
            />
            {open === row.id ? (
              <div className="access-body">
                {row.id === 'tailscale' ? <Tailscale embedded onSaved={view.reload} /> : <CloudflareAccess onSaved={view.reload} />}
              </div>
            ) : null}
          </Fragment>
        ))}
      </List>
      <p className="access-foot">
        Every way in gives the same session: 12 hours idle, approvals as here, the lock screen. A sign-in link from{' '}
        <span className="mono">buddi dashboard --token</span> works everywhere.
      </p>
    </Section>
  );
}

/**
 * Tailscale's row, opened: the panel it always was. The switch is the whole
 * feature, and the sentence under it is the part that matters: turning this
 * on means anyone signed in to Tailscale as that login, on any device in the
 * tailnet, is signed in to buddi. The command is printed with this
 * installation's own ports in it, because the proxy has to run on the machine
 * buddi runs on and nowhere else.
 */
export function Tailscale({ embedded, onSaved }: { embedded?: boolean; onSaved?: () => void } = {}): JSX.Element {
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
      .then(() => { setSaved(true); onSaved?.(); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => { setBusy(false); view.reload(); });
  };
  return (
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
          {/* Inside the block, the block's own notice already says it once. */}
          {embedded ? null : <Notice tone="warning">Change this from the computer buddi runs on.</Notice>}
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
      <Command text={data?.serveCommand ?? 'tailscale serve'} disabled={busy || !data} />
      <p className="ui-card-meta">
        This gives your tailnet the trust this machine already has: buddi cannot tell the Tailscale proxy from
        another program running here, and any program that can reach the dashboard on this machine can already
        read buddi&rsquo;s files.
      </p>
      {saved ? <Notice tone="good" role="status">Saved.</Notice> : null}
      <Toolbar align="end">
        <Button variant="accent" disabled={busy || !data || locked} onClick={() => save(data?.enabled ?? false)}>
          Save
        </Button>
      </Toolbar>
    </Stack>
  );
}

type CloudflareForm = Omit<CloudflareAccessChange, 'enabled'>;
const FIELDS: Array<keyof CloudflareForm> = ['teamDomain', 'aud', 'email', 'publicOrigin'];

/**
 * Cloudflare Access's row, opened: the five setup steps with the real
 * ingress port, the three fields and the public address, then Test my setup
 * and Save. Test fetches the team's signing keys for the domain in the form;
 * Save stores the setting, binds the listener and fetches them once more.
 */
export function CloudflareAccess({ onSaved }: { onSaved?: () => void } = {}): JSX.Element {
  const view = useAsync(() => api.cloudflareAccess(), []);
  const [form, setForm] = useState<CloudflareForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; sentence: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const data: CloudflareAccessView | undefined = view.data;
  const values: CloudflareForm = form ?? {
    teamDomain: data?.teamDomain ?? '',
    aud: data?.aud ?? '',
    email: data?.email ?? '',
    publicOrigin: data?.publicOrigin ?? '',
  };
  const locked = data?.proxied === true;
  const off = busy || !data || locked;
  const set = (key: keyof CloudflareForm, value: string): void => setForm({ ...values, [key]: value });
  const save = (enabled: boolean): void => {
    setBusy(true);
    setFailed(null);
    setSaved(false);
    setResult(null);
    api
      .setCloudflareAccess({ enabled, ...values })
      .then((answer) => {
        setSaved(true);
        if (answer.test) {
          setResult(answer.test.ok
            ? { ok: true, sentence: `${answer.teamDomain} answered with ${answer.test.keys} signing key${answer.test.keys === 1 ? '' : 's'}.${answer.publicOrigin ? ` Open ${answer.publicOrigin} from another device to finish.` : ''}` }
            : { ok: false, sentence: answer.test.error ?? 'Cloudflare’s signing keys could not be fetched.' });
        }
        setForm(null);
        onSaved?.();
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => { setBusy(false); view.reload(); });
  };
  const test = (): void => {
    setBusy(true);
    setFailed(null);
    setResult(null);
    api
      .testCloudflareAccess({ teamDomain: values.teamDomain })
      .then((answer) => setResult({
        ok: answer.ok,
        sentence: answer.ok && values.publicOrigin ? `${answer.sentence} Open ${values.publicOrigin} from another device to finish.` : answer.sentence,
      }))
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const fieldOf = (key: keyof CloudflareForm) => data?.setup.fields.find((f) => f.key === key);
  return (
    <Stack gap="sm">
      <ErrorBanner message={view.error ?? failed} />
      {locked ? (
        <p className="ui-card-meta">{data?.enabled ? `On, for ${data.email} at ${data.teamDomain}` : 'Off'}</p>
      ) : null}
      <label className="backup-check">
        <input type="checkbox" checked={data?.enabled ?? false} disabled={off} onChange={(event) => save(event.target.checked)} />
        <span>Let this email sign in through Cloudflare</span>
      </label>
      <ol className="access-steps">
        {(data?.setup.steps ?? []).map((step) => (
          <li key={step.text}>
            <span>{step.text}</span>
            {step.command ? <Command text={step.command} disabled={off} /> : null}
          </li>
        ))}
      </ol>
      <div className="access-grid">
        {FIELDS.map((key) => {
          const field = fieldOf(key);
          return (
            <Field key={key} label={field?.label ?? key} hint={field?.hint}>
              <input
                type={key === 'email' ? 'email' : 'text'}
                className={key === 'aud' ? 'mono' : undefined}
                value={values[key]}
                placeholder={field?.placeholder}
                disabled={off}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set(key, event.target.value)}
              />
            </Field>
          );
        })}
      </div>
      {result ? <Notice tone={result.ok ? 'good' : 'critical'} role="status">{result.sentence}</Notice> : null}
      <p className="ui-card-meta">
        buddi checks Cloudflare&rsquo;s signature on every visit and never trusts a header alone. Anyone Cloudflare
        signs in with this email, on any device, is signed in to buddi.
      </p>
      {saved && !result ? <Notice tone="good" role="status">Saved.</Notice> : null}
      <Toolbar align="end">
        <Button disabled={off || values.teamDomain.trim() === ''} onClick={test}>Test my setup</Button>
        <Button variant="accent" disabled={off} onClick={() => save(data?.enabled ?? false)}>Save</Button>
      </Toolbar>
    </Stack>
  );
}
