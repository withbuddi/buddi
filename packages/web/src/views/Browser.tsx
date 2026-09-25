/**
 * Computer & browser, for the owner rather than the engineer.
 *
 * Three questions, answered in order: does macOS let agents act at all, which
 * apps may they touch, and how do they get a browser. The live view of what an
 * agent is doing is not here: it is on the Canvas of the conversation doing it,
 * and this page only says who is driving and links there.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, csrfToken, type BrowserStatus, type ControlSettings } from '../api';
import { fmtTime } from '../format';
import { chatRoute } from '../routes';
import { Avatar, Button, Code, Details, Empty, ErrorBanner, Field, Notice, PageFrame, Pill, Section, Sheet, Spacer, Stack, Toolbar, useAsync } from '../ui';
import { RemoteHand } from './RemoteHand';

export function Browser({ embedded, timezone }: { embedded?: boolean; timezone?: string } = {}): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), [], 3_000);
  const session = useAsync(() => api.session(), []);
  // Computer control is macOS-only. An unreadable or older session answer keeps the page as it was.
  const macOS = session.data?.platform ? session.data.platform === 'darwin' : true;
  const settled = !!session.data || !!session.error;
  return (
    <PageFrame embedded={embedded} title="Computer & browser">
      <ErrorBanner message={error} />
      {!data || !settled ? <Empty>Checking the host…</Empty> : <ControlSettingsView key={JSON.stringify(data.settings ?? null)} data={data} macOS={macOS} reload={reload} timezone={timezone} />}
    </PageFrame>
  );
}

function ControlSettingsView({ data, macOS, reload, timezone }: { data: BrowserStatus; macOS: boolean; reload: () => void; timezone?: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Off macOS a stored "Use my apps" is the agents' own browser, which is how the host runs it.
  const settings = data.settings && !macOS && data.settings.mode === 'computer' ? { ...data.settings, mode: 'playwright' as const } : data.settings;
  const mode = settings?.mode ?? (!macOS && data.mode === 'computer' ? 'playwright' : data.mode);
  const computer = mode === 'computer';
  const sessions = data.sessions?.length ? data.sessions : data.session ? [data] : [];
  const active = sessions.length > 0 || data.busy;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); reload(); }
  };
  const save = (next: ControlSettings) => void run(() => api.browserSettings(next));
  const perms = data.permissions;
  const ready = !!data.enabled && (!computer || !perms?.supported || (perms.accessibility && perms.screenRecording));
  const readyLine = computer ? 'Ready. Agents can use your computer within the apps you allow below.'
    : mode === 'extension' ? 'Ready. Agents work in your Chrome, in background tabs, through the buddi extension.'
    : 'Ready. Agents work in their own browser. Your apps are never touched.';

  return (
    <Stack gap="lg">
      <ErrorBanner message={failure} />

      <Section
        title="Status"
        panel
        actions={
          <>
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.computerPermissions(false))}>Check again</Button>
            {computer && !ready && perms?.supported ? <Button size="sm" variant="accent" disabled={busy || active} onClick={() => void run(() => api.computerPermissions(true))}>Request macOS permissions</Button> : null}
          </>
        }
      >
        <Stack>
          {!data.enabled ? (
            <Notice tone="warning">The host is not available. Start buddi serve on a machine with a desktop session.</Notice>
          ) : ready ? (
            <Notice tone="good">{readyLine}</Notice>
          ) : (
            <Notice tone="warning">macOS has not granted everything yet. Grant the permissions below, then check again.</Notice>
          )}
          {!computer ? null : perms?.supported ? (
            <ul className="perm-list">
              <li className="perm-row">
                <Pill tone={perms.accessibility ? 'good' : 'warning'}>{perms.accessibility ? 'Granted' : 'Needed'}</Pill>
                <span className="perm-name">Accessibility</span>
                <span className="muted">Lets agents click and type in the apps you allow.</span>
              </li>
              <li className="perm-row">
                <Pill tone={perms.screenRecording ? 'good' : 'warning'}>{perms.screenRecording ? 'Granted' : 'Needed'}</Pill>
                <span className="perm-name">Screen Recording</span>
                <span className="muted">Lets agents see the window they are working in.</span>
              </li>
            </ul>
          ) : perms ? (
            <p className="muted">Computer control requires macOS 14 or later.</p>
          ) : null}
          {computer && perms?.message ? <p className="muted">{perms.message}</p> : null}
          {computer && perms?.supported && !ready ? <p className="muted">macOS may ask you to restart buddi after granting them.</p> : null}
        </Stack>
      </Section>

      <Section
        title="Who is driving"
        panel
        actions={sessions.length > 0 ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void run(() => api.browserControl('stop'))}>{computer ? 'Stop computer control' : 'Stop all browsers'}</Button>
        ) : undefined}
      >
        {sessions.length === 0 ? (
          <p className="ui-card-meta">Nobody right now. Ask an agent to open a website or one of the allowed apps, and you will see it working on that conversation’s Canvas.</p>
        ) : (
          <div className="ui-list">
            {sessions.map((s) => (
              <a key={s.session!.id} className="ui-list-row" href={chatRoute(s.session!.agentId, s.session!.conversationId)}>
                <Avatar id={s.session!.agentId} name={s.session!.agentId} size="sm" />
                <span className="ui-list-main">
                  <span className="ui-list-title">{s.session!.task}</span>
                  <span className="ui-list-sub">{s.session!.agentId}, {s.busy ? 'working' : s.state}, {s.session!.steps} of {s.session!.maxSteps} steps</span>
                </span>
                <span className="ui-list-side">Open the Canvas</span>
              </a>
            ))}
          </div>
        )}
      </Section>

      {settings ? (
        <>
          <Section title="How agents get a screen" panel>
            <Stack divided>
            <div className="mode-choice" role="radiogroup" aria-label="Control mode">
              {macOS ? (
                <ModeOption
                  current={settings.mode} value="computer" disabled={busy || active || !data.enabled}
                  title="Use my apps"
                  body="Agents work in your own windows, signed in as you, in the browser profile you choose below. One agent at a time. Releasing control leaves everything open."
                  onPick={() => save({ ...settings, mode: 'computer' })}
                />
              ) : null}
              <ModeOption
                current={settings.mode} value="playwright" disabled={busy || active || !data.enabled}
                title="Give agents their own browser"
                body="A separate browser profile with its own tabs, one per conversation. Your apps are never touched."
                onPick={() => save({ ...settings, mode: 'playwright' })}
              />
              <ModeOption
                current={settings.mode} value="extension" disabled={busy || active || !data.enabled}
                title="Your browser"
                body="Uses the Chrome you are signed in to, in background tabs, through the buddi extension."
                onPick={() => save({ ...settings, mode: 'extension' })}
              />
            </div>
            {!macOS ? <p className="muted">Using your own apps is macOS-only.</p> : null}
            {active ? <p className="muted">Finish or stop the current session before changing this.</p> : null}
            {settings.mode === 'extension' ? <ExtensionPairing busy={busy} timezone={timezone} /> : null}
            </Stack>
          </Section>

          {macOS ? <Section title="Apps agents may use" panel>
            <Stack>
              {settings.mode !== 'computer' ? (
                <p className="muted">Only used by “Use my apps”. The list is kept for when you switch back.</p>
              ) : null}
              <AppList settings={settings} disabled={busy || active || !data.enabled} onChange={save} onAdd={() => setPicking(true)} />
              <Details summary="Details">
                <div className="ui-prose muted">
                  <p>Agents see what is on screen in these apps, and what they see goes to the agent’s model provider. Allow only apps you want operated.</p>
                  <p>Never type a password or a sign-in code in chat. Sign in yourself, in the app, while you have taken over.</p>
                  <p>This is an allow list, not a sandbox: an allowed app’s own network traffic is not inspected.</p>
                </div>
              </Details>
            </Stack>
          </Section> : null}
          {picking ? (
            <AppPicker
              chosen={settings.allowedApps}
              onClose={() => setPicking(false)}
              onPick={(id) => { setPicking(false); if (!settings.allowedApps.includes(id)) save({ ...settings, allowedApps: [...settings.allowedApps, id] }); }}
            />
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

/**
 * The id Chrome gives this extension, which is the address the page sends to.
 *
 * Mirrored by hand from `packages/extension/src/id.ts`: the dashboard bundle
 * must not import the extension's sources, and one string is a smaller price
 * than a dependency between two things that are built differently and shipped
 * separately. It is derived from the public key in the extension's manifest,
 * so it is the same id on every machine, which is the whole point of pinning
 * that key.
 */
