/**
 * Settings → Browser & apps, "Where agents may look" (docs/browser.md, "Routes"; the kit's
 * `WhereAgentsLook` in buddi-design Browser.jsx).
 *
 * Permissions and health, one row per route, a repair where health is red; no
 * radio buttons. Agents pick where to look for each task: buddi's own browser
 * first, the owner's Chrome for a site that needs his sign-in, an app when he
 * names one. This page says what they may use. The live view of what an agent
 * is doing is not here: it is the Page tab on the Canvas of the conversation.
 *
 * The apps row exists only when a plugin provides the route (the Computer
 * plugin); its own settings page (helper, macOS permissions, the allowed apps)
 * opens from the row's Settings. Without it, one line offers the plugin.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type AgentEngine, type BrowserRoute, type BrowserRouteStatus, type BrowserStatus, type ControlSettings, type ExtensionState } from '../api';
import { fmtClock, fmtTime } from '../format';
import { chatRoute, parsePairingCode, pluginSettingsRoute, withoutPairingCode } from '../routes';
import { ActionMenu, Avatar, Icon, Button, ButtonLink, Code, Details, Empty, ErrorBanner, Notice, Panel, Pill, Segment, Sheet, Spacer, Switch, Toolbar, useAsync } from '../ui';
import { useThisMachine } from '../useThisMachine';

/** The fix Ubuntu's AppArmor needs before Chromium's sandbox starts (docs/browser.md, Linux). */
export const SANDBOX_COMMAND = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

export function Browser({ timezone, navigate }: { embedded?: boolean; timezone?: string; navigate?: (route: string) => void } = {}): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), [], 3_000);
  const session = useAsync(() => api.session(), []);
  // Computer control is macOS-only. An unreadable or older session answer keeps the page as it was.
  const macOS = session.data?.platform ? session.data.platform === 'darwin' : true;
  const settled = !!session.data || !!session.error;
  const go = (route: string) => { if (navigate) navigate(route); else window.location.hash = route; };
  return (
    <div className="ui-stack br-looking" data-gap="lg">
      <ErrorBanner message={error} />
      {!data || !settled ? <Empty>Checking where agents may look…</Empty>
        : <WhereAgentsLook data={data} macOS={macOS} reload={reload} timezone={timezone} go={go} />}
    </div>
  );
}

/* ---------------- small parts, as the kit draws them ---------------- */

function Glyph({ kind }: { kind: 'own' | 'chrome' | 'apps' }): JSX.Element {
  const svg = {
    own: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2.8" y="3.6" width="14.4" height="12.8" rx="1.8" /><path d="M2.8 7.2h14.4M5.4 5.4h.1M7.4 5.4h.1" /></svg>,
    chrome: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="7.1" /><circle cx="10" cy="10" r="2.6" /><path d="M10 7.4h6.6M7.8 11.4 4.4 5.6M12.2 11.4 9 16.9" /></svg>,
    apps: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="11" y="3" width="6" height="6" rx="1.4" /><rect x="3" y="11" width="6" height="6" rx="1.4" /><rect x="11" y="11" width="6" height="6" rx="1.4" /></svg>,
  }[kind];
  return <span className="br-glyph" aria-hidden="true">{svg}</span>;
}

/** The two lines under a row's name: what it is for, then what is wrong (or happening) now. */
function Lines({ line, status, tone, children }: { line: ReactNode; status?: ReactNode; tone?: 'critical' | 'warning'; children?: ReactNode }): JSX.Element {
  return (
    <>
      <span className="pl-row-line">{line}</span>
      {status ? <span className="pl-row-status" data-tone={tone}>{status}</span> : null}
      {children}
    </>
  );
}

/** A command to run once, with Copy. */
function CopyLine({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <span className="br-copy">
      <code className="mono">{text}</code>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined); }}>{copied ? 'Copied' : 'Copy'}</Button>
    </span>
  );
}

