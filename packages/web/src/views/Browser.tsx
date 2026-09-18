import { useState } from 'react';
import { api, type BrowserStatus, type ControlSettings } from '../api';
import { ErrorBanner, useAsync } from '../ui';

export function Browser(): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), [], 1500);
  const [selected, setSelected] = useState<string | null>(null);
  const current = data?.sessions?.find((item) => item.session?.id === selected) ?? data;
  return <>
    {data?.settings ? <ComputerSettings key={JSON.stringify(data.settings)} data={data} reload={reload} /> : null}
    {(data?.sessions?.length ?? 0) > 0 ? <nav className="browser-sessions" aria-label="Browser conversations">
      {data!.sessions!.map((item) => <button className="wb-btn" key={item.session!.id}
        aria-pressed={current?.session?.id === item.session!.id} onClick={() => setSelected(item.session!.id)}>
        {item.session!.agentId} · {item.session!.conversationId.slice(0, 8)} · {item.busy ? 'Working' : item.state === 'running' ? 'Ready' : item.state}
      </button>)}
    </nav> : null}
    <BrowserPanel key={current?.session?.id ?? 'idle'} data={current} error={error} reload={reload} />
  </>;
}

function ComputerSettings({ data, reload }: { data: BrowserStatus; reload: () => void }): JSX.Element {
  const [settings, setSettings] = useState<ControlSettings>(data.settings!);
  const [apps, setApps] = useState(settings.allowedApps.join('\n'));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = !!data.session || !!data.sessions?.length || data.busy;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); reload(); }
  };
  return <details className="browser-settings" open={!data.session}>
    <summary>Computer &amp; browser settings</summary>
    <ErrorBanner message={failure} />
    <fieldset disabled={busy || active || !data.enabled}>
      <label>Control mode<select value={settings.mode} onChange={(event) => setSettings({ ...settings, mode: event.target.value as ControlSettings['mode'] })}>
        <option value="computer">Computer control — macOS accessibility + screenshots (default)</option>
        <option value="playwright">Browser automation — Playwright (optional)</option>
      </select></label>
      <p className="muted">Computer mode uses OS input, not a browser debugging connection. One agent controls the desktop at a time. It uses your existing app windows and logins; releasing leaves them open. Playwright keeps separate conversation tabs in a dedicated browser profile. Modes never switch automatically.</p>
      <label>Browser application<select value={settings.browserApp} onChange={(event) => setSettings({ ...settings, browserApp: event.target.value })}>
        <option value="com.google.Chrome">Google Chrome</option><option value="com.apple.Safari">Safari</option><option value="org.chromium.Chromium">Chromium</option><option value="com.microsoft.edgemac">Microsoft Edge</option><option value="com.brave.Browser">Brave</option><option value="org.mozilla.firefox">Firefox</option>
      </select></label>
      <label>Allowed applications (bundle IDs, one per line)<textarea rows={4} value={apps} onChange={(event) => setApps(event.target.value)} /></label>
      <p className="muted">Include the selected browser. To enable a native app, add its bundle ID (for example com.apple.TextEdit or com.apple.calculator). Allow only apps you want agents to operate. Window screenshots and accessibility text go to your agent’s model provider. App permissions are not an OS sandbox; app network traffic is not intercepted in Computer mode.</p>
      <button className="wb-btn" onClick={() => void run(() => api.browserSettings({ ...settings, allowedApps: [...new Set(apps.split(/[\n,]/).map((app) => app.trim()).filter(Boolean))] }))}>Save control settings</button>
      <button className="wb-btn" onClick={() => void run(() => api.computerPermissions(false))}>Check permissions</button>
      <button className="wb-btn" onClick={() => void run(() => api.computerPermissions(true))}>Request macOS permissions</button>
    </fieldset>
    {active ? <p className="muted">Release all active sessions before changing settings or requesting permissions.</p> : null}
    {data.permissions ? <p role="status">{data.permissions.supported ? `Accessibility: ${data.permissions.accessibility ? 'Granted' : 'Needed'} · Screen Recording: ${data.permissions.screenRecording ? 'Granted' : 'Needed'}` : 'Computer control requires macOS 14 or later.'} {data.permissions.message}</p> : <p className="muted">Computer mode needs macOS Accessibility and Screen Recording permission for the Buddi helper/service. Check permissions before the first task; macOS may require restarting the service after granting them.</p>}
  </details>;
}