const EXTENSION_ID = 'kmbckpnnjfggeffkkbmkggojnolkdokb';

/** What the extension answers `buddi.status` with. */
interface ExtensionProbe {
  installed: true;
  version: string;
  state: 'disconnected' | 'pairing' | 'paired';
  code?: string;
  gateway: string;
}

declare const chrome: { runtime?: { sendMessage?: (id: string, message: unknown) => Promise<unknown> } } | undefined;

/**
 * Is the buddi extension in the browser reading this page?
 *
 * There is no way to ask that but to speak to it: a page cannot enumerate
 * extensions, and the manifest lets only loopback pages — this one — send it a
 * message. A rejected promise is the answer "not installed", and so is any
 * other browser, where `chrome.runtime` does not exist at all.
 */
async function askExtension(): Promise<ExtensionProbe | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return null;
    const answer = await chrome.runtime.sendMessage(EXTENSION_ID, { type: 'buddi.status' }) as ExtensionProbe | undefined;
    return answer?.installed ? answer : null;
  } catch { return null; }
}

/** The same buddi, seen from two sides: the popup's address against this page's. */
function sameGateway(gateway: string): boolean {
  try { return new URL(gateway).origin === window.location.origin; } catch { return false; }
}

/**
 * Pair your browser, and say where the extension lives.
 *
 * Its own poll rather than a field on the browser status: the connection comes
 * and goes with Chrome, and the pairing code appears while this page is open.
 * The extension is polled from here too, on the same three seconds, so the
 * owner is told which half is missing instead of being left to guess: a page
 * that waits for a code no extension is showing looks broken.
 */
