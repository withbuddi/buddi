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
import { Fragment, useEffect, useState } from 'react';
import { ApiError, api, type AccessState, type CloudflareAccessChange, type CloudflareAccessView, type CloudflareSetupProgress, type CloudflareSetupView, type TailscaleView } from '../api';
import { Button, ButtonLink, ErrorBanner, Field, Icon, List, ListRow, Notice, Pill, Section, Stack, Toolbar, useAsync } from '../ui';

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
                {row.id === 'tailscale' ? <Tailscale embedded onSaved={view.reload} /> : <CloudflareRow enabled={row.enabled} locked={locked} onSaved={view.reload} />}
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
export function CloudflareAccess({ onSaved, extra }: { onSaved?: () => void; extra?: JSX.Element | null } = {}): JSX.Element {
  const view = useAsync(() => api.cloudflareAccess(), []);
  const [tried, setTried] = useState(false);
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
  const missing = [
    values.teamDomain.trim() === '' ? 'the team domain' : null,
    values.aud.trim() === '' ? 'the AUD tag' : null,
    values.email.trim() === '' ? 'your email' : null,
  ].filter((m): m is string => m !== null);
  const missingLine = missing.length > 0 ? `To turn this on, fill in ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`}.` : null;
  const save = (enabled: boolean): void => {
    // What is missing is a neutral line until the owner tries to turn it on.
    if (enabled && missingLine) { setTried(true); return; }
    setTried(false);
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
      {missingLine && !locked && !(data?.enabled ?? false)
        ? (tried ? <Notice tone="critical" role="alert">{missingLine}</Notice> : <p className="ui-card-meta">{missingLine}</p>)
        : null}
      {result ? <Notice tone={result.ok ? 'good' : 'critical'} role="status">{result.sentence}</Notice> : null}
      <p className="ui-card-meta">
        buddi checks Cloudflare&rsquo;s signature on every visit and never trusts a header alone. Anyone Cloudflare
        signs in with this email, on any device, is signed in to buddi.
      </p>
      {saved && !result ? <Notice tone="good" role="status">Saved.</Notice> : null}
      {extra ?? null}
      <Toolbar align="end">
        <Button disabled={off || values.teamDomain.trim() === ''} onClick={test}>Test my setup</Button>
        <Button variant="accent" disabled={off} onClick={() => save(data?.enabled ?? false)}>Save</Button>
      </Toolbar>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * "Set it up for me"
 * ------------------------------------------------------------------ */

const LIVE: ReadonlyArray<CloudflareSetupProgress['state']> = ['running', 'waiting', 'removing'];

/**
 * Cloudflare Access's row, opened. Not set up yet, it offers "Set it up for
 * me" first, with "I'll do it myself" as the way to the five steps; a run in
 * progress (or its outcome) shows as the checklist; set up, it is the form
 * as always, with Remove what buddi made when buddi made it.
 */
export function CloudflareRow({ enabled, locked, onSaved }: { enabled: boolean; locked: boolean; onSaved?: () => void }): JSX.Element {
  const [setup, setSetup] = useState<CloudflareSetupView | null>(null);
  const [mode, setMode] = useState<'offer' | 'form' | 'run' | 'manual' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (locked) return;
    api.cloudflareSetup().then(setSetup).catch(() => setSetup(null));
  }, [locked]);
  const state = setup?.progress.state ?? 'idle';
  const live = LIVE.includes(state);
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => {
      api.cloudflareSetup().then((next) => {
        setSetup(next);
        if (!LIVE.includes(next.progress.state)) onSaved?.();
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [live, onSaved]);

  const shown = locked ? 'manual' : mode ?? (state !== 'idle' ? 'run' : enabled || setup?.record ? 'manual' : setup ? 'offer' : null);
  const act = (call: () => Promise<CloudflareSetupView>, next?: 'run'): void => {
    setBusy(true);
    setFailed(null);
    call()
      .then((answer) => { setSetup(answer); if (next) setMode(next); onSaved?.(); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const remove = (): void => act(() => api.removeCloudflareSetup(), 'run');

  if (shown === null) return <p className="ui-card-meta">…</p>;
  if (shown === 'manual') {
    const extra = setup?.record && !locked ? (
      <p className="ui-card-meta">Set up by buddi for {setup.record.host} on {setup.record.zone}.</p>
    ) : null;
    return (
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        <CloudflareAccess onSaved={onSaved} extra={extra} />
        {setup?.record && !locked ? (
          <Toolbar align="end">
            <Button disabled={busy} onClick={remove}>Remove what buddi made</Button>
            <Button disabled={busy} onClick={() => setMode('form')}>Set it up again</Button>
          </Toolbar>
        ) : null}
      </Stack>
    );
  }
  if (shown === 'offer') {
    return (
      <Stack gap="sm">
        <p className="ui-card-meta">
          buddi can make the tunnel, the DNS record and the Access application for you, with one Cloudflare API
          token. You run one command; buddi does the rest and tests it.
        </p>
        <Toolbar align="end">
          <Button onClick={() => setMode('manual')}>I&rsquo;ll do it myself</Button>
          <Button variant="accent" onClick={() => setMode('form')}>Set it up for me</Button>
        </Toolbar>
      </Stack>
    );
  }
  if (shown === 'form') {
    return (
      <SetupForm
        setup={setup}
        busy={busy}
        failed={failed}
        onCancel={() => { setFailed(null); setMode(null); }}
        onStart={(input) => act(() => api.startCloudflareSetup(input), 'run')}
      />
    );
  }
  return (
    <SetupRun
      progress={setup?.progress ?? null}
      busy={busy}
      failed={failed}
      onStop={() => act(() => api.stopCloudflareSetup())}
      onRetry={() => setMode('form')}
      onAdopt={() => { const p = setup?.progress; if (p) act(() => api.startCloudflareSetup({ host: p.host, email: p.email, adopt: true }), 'run'); }}
      onRemove={remove}
      onAgain={() => setMode('form')}
    />
  );
}

function SetupForm({ setup, busy, failed, onCancel, onStart }: {
  setup: CloudflareSetupView | null;
  busy: boolean;
  failed: string | null;
  onCancel: () => void;
  onStart: (input: { token?: string; host: string; email: string }) => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [host, setHost] = useState(setup?.record?.host ?? setup?.progress.host ?? '');
  const [email, setEmail] = useState(setup?.record?.email ?? setup?.progress.email ?? '');
  const kept = setup?.tokenStored === true;
  const ready = (kept || token.trim() !== '') && host.trim() !== '' && email.trim() !== '';
  return (
    <Stack gap="sm">
      <ErrorBanner message={failed} />
      <p className="ui-card-meta">Open Cloudflare: the token form comes pre-filled with these permissions. Name it, create it, paste it here.</p>
      <ul className="access-perms">
        {(setup?.permissions ?? []).map((line) => <li key={line} className="mono">{line}</li>)}
      </ul>
      <Toolbar>
        <ButtonLink size="sm" href={setup?.tokenUrl ?? 'https://dash.cloudflare.com/profile/api-tokens'} target="_blank" rel="noreferrer">Open Cloudflare &#8599;</ButtonLink>
      </Toolbar>
      <div className="access-grid">
        <Field label="API token" hint="Kept as an owner secret, used only to set this up and to remove it.">
          <input type="password" className="mono" value={token} placeholder={kept ? 'Kept. Paste a new one to replace it' : 'Paste the token'} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Field label="Hostname" hint="A name on a domain the token can edit. buddi finds the zone.">
          <input type="text" value={host} placeholder="buddi.example.com" autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label="Your email" hint="The one Cloudflare will let in.">
          <input type="email" value={email} placeholder="you@example.com" autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <Toolbar align="end">
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="accent" disabled={busy || !ready} onClick={() => onStart({ ...(token.trim() ? { token: token.trim() } : {}), host: host.trim(), email: email.trim() })}>Set it up</Button>
      </Toolbar>
    </Stack>
  );
}

function SetupRun({ progress, busy, failed, onStop, onRetry, onAdopt, onRemove, onAgain }: {
  progress: CloudflareSetupProgress | null;
  busy: boolean;
  failed: string | null;
  onStop: () => void;
  onRetry: () => void;
  onAdopt: () => void;
  onRemove: () => void;
  onAgain: () => void;
}): JSX.Element {
  if (!progress) return <p className="ui-card-meta">…</p>;
  if (progress.state === 'removed' || progress.state === 'removing') {
    return (
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        {progress.state === 'removing' ? <p className="ui-card-meta">Removing what buddi made…</p> : null}
        {progress.state === 'removed' && progress.removed.length > 0 ? (
          <Notice tone="good" role="status">Removed {inWords(progress.removed)}. Signing in through Cloudflare is off.</Notice>
        ) : null}
        {progress.error ? <Notice tone="critical" role="alert">{progress.error}</Notice> : null}
        {progress.uninstall ? (
          <>
            <p className="ui-card-meta">The connector is still installed on this computer. To remove it too:</p>
            <Command text={progress.uninstall} />
          </>
        ) : null}
        <Toolbar align="end">
          {progress.error && progress.state === 'removed' ? <Button disabled={busy} onClick={onRemove}>Remove again</Button> : null}
          <Button variant="accent" disabled={busy} onClick={onAgain}>Set it up again</Button>
        </Toolbar>
      </Stack>
    );
  }
  const live = progress.state === 'running' || progress.state === 'waiting';
  return (
    <Stack gap="sm">
      <ErrorBanner message={failed} />
      {progress.state === 'done' && progress.url ? (
        <Notice tone="good" role="status">Done. Open {progress.url} from another device and sign in as {progress.email}.</Notice>
      ) : null}
      {progress.state === 'stopped' && progress.error ? <Notice role="status">{progress.error}</Notice> : null}
      <ol className="cat-steps access-run" aria-live="polite">
        {progress.steps.map((step) => (
          <li key={step.id} className="cat-step" data-state={step.state}>
            <span className="cat-step-mark">
              {step.state === 'done' ? <Icon name="check" size={12} /> : step.state === 'failed' ? <Icon name="alert" size={14} /> : null}
            </span>
            <div className="access-run-text">
              <span>{step.state === 'now' && step.id !== 'connector' ? `${step.text}…` : step.text}</span>
              {step.state === 'failed' && step.why ? <span className="access-run-why">{step.why}</span> : null}
              {step.id === 'connector' && step.state !== 'done' && progress.install ? (
                <div className="access-run-more">
                  <span className="ui-card-meta">Run this once in a terminal on this computer. buddi never runs sudo itself.</span>
                  <Command text={progress.install.command} />
                  <span className="ui-card-meta">{progress.install.note}</span>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <Toolbar align="end">
        {live ? <Button disabled={busy} onClick={onStop}>Stop waiting</Button> : null}
        {progress.state === 'failed' || progress.state === 'done' || progress.state === 'stopped' ? <Button disabled={busy} onClick={onRemove}>Remove what buddi made</Button> : null}
        {progress.state === 'failed' && progress.adoptable ? <Button disabled={busy} onClick={onRetry}>Try again</Button> : null}
        {progress.state === 'failed' && progress.adoptable ? <Button variant="accent" disabled={busy} onClick={onAdopt}>Use it anyway</Button> : null}
        {(progress.state === 'failed' && !progress.adoptable) || progress.state === 'stopped' ? <Button variant="accent" disabled={busy} onClick={onRetry}>Try again</Button> : null}
      </Toolbar>
    </Stack>
  );
}

function inWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