/** Shared by the full page and the conversation's trusted canvas tab. */
export function BrowserPanel({ data, error, reload, compact = false }: {
  data: BrowserStatus | undefined;
  error: string | null;
  reload: () => void;
  compact?: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const control = async (action: 'stop' | 'takeover' | 'resume' | 'release') => {
    setBusy(true);
    setFailure(null);
    try {
      if (action !== 'stop' && data?.session) await api.browserControl(action, data.session.id);
      else await api.browserControl(action);
    }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  const canControl = !!data?.enabled && !busy;
  const computer = data?.mode === 'computer';
  const help = computer ? 'Stop computer control interrupts native input and revokes access. Take over pauses agent input. Release ends this conversation’s control without closing your apps. Already dispatched actions cannot be undone. Avoid using the same mouse and keyboard while the agent is working.' : 'Stop all browsers closes every session and revokes access until you resume. Take over, Resume and Close & release affect only the selected conversation. An in-flight action is interrupted by closing its tabs. Actions already submitted cannot be undone.';
  return (
    <section className={`browser-panel${compact ? ' browser-panel-compact' : ''}`} aria-label="Host browser">
      <div className="browser-heading">
        <div><p className="browser-eyebrow">ON YOUR HOST MACHINE</p><h2>{computer ? 'Computer' : 'Browser'}</h2></div>
        <span className={`pill browser-state browser-state-${data?.state ?? 'unavailable'}`} role="status">
          {data?.busy ? 'Working' : data?.state === 'running' ? 'Ready' : data?.state ?? 'Connecting'}
        </span>
      </div>
      {compact ? <a className="browser-full-view" href="#/browser">{computer ? 'Open computer view & settings ↗' : 'Open full browser view ↗'}</a> : <p className="lede">{computer ? 'Your apps, operated through macOS accessibility, screenshots and input. No browser debugging connection.' : 'A real browser window, driven by your assistant. You stay in control.'}</p>}
      <ErrorBanner message={error ?? failure} />
      <div className="browser-toolbar">
        <button className="wb-btn browser-stop" disabled={!canControl || data?.state === 'stopped'} onClick={() => void control('stop')}>{computer ? 'Stop computer control' : 'Stop all browsers'}</button>
        <button className="wb-btn" disabled={!canControl || !data?.session || data?.state === 'paused'} onClick={() => void control('takeover')}>Take over</button>
        <button className="wb-btn" disabled={!canControl || data?.busy || !['stopped', 'paused'].includes(data?.state ?? '')} onClick={() => void control('resume')}>Resume access</button>
        <button className="wb-btn" disabled={!canControl || !data?.session} onClick={() => void control('release')}>{computer ? 'Release control' : 'Close & release'}</button>
      </div>
      {compact ? <details className="browser-help muted"><summary>About these controls</summary><p>{help}</p></details> : <p className="muted browser-help">{help}</p>}
      {data?.message ? <p className="attention" role="status">{data.message}</p> : null}
      {data?.session ? (
        <div className="browser-task">
          <div className="bar"><strong>{data.session.agentId}</strong><span className="muted">{data.session.steps} / {data.session.maxSteps} steps</span></div>
          {!compact ? <p>{data.session.task}</p> : null}
          <p className="muted">Last action: {data.lastAction ?? 'None'} · Access expires {new Date(data.session.expiresAt).toLocaleTimeString()}</p>
        </div>
      ) : <p className="browser-task muted">{data?.enabled ? computer ? 'No agent is driving. Ask an agent granted browser.* to open a website or an allowed native app.' : 'No agent is driving. Ask an agent granted browser.* to open a website.' : 'The host browser is unavailable. Start buddi serve on a machine with a desktop session.'}</p>}
      <div className="browser-window">
        <div className="browser-address"><span aria-hidden="true">◉</span><span>{data?.page?.url ?? (computer ? 'Waiting for an application' : 'Waiting for a website')}</span></div>
        {data?.hasScreenshot && data.page ? (
          <figure>
            <img key={data.page.id} src={`/api/browser/screenshot?v=${encodeURIComponent(data.page.id)}${data.session ? `&sessionId=${encodeURIComponent(data.session.id)}` : ''}`} alt={`Last browser observation: ${data.page.title || data.page.url}`} />
            <figcaption>Last observation · {new Date(data.page.capturedAt).toLocaleTimeString()} · {data.page.title || 'Untitled page'}</figcaption>
          </figure>
        ) : <div className="browser-empty"><strong>{computer ? 'Your selected app will appear here' : 'Your browser activity will appear here'}</strong><p>{computer ? 'Only the selected app window is captured, not the whole desktop. This preview is not interactive.' : 'This is a view of the host browser, not a second browser or a remote desktop.'}</p></div>}
      </div>
      {(data?.page?.tabs.length ?? 0) > 1 ? <details><summary>{data!.page!.tabs.length} open tabs</summary><ul>{data!.page!.tabs.map((tab) => <li key={tab.id}>{tab.title || tab.id} — {tab.url}</li>)}</ul></details> : null}
      <p className="muted browser-help">{computer ? 'Sign in directly in the host app during takeover. Don’t send passwords or MFA codes in chat. Native apps retain your existing logins and documents. Secure accessibility fields are masked; other sensitive window content can still appear in screenshots.' : 'Sign in directly in this conversation’s host tab during takeover. Don’t send passwords or MFA codes in chat. Agent tabs share saved logins and cookies.'} Screenshots update after agent actions; this is not a live video feed.</p>
    </section>
  );
}