function ExtensionPairing({ busy, timezone }: { busy: boolean; timezone?: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.extension(), [], 3_000);
  const probe = useAsync(() => askExtension(), [], 3_000).data ?? null;
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The code is on screen in the popup already; typing it again is busywork.
  const offered = probe?.state === 'pairing' ? probe.code ?? '' : '';
  useEffect(() => { if (offered) setCode(offered); }, [offered]);
  const run = async (action: () => Promise<unknown>) => {
    setWorking(true); setFailure(null);
    try { await action(); } catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setWorking(false); reload(); }
  };
  const disabled = busy || working;
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const install = (
    <div className="ui-prose muted">
      <p>Open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick this folder.</p>
      <Code label="The unpacked extension">{data?.path ?? '…'}</Code>
    </div>
  );
  return (
    <Stack divided>
      <ErrorBanner message={error ?? failure} />
      <Toolbar>
        <Pill tone={data?.connected ? 'good' : 'warning'}>{data?.connected ? 'Connected' : 'Not connected'}</Pill>
        <span className="muted">
          {data?.connected && data.pairedAt ? `Paired with Chrome on this Mac since ${fmtTime(data.pairedAt, zone)}`
            : data?.pairedAt ? 'Paired, but Chrome is not running the extension right now.'
            : 'No browser is paired with this buddi yet.'}
          {data?.extension ? ` · extension ${data.extension}` : ''}
        </span>
      </Toolbar>
      <Stack>
        <p className="muted">
          {probe ? `The browser you are reading this in has the extension, version ${probe.version}.`
            : data?.connected ? 'The browser you are reading this in has no buddi extension. You only need it here to pair this browser instead.'
            : 'The browser you are reading this in has no buddi extension yet.'}
          {probe?.state === 'paired' ? ' It is already paired with a buddi.' : ''}
          {probe?.state === 'disconnected' ? ' It is not connected yet: press Connect in its popup.' : ''}
        </p>
        {probe && !sameGateway(probe.gateway) ? (
          <Notice tone="warning">{`The extension is pointed at ${probe.gateway}; set it to ${window.location.origin} in the popup.`}</Notice>
        ) : null}
      </Stack>
      {data?.pending ? (
        <Toolbar valign="end">
          <Field grow label="Pair your browser" hint="Type the six digits the buddi extension is showing.">
            <input aria-label="Pairing code" inputMode="numeric" placeholder="482 913" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Spacer />
          <Button variant="accent" disabled={disabled || code.replace(/[^0-9]/g, '').length !== 6} onClick={() => void run(async () => { await api.pairExtension(code); setCode(''); })}>Pair</Button>
        </Toolbar>
      ) : null}
      {data?.connected ? <Details summary="Pair a different browser">{install}</Details> : install}
      <Toolbar align="end">
        <Button variant="danger" disabled={disabled || !data?.pairedAt} onClick={() => void run(() => api.forgetExtension())}>Forget this browser</Button>
      </Toolbar>
    </Stack>
  );
}