/** A label and a hint on the left, the control on the right: the kit's Pref. */
function Pref({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="br-adv-row">
      <span className="br-adv-head"><span className="br-adv-title">{label}</span>{hint ? <span className="br-adv-hint">{hint}</span> : null}</span>
      {children}
    </div>
  );
}

/** `com.apple.iWork.Numbers` → `Numbers`: a name to say in a line, without asking Spotlight. */
export function appWord(bundleId: string): string {
  const last = bundleId.split('.').filter(Boolean).at(-1) ?? bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** `Numbers, Preview and 2 more`. */
function listWords(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const PIN_CHOICES: Array<{ value: 'auto' | BrowserRoute; label: string }> = [
  { value: 'auto', label: 'Let it choose' },
  { value: 'own', label: 'Its own browser only' },
  { value: 'chrome', label: 'Your Chrome first' },
  { value: 'apps', label: 'Your apps first' },
];

/** Where an agent may look, as a select: the Advanced list and the agent's own page. */
export function PinSelect({ value, label, apps, disabled, onChange }: { value: 'auto' | BrowserRoute; label: string; apps: boolean; disabled?: boolean; onChange: (value: 'auto' | BrowserRoute) => void }): JSX.Element {
  return (
    <select className="br-select" value={value} aria-label={label} disabled={disabled} onChange={(event) => onChange(event.target.value as 'auto' | BrowserRoute)}>
      {PIN_CHOICES.filter((choice) => apps || choice.value !== 'apps' || value === 'apps').map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>
  );
}

/** Whether a plugin provides the apps route here. */
export function appsProvided(route: BrowserRouteStatus | undefined): boolean {
  return route?.installed === true;
}

/* ---------------- the page ---------------- */

type ChromeState = 'none' | 'pair' | 'broken' | 'notrunning' | 'connected';

/**
 * Which of the kit's Chrome states this is. `broken` is a pairing this buddi
 * still holds that the extension in this browser has forgotten: the only way
 * a page can tell, since the gateway cannot see a pairing it has lost.
 */
export function chromeState(ext: ExtensionState | undefined, probe: ExtensionProbe | null): ChromeState {
  if (!ext) return 'none';
  if (ext.pending) return 'pair';
  if (!ext.pairedAt) return probe && probe.state !== 'paired' ? 'pair' : 'none';
  if (ext.connected) return 'connected';
  if (probe && probe.state !== 'paired' && sameGateway(probe.gateway)) return 'broken';
  return 'notrunning';
}

function WhereAgentsLook({ data, macOS, reload, timezone, go }: { data: BrowserStatus; macOS: boolean; reload: () => void; timezone?: string; go: (route: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  const settings = data.settings;
  const save = (next: SettingsChange) => void run(() => api.browserSettings(next));
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const learned = data.learnedSignInSites ?? [];
  const appsRoute = data.routes?.find((route) => route.kind === 'apps');
  const showApps = appsProvided(appsRoute);
  const sessions = data.sessions?.length ? data.sessions : data.session ? [data] : [];

  return (
    <>
      <Notice>Agents pick where to look for each task: their own browser first, your Chrome for a site that needs your sign-in, an app when you name one. You don’t choose each time; here you say what they may use.</Notice>
      <ErrorBanner message={failure} />
      {!data.enabled ? <Notice tone="warning">Agents can’t look at pages from here. Start buddi serve on the machine buddi runs on.</Notice> : null}
      {data.stop ? (
        <Notice tone="warning" role="status" action={<Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => api.browserControl('resume'))}>Resume</Button>}>
          {`Agents’ browsing is paused since ${fmtClock(new Date(data.stop.at), zone)}, by you from the Canvas, ${data.stop.until ? `until ${fmtClock(new Date(data.stop.until), zone)}` : 'until you resume it'}. An agent that needs a page asks you in its chat.`}
        </Notice>
      ) : null}

      <Panel title="Browsers and apps" flush>
        <div className="ui-list">
          <OwnRow data={data} busy={busy} run={run} />
          {settings ? <ChromeRow settings={settings} learned={learned} busy={busy || !data.enabled} save={save} zone={zone} /> : null}
          {showApps && settings ? <AppsRow route={appsRoute!} settings={settings} busy={busy || !data.enabled} save={save} run={run} onSettings={() => go(pluginSettingsRoute(appsRoute!.provider || 'computer'))} /> : null}
        </div>
      </Panel>
      {!showApps && macOS ? <p className="pl-note br-foot" data-testid="computer-plugin-offer">Agents can also work in apps on this Mac with the Computer plugin. <a href="#/settings/plugins?tab=browse&kind=plugins">See plugins</a></p> : null}

      {sessions.length > 0 ? (
        <Panel title="Looking now" flush actions={<Button size="sm" disabled={busy} onClick={() => void run(() => api.browserControl('stop'))}>Stop agents’ browsing</Button>}>
          <div className="ui-list">
            {sessions.map((s) => (
              <a key={s.session!.id} className="ui-list-row" href={chatRoute(s.session!.agentId, s.session!.conversationId, 'browser')}>
                <Avatar id={s.session!.agentId} name={s.session!.agentId} size="sm" />
                <span className="ui-list-main">
                  <span className="ui-list-title">{s.page?.title || s.session!.task}</span>
                  <span className="ui-list-sub">{lookingLine(s)}</span>
                </span>
                <span className="ui-list-side">Open the Canvas</span>
              </a>
            ))}
          </div>
        </Panel>
      ) : null}

      {settings ? <Advanced settings={settings} learned={learned} busy={busy} save={save} run={run} showApps={showApps} /> : null}
    </>
  );
}

/** "Looking at amazon.com · in your Chrome · background tab": the Page tab's quiet line. */
export function lookingLine(status: BrowserStatus): string {
  if (status.needsOwner) return `Waiting for you · ${status.needsOwner.kind === 'human' ? 'it asks for a human' : status.needsOwner.kind === 'uncertain' ? 'did that click land?' : status.needsOwner.kind === 'budget' ? 'keep going?' : 'it asks for your sign-in'}`;
  if (status.route === 'apps') return `Working in ${status.page?.appId ? appWord(status.page.appId) : 'an app'} · its own window`;
  const site = siteOfUrl(status.page?.url);
  return `Looking at ${site ?? 'a page'} · ${status.route === 'chrome' ? 'in your Chrome · background tab' : 'in buddi’s browser'}`;
}

/** The host without `www.`, as the runtime names a site. */
export function siteOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.replace(/^www\./, '') || undefined; } catch { return undefined; }
}

/* ---- buddi's own browser: always on, health only ---- */

function OwnRow({ data, busy, run }: { data: BrowserStatus; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void> }): JSX.Element {
  const own = data.browser;
  const install = own?.install;
  const purpose = data.settings?.showWindow ? 'For every page, in a window on this machine' : 'For every page, out of sight';
  let sub: ReactNode;
  let side: ReactNode;
  if (install?.state === 'running') {
    const percent = install.progress?.percent;
    sub = <Lines line={purpose} status={<span className="br-installing"><span className="pl-spin" aria-hidden="true" />{`Installing Chromium…${percent !== undefined ? ` ${Math.round(percent)}%` : ''}`}</span>} />;
    side = null;
  } else if (own?.engine === 'none') {
    sub = <Lines line={purpose} tone="critical" status={install?.state === 'failed' ? `The install didn’t finish: ${install.line ?? 'no reason given'}` : 'Chromium isn’t installed, so agents can’t look at pages yet.'} />;
    side = <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => api.browserInstall())}>Install · 150 MB</Button>;
  } else if (own?.problem === 'no-sandbox') {
    sub = <Lines line={purpose} tone="critical" status="Linux blocks its sandbox (AppArmor). Run this once, then Check again:"><CopyLine text={SANDBOX_COMMAND} /></Lines>;
    side = <Button size="sm" disabled={busy} onClick={() => void run(() => api.browserCheck())}>Check again</Button>;
  } else if (own?.problem) {
    sub = <Lines line={purpose} tone="critical" status={own.message ?? 'It doesn’t start on this machine.'} />;
    side = <Button size="sm" disabled={busy} onClick={() => void run(() => api.browserCheck())}>Check again</Button>;
  } else {
    sub = data.settings?.showWindow ? 'For every page, in a window on this machine. You also watch it on the Canvas.' : 'For every page, out of sight. You watch it on the Canvas.';
    side = data.enabled ? <Pill tone="good" dot>ready</Pill> : null;
  }
  return (
    <div className="ui-list-row">
      <Glyph kind="own" />
      <span className="ui-list-main"><span className="ui-list-title">buddi’s own browser</span><span className="ui-list-sub">{sub}</span></span>
      {side ? <span className="ui-list-side"><span className="br-side">{side}</span></span> : null}
    </div>
  );
}

