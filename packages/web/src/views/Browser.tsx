/**
 * Computer & browser, for the owner rather than the engineer.
 *
 * Two questions, answered in order: can agents look at all, and where may
 * they look. The apps route is the Computer plugin's (its own settings page
 * holds the helper, the macOS permissions and the apps list); here it is one
 * row, shown only when the plugin is installed. The live view of what an
 * agent is doing is not here: it is on the Canvas of the conversation doing it,
 * and this page only says who is driving and links there.
 */
import { useEffect, useState } from 'react';
import { api, csrfToken, type BrowserStatus, type ControlSettings } from '../api';
import { fmtClock, fmtTime } from '../format';
import { chatRoute, pluginSettingsRoute } from '../routes';
import { InstallProgress } from './parts/InstallProgress';
import { Avatar, Button, ButtonLink, Code, Details, Empty, ErrorBanner, Field, Notice, PageFrame, Pill, Section, Spacer, Stack, Switch, Toolbar, useAsync } from '../ui';
import { RemoteHand } from './RemoteHand';
import { useThisMachine } from '../useThisMachine';

export function Browser({ embedded, timezone }: { embedded?: boolean; timezone?: string } = {}): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), [], 3_000);
  const session = useAsync(() => api.session(), []);
  // The Computer plugin is macOS-only: elsewhere the page does not offer it.
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
  // Where agents may look: permissions, not a mode. The kit-driven redesign of this page is the next step;
  // until then the routes are switches here (docs/browser.md).
  const settings = data.settings;
  const chromeRoute = data.routes?.find((route) => route.kind === 'chrome');
  // Your apps: a route the Computer plugin provides; without it, one line offering the plugin.
  const appsRoute = data.routes?.find((route) => route.kind === 'apps');
  const appsInstalled = appsRoute?.installed === true;
  const sessions = data.sessions?.length ? data.sessions : data.session ? [data] : [];
  const active = sessions.length > 0 || data.busy;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); reload(); }
  };
  const save = (next: Partial<ControlSettings>) => void run(() => api.browserSettings(next));
  // The agents' own browser: none installed, or installed but unable to start, is not ready.
  const own = data.browser;
  const installing = own?.install?.state === 'running';
  const noBrowser = own?.engine === 'none';
  const ready = !!data.enabled && !noBrowser && !own?.problem;
  const readyLine = 'Ready. Agents look in their own browser, in the background; your Chrome only for sites that need your sign-in, when you allow it.';

  return (
    <Stack gap="lg">
      <ErrorBanner message={failure} />

      <Section
        title="Status"
        panel
        actions={
          <>
            <Button size="sm" disabled={busy} onClick={() => void run(async () => undefined)}>Check again</Button>
            {noBrowser || installing ? <Button size="sm" variant="accent" disabled={busy || installing} onClick={() => void run(() => api.browserInstall())}>{installing ? 'Installing…' : 'Install Chromium'}</Button> : null}
          </>
        }
      >
        <Stack>
          {!data.enabled ? (
            <Notice tone="warning">The host is not available. Start buddi serve on a machine with a desktop session.</Notice>
          ) : noBrowser ? (
            <Notice tone="warning" title="No browser installed for the agents yet">
              Install Chromium here (about 150 MB), or run <code>buddi browser install</code> on this machine.
            </Notice>
          ) : own?.problem ? (
            <Notice tone="warning">{own.message}</Notice>
          ) : ready ? (
            <Notice tone="good">{readyLine}</Notice>
          ) : null}
          {/* A bar and one line in buddi's words while it runs; the
              installer's own progress text never reaches the page. */}
          {own?.install?.state === 'running' ? (
            <InstallProgress progress={own.install.progress} />
          ) : own?.install ? (
            <p className="muted" role="status">
              {own.install.state === 'done' ? 'Chromium is installed. Agents can open their browser now.'
                : `The install did not finish: ${own.install.line ?? 'no reason given'}`}
            </p>
          ) : null}
          {own?.headless && !noBrowser ? <p className="muted">The agents’ browser runs headless on this machine, since it has no display. Watch it and take over from the conversation’s Canvas.</p> : null}
        </Stack>
      </Section>

      <Section
        title="Who is driving"
        panel
        actions={sessions.length > 0 ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void run(() => api.browserControl('stop'))}>Stop agents’ browsing</Button>
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
                  <span className="ui-list-sub">{s.session!.agentId}, {s.needsOwner ? 'waiting for you' : s.busy ? 'working' : s.state}{s.route === 'chrome' ? ', in your Chrome' : s.route === 'apps' ? ', in your apps' : ''}</span>
                </span>
                <span className="ui-list-side">Open the Canvas</span>
              </a>
            ))}
          </div>
        )}
      </Section>

      {settings ? (
        <>
          <Section title="Where agents may look" panel>
            <Stack divided>
              <div className="ui-list-row">
                <span className="ui-list-main">
                  <span className="ui-list-title">Their own browser</span>
                  <span className="ui-list-sub">Always on. A separate profile, in the background; you watch and take over on the conversation’s Canvas.</span>
                </span>
                <Switch checked label="Their own browser" disabled onChange={() => undefined} />
              </div>
              <div className="ui-list-row">
                <span className="ui-list-main">
                  <span className="ui-list-title">Your Chrome</span>
                  <span className="ui-list-sub">For sites that need your sign-in, in background tabs, through the buddi extension.{chromeRoute?.message ? ` ${chromeRoute.message}` : ''}</span>
                </span>
                <Switch checked={settings.yourChrome} label="Your Chrome" disabled={busy || !data.enabled} onChange={(on) => save({ yourChrome: on })} />
              </div>
              {appsInstalled ? (
                <div className="ui-list-row">
                  <span className="ui-list-main">
                    <span className="ui-list-title">Your apps</span>
                    <span className="ui-list-sub">
                      {settings.yourApps === 'off' ? 'Off. Agents tell you when a task needs an app.' : 'From the Computer plugin · when you name an app.'}
                      {appsRoute?.message && settings.yourApps !== 'off' && !appsRoute.available ? <span className="pl-row-status" data-tone="critical"> {appsRoute.message}</span> : null}
                    </span>
                  </span>
                  <Toolbar>
                    {settings.yourApps !== 'off' && appsRoute?.available ? <Pill tone="good">ready</Pill> : null}
                    <Switch checked={settings.yourApps !== 'off'} label="Let agents use your apps" disabled={busy || !data.enabled} onChange={(on) => save({ yourApps: on ? 'on' : 'off' })} />
                    <ButtonLink size="sm" variant="ghost" href={pluginSettingsRoute(appsRoute?.provider || 'computer')}>Settings</ButtonLink>
                  </Toolbar>
                </div>
              ) : null}
              {data.stop ? (
                <Notice tone="warning" title="Browsing is stopped">
                  Since {fmtTime(data.stop.at, timezone ?? 'UTC')}{data.stop.until ? `, until ${fmtTime(data.stop.until, timezone ?? 'UTC')}` : ', until you resume it'}.{' '}
                  <Button size="sm" disabled={busy} onClick={() => void run(() => api.browserControl('resume'))}>Resume</Button>
                </Notice>
              ) : null}
              {settings.yourChrome ? <ExtensionPairing busy={busy} timezone={timezone} /> : null}
            </Stack>
          </Section>
          {macOS && !appsInstalled ? (
            <p className="muted" data-testid="computer-plugin-offer">
              Agents can also work in apps on this Mac with the Computer plugin.{' '}
              <a href="#/settings/plugins?tab=browse&kind=plugins">See plugins</a>
            </p>
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
/**
 * The Chrome Web Store's id for the same extension (mirrors
 * `STORE_EXTENSION_ID` in `packages/extension/src/id.ts`). The store build
 * carries no key, so its id differs; the page asks both.
 */
const STORE_EXTENSION_ID = 'pbfpjefkiijjgefblpnlnlpmeaddfbah';
/** Where the owner installs it: the store's listing. */
export const STORE_URL = 'https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah';
const EXTENSION_IDS = [EXTENSION_ID, STORE_EXTENSION_ID].filter(Boolean);

/**
 * Is Chrome version `a` older than `b`? Both in Chrome's scheme, one to four
 * dot-separated integers (`packages/extension/scripts/version.mjs`), compared
 * part by part with missing parts as 0. Anything unreadable is never "older":
 * a version the page cannot read is no reason to nag.
 */
export function olderExtension(a: string, b: string): boolean {
  const parse = (v: string) => /^\d+(\.\d+){0,3}$/.test(v.trim()) ? v.trim().split('.').map(Number) : null;
  const x = parse(a); const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

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
    for (const id of EXTENSION_IDS) {
      try {
        const answer = await chrome.runtime.sendMessage(id, { type: 'buddi.status' }) as ExtensionProbe | undefined;
        if (answer?.installed) return answer;
      } catch { /* not under this id */ }
    }
    return null;
  } catch { return null; }
}

/**
 * Can the browser reading this page take the extension?
 *
 * `chromium` is a desktop Chrome, Edge, Brave or Arc (all of them install from
 * the Chrome Web Store), `phone` is any phone or tablet, where no browser runs
 * extensions of this kind, and `other` is a desktop Firefox or Safari. Read from
 * the browser itself rather than the window's width: a narrow desktop window
 * can still install it.
 */
export function installTarget(nav: Pick<Navigator, 'userAgent'> & { userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string }> } } = navigator): 'chromium' | 'other' | 'phone' {
  const ua = nav.userAgent ?? '';
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'phone';
  if (nav.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand))) return 'chromium';
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\/|OPR\//.test(ua) ? 'chromium' : 'other';
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
  const thisMachine = useThisMachine();
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
  const target = installTarget();
  // The store first; the unpacked folder stays for a developer, folded away.
  const install = target === 'phone' ? null : target === 'other' ? (
    <p className="muted">The buddi extension needs Chrome, Edge, Brave or Arc on a computer. Open this page in one of them to install it.</p>
  ) : (
    <Stack>
      <Toolbar>
        <span className="muted">Install the buddi extension from the Chrome Web Store, then pair it here.</span>
        <Spacer />
        <ButtonLink variant="accent" href={STORE_URL} target="_blank" rel="noopener noreferrer">Add to Chrome</ButtonLink>
      </Toolbar>
      <Details summary="Developer install">
        <div className="ui-prose muted">
          <p>Open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick this folder.</p>
          <Code label="The unpacked extension">{data?.path ?? '…'}</Code>
        </div>
      </Details>
    </Stack>
  );
  return (
    <Stack divided>
      <ErrorBanner message={error ?? failure} />
      <Toolbar>
        <Pill tone={data?.connected ? 'good' : 'warning'}>{data?.connected ? 'Connected' : 'Not connected'}</Pill>
        <span className="muted">
          {data?.connected && data.pairedAt ? `Paired with Chrome on ${thisMachine} since ${fmtTime(data.pairedAt, zone)}`
            : data?.pairedAt ? 'Paired, but Chrome is not running the extension right now.'
            : 'No browser is paired with this buddi yet.'}
          {data?.extension ? ` · extension ${data.extension}` : ''}
        </span>
      </Toolbar>
      <Stack>
        <p className="muted">
          {probe ? `The browser you are reading this in has the extension, version ${probe.version}.`
            : target === 'phone' ? 'The extension runs in Chrome, Edge, Brave or Arc on a computer: install and pair it from there.'
            : data?.connected ? 'The browser you are reading this in has no buddi extension. You only need it here to pair this browser instead.'
            : 'The browser you are reading this in has no buddi extension yet.'}
          {probe?.state === 'paired' ? ' It is already paired with a buddi.' : ''}
          {probe?.state === 'disconnected' ? ' It is not connected yet: press Connect in its popup.' : ''}
        </p>
        {/* Only below what this buddi needs. A newer store build is not a signal the gateway has, so it is not guessed at. */}
        {probe && data?.extensionMinimum && olderExtension(probe.version, data.extensionMinimum) ? (
          <p className="muted">{`This extension is ${probe.version}; this buddi needs ${data.extensionMinimum} or later. Update it from chrome://extensions or the store.`}</p>
        ) : null}
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
      {!install ? null : data?.connected ? <Details summary="Pair a different browser">{install}</Details> : install}
      <Toolbar align="end">
        <Button variant="danger" disabled={disabled || !data?.pairedAt} onClick={() => void run(() => api.forgetExtension())}>Forget this browser</Button>
      </Toolbar>
    </Stack>
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
  /*
   * "Your browser" with Chrome closed on the host: the agent is paused, but
   * there is no tab anywhere to show. The gateway says so (`handReason`), and
   * the panel offers the two ways out instead of an empty live view.
   */
  const [offline, setOffline] = useState(false);
  const machine = useThisMachine();
  const control = async (action: 'stop' | 'takeover' | 'resume' | 'release') => {
    setBusy(true);
    setFailure(null);
    setHandNote(null);
    setOffline(false);
    try {
      const next = action !== 'stop' && data?.session
        ? await api.browserControl(action, data.session.id)
        : await api.browserControl(action);
      if (action === 'takeover') {
        if (next.hand && next.session) setDriving(next.session.id);
        else if (next.handReason === 'browser-offline') setOffline(true);
        else setHandNote(next.handMessage ?? null);
      } else setDriving(null);
    }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  /*
   * The other way out: buddi's own browser. The mode is one setting for the
   * whole installation, and it changes only with no session open, so this
   * conversation's session is released first; the agent opens the page again
   * in buddi's browser on the next message.
   */
  const switchToOwnBrowser = async () => {
    if (!data?.settings) return;
    setBusy(true);
    setFailure(null);
    try {
      // Not a setting any more: this conversation is pinned to buddi's own browser.
      if (data.session) {
        await api.browserPin(data.session.conversationId, 'own');
        await api.browserControl('release', data.session.id);
      }
      setOffline(false);
      setDriving(null);
      setHandNote('Switched to buddi\u2019s browser. Send the agent a message and it opens the page there.');
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
      {offline && yours ? (
        <Notice
          tone="warning"
          role="status"
          title="Your browser isn’t connected."
          action={(
            <Toolbar align="end">
              {data?.settings ? <Button size="sm" disabled={busy} onClick={() => void switchToOwnBrowser()}>Switch to buddi’s browser</Button> : null}
              <Button size="sm" variant="accent" disabled={busy} onClick={() => void control('takeover')}>Try again</Button>
            </Toolbar>
          )}
        >
          {`There is no Chrome tab to show or drive. Open Chrome on ${machine}: the buddi extension reconnects by itself, then try again. Or switch every agent to buddi’s own browser (it doesn’t have your Chrome sign-ins; switch back on this page).`}
        </Notice>
      ) : null}
      {data?.message && !hand && !(offline && yours) ? <Notice tone="warning" role="status">{data.message}</Notice> : null}
      {data?.session ? (
        <div className="browser-task">
          <div className="ui-row"><strong>{data.session.agentId}</strong><span className="muted">{data.session.steps} / {data.session.maxSteps} steps</span></div>
          {!compact ? <p>{data.session.task}</p> : null}
          <p className="muted">Last action: {data.lastAction ?? 'None'} · Access expires {fmtClock(new Date(data.session.expiresAt), Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
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
            <figcaption>Last observation · {fmtClock(new Date(data.page.capturedAt), Intl.DateTimeFormat().resolvedOptions().timeZone)} · {data.page.title || 'Untitled page'}</figcaption>
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