function ModeOption({ current, value, title, body, disabled, onPick }: { current: string; value: string; title: string; body: string; disabled: boolean; onPick: () => void }): JSX.Element {
  const on = current === value;
  return (
    <button type="button" role="radio" aria-checked={on} className="mode-option" disabled={disabled} onClick={() => { if (!on) onPick(); }}>
      <span className="mode-option-dot" aria-hidden="true" />
      <span className="mode-option-text">
        <span className="mode-option-title">{title}</span>
        <span className="mode-option-body">{body}</span>
      </span>
    </button>
  );
}

function AppList({ settings, disabled, onChange, onAdd }: { settings: ControlSettings; disabled: boolean; onChange: (next: ControlSettings) => void; onAdd: () => void }): JSX.Element {
  const apps = useAsync(() => api.installedApps(), []);
  const nameOf = (id: string): string => apps.data?.apps.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      {settings.allowedApps.length === 0 ? <Empty>No apps yet. Agents cannot touch anything until you add one.</Empty> : (
        <ul className="ui-list" aria-label="Allowed apps">
          {settings.allowedApps.map((id) => (
            <li key={id} className="ui-list-row">
              <Avatar id={id} name={nameOf(id)} size="sm" />
              <span className="ui-list-main">
                <span className="ui-list-title">{nameOf(id)}{id === settings.browserApp ? <Pill tone="accent" className="app-role">browser</Pill> : null}</span>
                <span className="ui-list-sub mono">{id}</span>
              </span>
              <Toolbar>
                {id !== settings.browserApp && isBrowser(id) ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...settings, browserApp: id })}>Use as browser</Button> : null}
                {id === settings.browserApp
                  ? <span className="muted">In use as the browser</span>
                  : <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...settings, allowedApps: settings.allowedApps.filter((a) => a !== id) })}>Remove</Button>}
              </Toolbar>
            </li>
          ))}
        </ul>
      )}
      <Toolbar>
        <Button variant="accent" disabled={disabled} onClick={onAdd}>Add an app</Button>
        <span className="muted">The app marked as browser is the one agents open websites in.</span>
      </Toolbar>
      {settings.mode === 'computer' && CHROMIUM.includes(settings.browserApp) ? <ProfileChoice settings={settings} disabled={disabled} onChange={onChange} /> : null}
    </>
  );
}

const CHROMIUM = ['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser'];