/* ---- your Chrome: the switch once paired; Add to Chrome, the code, Pair again otherwise ---- */

/** How recent a pairing counts as the one this page just made by itself, when a typed code then gets a 409. */
export const SELF_PAIRED_WINDOW_MS = 10_000;

/**
 * Pair with a typed (or linked) code. The page may already have paired this
 * very browser by itself from the popup's code a moment earlier; the gateway
 * then answers the typed code with a 409. That is no failure: when a fresh
 * look at `/api/extension` shows a pairing made within the last ten seconds,
 * the 409 is swallowed. Any other failure is thrown as it came.
 */
export async function pairWithCode(code: string, deps: { pair: (code: string) => Promise<unknown>; extension: () => Promise<{ pairedAt?: string | null }>; now?: () => number } = { pair: (c) => api.pairExtension(c), extension: () => api.extension() }): Promise<void> {
  try {
    await deps.pair(code);
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 409) throw error;
    const now = (deps.now ?? Date.now)();
    const state = await deps.extension().catch(() => undefined);
    const at = state?.pairedAt ? Date.parse(state.pairedAt) : NaN;
    if (!(Number.isFinite(at) && now - at >= -SELF_PAIRED_WINDOW_MS && now - at <= SELF_PAIRED_WINDOW_MS)) throw error;
  }
  forgetLinkedCode();
}