/** Which of the browser's profiles agents open websites in. */
function ProfileChoice({ settings, disabled, onChange }: { settings: ControlSettings; disabled: boolean; onChange: (next: ControlSettings) => void }): JSX.Element {
  const profiles = useAsync(() => api.browserProfiles(settings.browserApp), [settings.browserApp]);
  const list = profiles.data?.profiles ?? [];
  const known = settings.browserProfile ? list.some((p) => p.directory === settings.browserProfile) : true;
  return (
    <Field
      label="Browser profile"
      hint={settings.browserProfile ? 'Websites open in this profile, signed in as it is.' : 'Not chosen: websites open in whichever profile’s window is in front, or the last one you used.'}
    >
      <select
        value={settings.browserProfile ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const { browserProfile: _drop, ...rest } = settings;
          onChange(e.target.value ? { ...rest, browserProfile: e.target.value } : rest);
        }}
      >
        <option value="">Whichever is in front</option>
        {!known && settings.browserProfile ? <option value={settings.browserProfile}>{settings.browserProfile} (not found)</option> : null}
        {list.map((p) => <option key={p.directory} value={p.directory}>{p.name}{p.directory === 'Default' ? '' : ` (${p.directory})`}</option>)}
      </select>
    </Field>
  );
}

const BROWSERS = ['com.google.Chrome', 'com.apple.Safari', 'org.chromium.Chromium', 'com.microsoft.edgemac', 'com.brave.Browser', 'org.mozilla.firefox', 'company.thebrowser.Browser'];
function isBrowser(id: string): boolean { return BROWSERS.includes(id); }

function AppPicker({ chosen, onClose, onPick }: { chosen: string[]; onClose: () => void; onPick: (id: string) => void }): JSX.Element {
  const apps = useAsync(() => api.installedApps(), []);
  const [q, setQ] = useState('');
  const [manual, setManual] = useState('');
  const rows = useMemo(() => {
    const list = apps.data?.apps ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle)).slice(0, 60);
  }, [apps.data, q]);
  return (
    <Sheet title="Add an app" onClose={onClose}>
      <input autoFocus aria-label="Search apps" placeholder="Search installed apps" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorBanner message={apps.error} />
      {!apps.data ? <Empty>Reading your Applications folder…</Empty> : rows.length === 0 ? <Empty>No app matches.</Empty> : (
        <ul className="ui-list" aria-label="Installed apps">
          {rows.map((a) => {
            const already = chosen.includes(a.id);
            return (
              <li key={a.id} className="ui-list-row">
                <Avatar id={a.id} name={a.name} size="sm" />
                <span className="ui-list-main">
                  <span className="ui-list-title">{a.name}</span>
                  <span className="ui-list-sub mono">{a.id}</span>
                </span>
                <Button size="sm" disabled={already} onClick={() => onPick(a.id)}>{already ? 'Allowed' : 'Allow'}</Button>
              </li>
            );
          })}
        </ul>
      )}
      <Details summary="Add by bundle identifier instead">
        <Toolbar>
          <input aria-label="Bundle identifier" placeholder="com.apple.TextEdit" value={manual} onChange={(e) => setManual(e.target.value)} />
          <Button disabled={!manual.trim()} onClick={() => onPick(manual.trim())}>Allow this identifier</Button>
        </Toolbar>
      </Details>
    </Sheet>
  );
}

/** Shared by the full page and the conversation's trusted canvas tab. */
export function BrowserPanel({ data, error, reload, compact = false, refresh, screenshotSrc, onScreenshotError, onScreenshotLoad, controls = true }: {
  data: BrowserStatus | undefined;
  error: string | null;
  reload: () => void;
  compact?: boolean;
  /**
   * A picture to show instead of asking the route for one. The canvas hands
   * over the last frame it kept when a session ends: the route has nothing
   * left to serve by then, and an empty frame is a worse record of what the
   * agent did than the one it actually left.
   */
  screenshotSrc?: string;
  /** The picture did not arrive, so whoever is polling can slow down. */
  onScreenshotError?: () => void;
  /** It did, so they can stop counting failures. */
  onScreenshotLoad?: () => void;
  /**
   * Whether the owner's controls are shown. They are not, once the session
   * has ended: Stop is installation-wide, and offering it on a panel of
   * history would stop a session this tab is not even showing.
   */
  controls?: boolean;
  /**
   * A counter the canvas advances while a session is alive. It goes on the
   * screenshot's URL, so a new value is a new request for the last
   * observation — which is how the preview keeps up with an agent that is
   * working right now. Left out, the picture changes only when the
   * observation does.
   */
  refresh?: number;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * The take-over that is also a hand.
   *
   * The gateway answers Take over with whether this mode can be driven from
   * here, so the panel does not have to know which of the three is running.
   * `driving` is the session that answer belonged to: a later status for some
   * other session must not hand this tab a live view of a screen it never
   * took over.
   */
  const [driving, setDriving] = useState<string | null>(null);
  const [handNote, setHandNote] = useState<string | null>(null);
  const control = async (action: 'stop' | 'takeover' | 'resume' | 'release') => {
    setBusy(true);
    setFailure(null);
    setHandNote(null);
    try {
      const next = action !== 'stop' && data?.session
        ? await api.browserControl(action, data.session.id)
        : await api.browserControl(action);
      if (action === 'takeover') {
        if (next.hand && next.session) setDriving(next.session.id);
        else setHandNote(next.handMessage ?? null);
      } else setDriving(null);
    }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  // The hand lives exactly as long as the take-over does.
  const hand = driving && data?.session?.id === driving && data.state === 'paused' ? driving : null;
  const canControl = !!data?.enabled && !busy;
  const computer = data?.mode === 'computer';
  // The owner's own Chrome, through the extension: their tabs, not ours.
  const yours = data?.mode === 'extension';
  const help = computer ? 'Stop computer control interrupts native input and revokes access. Take over pauses agent input. Release ends this conversation’s control without closing your apps. Already dispatched actions cannot be undone. Avoid using the same mouse and keyboard while the agent is working.' : 'Stop all browsers closes every session and revokes access until you resume. Take over, Resume and Close & release affect only the selected conversation. An in-flight action is interrupted by closing its tabs. Actions already submitted cannot be undone.';
  const state = data?.busy ? 'Working' : data?.state === 'running' ? 'Ready' : data?.state ?? 'Connecting';
  const tone = data?.busy || data?.state === 'running' ? 'good' : data?.state === 'stopped' || data?.state === 'error' ? 'critical' : undefined;
  return (
    <section className="browser-panel" data-compact={compact ? 'true' : undefined} aria-label="Host browser">
      <div className="browser-heading">
        <div>
          {compact ? null : <p className="browser-eyebrow">On your host machine</p>}
          <h2 className="browser-title">{computer ? 'Computer' : yours ? 'Your browser' : 'Browser'}</h2>
        </div>
        <Pill tone={tone}>
          <span role="status">{state}</span>
        </Pill>
      </div>
      {compact ? (
        <a className="browser-full-view" href="#/browser">{computer ? 'Open computer view & settings ↗' : 'Open full browser view ↗'}</a>
      ) : (
        <p className="ui-page-lede">{computer ? 'Your apps, operated through macOS accessibility, screenshots and input. No browser debugging connection.' : yours ? 'Your own Chrome, signed in as you, working in background tabs grouped as “buddi”. You keep browsing.' : 'A real browser window, driven by your assistant. You stay in control.'}</p>
      )}
      <ErrorBanner message={error ?? failure} />
      {controls ? (
        <Toolbar>
          <Button variant="danger" disabled={!canControl || data?.state === 'stopped'} onClick={() => void control('stop')}>{computer ? 'Stop computer control' : 'Stop all browsers'}</Button>
          <Button disabled={!canControl || !data?.session || data?.state === 'paused'} onClick={() => void control('takeover')}>Take over</Button>
          <Button disabled={!canControl || data?.busy || !['stopped', 'paused'].includes(data?.state ?? '')} onClick={() => void control('resume')}>Resume access</Button>
          <Button disabled={!canControl || !data?.session} onClick={() => void control('release')}>{computer ? 'Release control' : 'Close & release'}</Button>
        </Toolbar>
      ) : null}
      {!controls ? null : compact ? <Details summary="About these controls"><p className="muted">{help}</p></Details> : <p className="muted">{help}</p>}
      {handNote ? <Notice tone="warning" role="status">{handNote}</Notice> : null}
      {data?.message && !hand ? <Notice tone="warning" role="status">{data.message}</Notice> : null}
      {data?.session ? (
        <div className="browser-task">
          <div className="ui-row"><strong>{data.session.agentId}</strong><span className="muted">{data.session.steps} / {data.session.maxSteps} steps</span></div>
          {!compact ? <p>{data.session.task}</p> : null}
          <p className="muted">Last action: {data.lastAction ?? 'None'} · Access expires {new Date(data.session.expiresAt).toLocaleTimeString()}</p>
        </div>
      ) : (
        <p className="browser-task muted">{data?.enabled ? computer ? 'No agent is driving. Ask an agent granted browser.* to open a website or an allowed native app.' : 'No agent is driving. Ask an agent granted browser.* to open a website.' : 'The host browser is unavailable. Start buddi serve on a machine with a desktop session.'}</p>
      )}
      {hand ? (
        <RemoteHand sessionId={hand} csrf={csrfToken()} onGiveBack={() => void control('resume')} />
      ) : null}
      <div className="browser-window" hidden={!!hand}>
        <div className="browser-address"><span aria-hidden="true">◉</span><span>{data?.page?.url ?? (computer ? 'Waiting for an application' : 'Waiting for a website')}</span></div>
        {data?.hasScreenshot && data.page ? (
          <figure>
            <img
              key={screenshotSrc ?? data.page.id}
              src={screenshotSrc ?? `/api/browser/screenshot?v=${encodeURIComponent(data.page.id)}${data.session ? `&sessionId=${encodeURIComponent(data.session.id)}` : ''}${refresh ? `&tick=${refresh}` : ''}`}
              alt={`Last browser observation: ${data.page.title || data.page.url}`}
              {...(onScreenshotError ? { onError: onScreenshotError } : {})}
              {...(onScreenshotLoad ? { onLoad: onScreenshotLoad } : {})}
            />
            <figcaption>Last observation · {new Date(data.page.capturedAt).toLocaleTimeString()} · {data.page.title || 'Untitled page'}</figcaption>
          </figure>
        ) : (
          <div className="browser-empty"><strong>{computer ? 'Your selected app will appear here' : 'Your browser activity will appear here'}</strong><p>{computer ? 'Only the selected app window is captured, not the whole desktop. This preview is not interactive.' : 'This is a view of the host browser, not a second browser or a remote desktop.'}</p></div>
        )}
      </div>
      {(data?.page?.tabs.length ?? 0) > 1 ? (
        <Details summary={`${data!.page!.tabs.length} open tabs`}>
          <ul className="ui-prose">{data!.page!.tabs.map((tab) => <li key={tab.id}>{tab.title || tab.id} — {tab.url}</li>)}</ul>
        </Details>
      ) : null}
      <p className="muted">{computer ? 'Sign in directly in the host app during takeover. Don’t send passwords or MFA codes in chat. Native apps retain your existing logins and documents. Secure accessibility fields are masked; other sensitive window content can still appear in screenshots.' : 'Sign in directly in this conversation’s host tab during takeover. Don’t send passwords or MFA codes in chat. Agent tabs share saved logins and cookies.'} {hand ? 'While you are driving this is a live view of the page; nothing you type is kept.' : 'Screenshots update after agent actions; this is not a live video feed.'}</p>
    </section>
  );
}