/** Take a used pairing code out of the address without a navigation (`history.replaceState`). */
export function forgetLinkedCode(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash;
  const clean = withoutPairingCode(hash);
  if (clean === hash) return;
  try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${clean}`); } catch { /* the address keeps it; harmless */ }
}


/** A settings change, or the removal of one sign-in site from both lists (the owner's and the learned). */
type SettingsChange = Partial<ControlSettings> & { forgetSignInSite?: string };

function ChromeRow({ settings, learned, busy, save, zone }: { settings: ControlSettings; learned: readonly string[]; busy: boolean; save: (next: SettingsChange) => void; zone: string }): JSX.Element {
  const ext = useAsync(() => api.extension(), [], 3_000);
  const probe = useAsync(() => askExtension(), [], 3_000).data ?? null;
  const thisMachine = useThisMachine();
  // A `buddi://settings/browser?code=…` link pre-fills the code; the owner still presses Pair.
  const [code, setCode] = useState(() => parsePairingCode(typeof window === 'undefined' ? '' : window.location.hash) ?? '');
  useEffect(() => {
    // The app follows a second link while this page is already open.
    const follow = () => { const linked = parsePairingCode(window.location.hash); if (linked) setCode(linked); };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [unpacked, setUnpacked] = useState(false);
  const state = chromeState(ext.data, probe);
  const target = installTarget();
  const act = async (action: () => Promise<unknown>) => {
    setWorking(true); setFailure(null);
    try { await action(); } catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setWorking(false); ext.reload(); }
  };
  /*
   * The code is on screen in the extension's popup, in this very browser: the
   * page reads it and pairs by itself, so the owner never types it. A code the
   * page cannot read (another browser) is typed once.
   */
  const offered = ext.data?.pending && probe?.state === 'pairing' ? probe.code ?? '' : '';
  const tried = useRef('');
  useEffect(() => {
    if (!offered || tried.current === offered || working) return;
    tried.current = offered;
    void act(async () => { await api.pairExtension(offered); forgetLinkedCode(); });
  }, [offered]);
  const disabled = busy || working;
  const paired = ext.data?.pairedAt ? `paired ${fmtTime(ext.data.pairedAt, zone)}` : null;
  const version = probe?.version ?? ext.data?.extension;
  const more = (
    <ActionMenu label="More for your Chrome" items={[
      paired || state === 'broken' || state === 'notrunning' || state === 'connected' ? { label: 'Pair again', hint: [version ? `Extension ${version}` : null, paired].filter(Boolean).join(' · ') || undefined, onSelect: () => void act(() => api.forgetExtension()) } : null,
      // A developer's errand: only when buddi runs from a checkout. A packaged install has the store.
      ext.data?.checkout ? { label: 'Install unpacked…', hint: 'For a developer build of the extension', onSelect: () => setUnpacked(true) } : null,
      ext.data?.pairedAt ? 'separator' : null,
      ext.data?.pairedAt ? { label: 'Forget this Chrome…', tone: 'critical', onSelect: () => setForgetting(true) } : null,
    ]} />
  );
  /*
   * The six digits, typed here from the app window or any other browser: the
   * page cannot read the popup there, so the owner reads it and types it once.
   * Always offered until a pairing exists; a code with no browser behind it
   * gets the gateway's own sentence.
   */
  const codeField = (
    <span className="br-pair">
      <input aria-label="Pairing code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="482 913" value={code} onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && code.replace(/[^0-9]/g, '').length === 6 && !disabled) void act(async () => { await pairWithCode(code); setCode(''); }); }} />
      <Button size="sm" variant="accent" disabled={disabled || code.replace(/[^0-9]/g, '').length !== 6} onClick={() => void act(async () => { await pairWithCode(code); setCode(''); })}>Pair</Button>
    </span>
  );
  const enterCode = (
    <span className="br-enter-code">
      <span className="pl-row-line">Enter the code · Open the buddi icon in Chrome; type its code here</span>
      {codeField}
    </span>
  );
  const sites = [...settings.signInSites, ...learned];
  const sitesLine = sites.length > 0 ? `Always for ${listWords(sites)}` : null;
  let sub: ReactNode;
  let side: ReactNode;
  if (state === 'none') {
    sub = <Lines line="For sites that need your sign-in" status={target === 'chromium'
      ? 'Add the buddi extension to Chrome, then pair it here. Until then agents use their own browser and your saved logins.'
      : `The buddi extension runs in Chrome, Edge, Brave or Arc on a computer: add it there, then pair it on this page. Until then agents use their own browser and your saved logins.`}>{enterCode}</Lines>;
    side = <>{target === 'chromium' ? <ButtonLink size="sm" variant="accent" href={STORE_URL} target="_blank" rel="noopener noreferrer">Add to Chrome <span aria-hidden="true">↗</span></ButtonLink> : null}{more}</>;
  } else if (state === 'pair') {
    const found = probe ? `Extension ${probe.version} found in Chrome` : 'The buddi extension asks to pair';
    sub = offered ? (
      <Lines line={found} status="Pairing with the code the extension shows. This finishes by itself."><span className="br-code mono" aria-label="Pairing code">{offered.replace(/^(\d{3})(\d{3})$/, '$1 · $2')}</span></Lines>
    ) : ext.data?.pending ? (
      <Lines line={found} status="Type the six digits the extension shows.">{codeField}</Lines>
    ) : <Lines line={found} status="Open the extension and press Connect: it shows a code, and this page pairs with it.">{enterCode}</Lines>;
    side = more;
  } else if (state === 'broken') {
    sub = <Lines line="Used only for sites that need your sign-in" tone="critical" status="Chrome forgot the pairing, so agents use their own browser instead." />;
    side = <><Button size="sm" variant="accent" disabled={disabled} onClick={() => void act(() => api.forgetExtension())}>Pair again</Button>{more}</>;
  } else {
    const line = !settings.yourChrome ? 'Off. Sites that need a sign-in use your saved logins, or ask you.'
      : state === 'notrunning' ? `Used only for sites that need your sign-in · Chrome isn’t open on ${thisMachine}; agents wait or use their own browser`
      : 'Used only for sites that need your sign-in · background tabs in a buddi group';
    sub = sitesLine && settings.yourChrome ? <Lines line={line} status={sitesLine} /> : line;
    side = (
      <>
        {settings.yourChrome ? (state === 'notrunning' ? <Pill>Chrome closed</Pill> : <Pill tone="good" dot>connected</Pill>) : null}
        <Switch checked={settings.yourChrome} label="Let agents use your Chrome" disabled={disabled} onChange={(on) => save({ yourChrome: on })} />
        {more}
      </>
    );
  }
  const outdated = probe && ext.data?.extensionMinimum && olderExtension(probe.version, ext.data.extensionMinimum)
    ? `This extension is ${probe.version}; this buddi needs ${ext.data.extensionMinimum} or later. Update it from chrome://extensions or the store.` : null;
  const elsewhere = probe && !sameGateway(probe.gateway) ? `The extension is pointed at ${probe.gateway}; set it to ${window.location.origin} in its popup.` : null;
  // The dashboard moved port since the pairing: the extension looks in the old place until it is paired again.
  const moved = ext.data?.portMoved && state !== 'pair'
    ? `Port ${ext.data.portMoved.from} was taken by another program, so buddi now listens on ${ext.data.portMoved.to}. Pair the extension again: in its popup set the address to http://127.0.0.1:${ext.data.portMoved.to} and press Connect.` : null;
  if (moved && state !== 'broken' && state !== 'none') {
    side = <><Button size="sm" variant="accent" disabled={disabled} onClick={() => void act(() => api.forgetExtension())}>Pair again</Button>{more}</>;
  }
  return (
    <>
      <div className="ui-list-row">
        <Glyph kind="chrome" />
        <span className="ui-list-main">
          <span className="ui-list-title">Your Chrome</span>
          <span className="ui-list-sub">{sub}{outdated ? <span className="pl-row-status" data-tone="warning">{outdated}</span> : null}{elsewhere ? <span className="pl-row-status" data-tone="warning">{elsewhere}</span> : null}{moved ? <span className="pl-row-status" data-tone="warning">{moved}</span> : null}{failure ?? ext.error ? <span className="pl-row-status" data-tone="critical">{failure ?? ext.error}</span> : null}</span>
        </span>
        <span className="ui-list-side"><span className="br-side">{side}</span></span>
      </div>
      {forgetting ? (
        <div className="br-confirm">
          <Notice tone="warning" action={<Toolbar align="end"><Button size="sm" variant="ghost" onClick={() => setForgetting(false)}>Cancel</Button><Button size="sm" variant="danger" disabled={disabled} onClick={() => { setForgetting(false); void act(() => api.forgetExtension()); }}>Forget</Button></Toolbar>}>
            Forget this Chrome? Agents stop using it until you pair it again.
          </Notice>
        </div>
      ) : null}
      {unpacked ? (
        <Sheet title="Install the extension unpacked" onClose={() => setUnpacked(false)}>
          <div className="ui-prose muted">
            <p>For a developer build. Open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick this folder. Then pair it on this page.</p>
          </div>
          <Code label="The unpacked extension">{ext.data?.path ?? '…'}</Code>
        </Sheet>
      ) : null}
    </>
  );
}

/* ---- your apps: only when a provider exists ---- */

function AppsRow({ route, settings, busy, save, run, onSettings }: { route: BrowserRouteStatus; settings: ControlSettings; busy: boolean; save: (next: Partial<ControlSettings>) => void; run: (action: () => Promise<unknown>) => Promise<void>; onSettings: () => void }): JSX.Element {
  const on = settings.yourApps !== 'off';
  const from = `From the ${route.label ?? appWord(route.provider.replace(/^@withbuddi\/plugin-/, ''))} plugin`;
  const broken = on && !route.available && !!route.message;
  const sub = broken
    ? <Lines line={from} tone="critical" status={route.message} />
    : on ? `${from} · ${settings.yourApps === 'ask' ? 'asks for each app' : 'when you name an app'}` : 'Off. Agents tell you when a task needs an app.';
  return (
    <div className="ui-list-row">
      <Glyph kind="apps" />
      <span className="ui-list-main"><span className="ui-list-title">Your apps</span><span className="ui-list-sub">{sub}</span></span>
      <span className="ui-list-side">
        <span className="br-side">
          {broken && route.repair === 'permissions' ? <Button size="sm" variant="accent" onClick={onSettings}>Allow in macOS</Button> : null}
          {!broken && on ? <Pill tone="good" dot>ready</Pill> : null}
          {broken && route.repair === 'permissions' ? null : <Switch checked={on} label="Let agents use your apps" disabled={busy} onChange={(next) => save({ yourApps: next ? 'on' : 'off' })} />}
          <Button size="sm" variant="ghost" aria-label="Manage apps" onClick={onSettings}>Settings<Icon name="chevron-right" size={12} /></Button>
        </span>
      </span>
    </div>
  );
}

/* ---- Advanced: the first choice, the agents' own rules, the Stop, the cap, the window ---- */

function Advanced({ settings, learned, busy, save, run, showApps }: { settings: ControlSettings; learned: readonly string[]; busy: boolean; save: (next: SettingsChange) => void; run: (action: () => Promise<unknown>) => Promise<void>; showApps: boolean }): JSX.Element {
  const agents = useAsync(() => api.agents(), []);
  const engines: AgentEngine[] = agents.data?.engines ?? [];
  const ruled = engines.filter((engine) => engine.browser && engine.browser !== 'auto');
  const free = engines.filter((engine) => !engine.browser || engine.browser === 'auto');
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [rule, setRule] = useState<'auto' | BrowserRoute>('own');
  const [site, setSite] = useState('');
  const setPin = (id: string, browser: 'auto' | BrowserRoute) => void run(async () => { await api.setAgentEngine(id, { browser }); agents.reload(); });
  const first = settings.defaultRoute === 'apps' ? 'auto' : settings.defaultRoute;
  const pages = [1, 3, 5].includes(settings.maxOwnPages) ? [1, 3, 5] : [1, 3, 5, settings.maxOwnPages].sort((a, b) => a - b);
  const addSite = () => {
    const host = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!host || settings.signInSites.includes(host) || learned.includes(host)) { setSite(''); return; }
    save({ signInSites: [...settings.signInSites, host] });
    setSite('');
  };
  return (
    <Details boxed summary="Advanced">
      <div className="br-adv">
        <Pref label="First choice for every agent" hint="Let them choose is right for almost everyone: a wrong guess costs one extra page load, never a stop.">
          <Segment label="First choice for every agent" value={first} onChange={(value) => save({ defaultRoute: value })}
            options={[{ value: 'auto', label: 'Let them choose' }, { value: 'own', label: 'Own browser only' }, { value: 'chrome', label: 'Your Chrome first' }]} />
        </Pref>
        <div className="br-adv-block">
          <span className="br-adv-head"><span className="br-adv-title">Agents with their own rule</span><span className="br-adv-hint">Also on each agent’s page, under Where it may look. A rule never allows what is off above.</span></span>
          {ruled.length ? (
            <div className="ui-list">
              {ruled.map((engine) => (
                <div key={engine.id} className="ui-list-row">
                  <Avatar id={engine.id} name={engine.name} size="sm" />
                  <span className="ui-list-main"><span className="ui-list-title">{engine.name}</span></span>
                  <span className="ui-list-side">
                    <PinSelect value={engine.browser ?? 'auto'} label={`Where ${engine.name} may look`} apps={showApps} disabled={busy} onChange={(value) => setPin(engine.id, value)} />
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPin(engine.id, 'auto')}>Remove</Button>
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="br-adv-empty">No agent has its own rule. Every agent follows the first choice.</p>}
          {adding ? (
            <Toolbar>
              <select className="br-select" aria-label="Agent" value={pick} onChange={(event) => setPick(event.target.value)}>
                <option value="">Choose an agent</option>
                {free.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
              </select>
              <PinSelect value={rule} label="Its rule" apps={showApps} onChange={setRule} />
              <Spacer />
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" variant="accent" aria-label="Add this rule" disabled={busy || !pick || rule === 'auto'} onClick={() => { setPin(pick, rule); setAdding(false); setPick(''); }}>Add</Button>
            </Toolbar>
          ) : (
            <Toolbar><Button size="sm" disabled={free.length === 0} onClick={() => setAdding(true)}><span aria-hidden="true">+</span> Give an agent its own rule</Button></Toolbar>
          )}
        </div>
        <div className="br-adv-block">
          <span className="br-adv-head"><span className="br-adv-title">Sites that need your sign-in</span><span className="br-adv-hint">Always looked at in your Chrome while it is on and connected. buddi adds a site, outlined dashed, when it meets its sign-in page.</span></span>
          {settings.signInSites.length || learned.length ? (
            <span className="br-sites">
              {settings.signInSites.map((host) => (
                <span key={host} className="br-site-chip mono">{host}<button type="button" aria-label={`Remove ${host}`} disabled={busy} onClick={() => save({ forgetSignInSite: host })}>×</button></span>
              ))}
              {learned.map((host) => (
                <span key={host} className="br-site-chip mono" data-learned="true" title="buddi added this when it met its sign-in page">{host}<button type="button" aria-label={`Remove ${host}`} disabled={busy} onClick={() => save({ forgetSignInSite: host })}>×</button></span>
              ))}
            </span>
          ) : <p className="br-adv-empty">None yet.</p>}
          <form className="br-site-add" onSubmit={(event) => { event.preventDefault(); addSite(); }}>
            <input aria-label="A site that needs your sign-in" placeholder="amazon.com" value={site} onChange={(event) => setSite(event.target.value)} />
            <Button size="sm" type="submit" disabled={busy || !site.trim()}>Add</Button>
          </form>
        </div>
        <Pref label="Stop agents’ browsing lasts" hint="What Stop in the Canvas does. Resume from the chat card, here, or /browser resume on Telegram.">
          <Segment label="Stop agents’ browsing lasts" value={settings.stopExpiryMinutes === 0 ? 'until' : 'hour'} onChange={(value) => save({ stopExpiryMinutes: value === 'until' ? 0 : 60 })}
            options={[{ value: 'hour', label: 'An hour' }, { value: 'until', label: 'Until I say' }]} />
        </Pref>
        <Pref label="Pages open at once" hint="In buddi’s own browser. One more waits its turn; nothing is refused.">
          <Segment label="Pages open at once" value={String(settings.maxOwnPages)} onChange={(value) => save({ maxOwnPages: Number(value) })}
            options={pages.map((n) => ({ value: String(n), label: String(n) }))} />
        </Pref>
        <Pref label="Show buddi’s browser as a window" hint="Off: it works out of sight and you watch on the Canvas. On for the few sites that refuse a hidden browser.">
          <Switch checked={settings.showWindow} label="Show buddi’s browser as a window" disabled={busy} onChange={(on) => save({ showWindow: on })} />
        </Pref>
        <p className="br-adv-empty">Missions run without you, so they look only in buddi’s own browser, never in your Chrome.</p>
      </div>
    </Details>
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
export interface ExtensionProbe {
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

