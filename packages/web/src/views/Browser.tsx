import { useState } from 'react';
import { api, type BrowserStatus, type ControlSettings } from '../api';
import { Button, Details, ErrorBanner, Field, Notice, Page, Pill, Toolbar, useAsync } from '../ui';

export function Browser(): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), [], 1500);
  const [selected, setSelected] = useState<string | null>(null);
  const current = data?.sessions?.find((item) => item.session?.id === selected) ?? data;
  return (
    <Page>
      {data?.settings ? <ComputerSettings key={JSON.stringify(data.settings)} data={data} reload={reload} /> : null}
      {(data?.sessions?.length ?? 0) > 0 ? (
        <nav aria-label="Browser conversations">
          <Toolbar>
            {data!.sessions!.map((item) => (
              <Button
                size="sm"
                key={item.session!.id}
                aria-pressed={current?.session?.id === item.session!.id}
                onClick={() => setSelected(item.session!.id)}
              >
                {item.session!.agentId} · {item.session!.conversationId.slice(0, 8)} · {item.busy ? 'Working' : item.state === 'running' ? 'Ready' : item.state}
              </Button>
            ))}
          </Toolbar>
        </nav>
      ) : null}
      <BrowserPanel key={current?.session?.id ?? 'idle'} data={current} error={error} reload={reload} />
    </Page>
  );
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
  return (
    <Details boxed summary="Computer & browser settings" open={!data.session}>
      <ErrorBanner message={failure} />
      <fieldset className="ui-fields" data-stack="true" disabled={busy || active || !data.enabled}>
        <Field
          label="Control mode"
          hint="Computer mode uses OS input, not a browser debugging connection. One agent controls the desktop at a time. It uses your existing app windows and logins; releasing leaves them open. Playwright keeps separate conversation tabs in a dedicated browser profile. Modes never switch automatically."
        >
          <select value={settings.mode} onChange={(event) => setSettings({ ...settings, mode: event.target.value as ControlSettings['mode'] })}>
            <option value="computer">Computer control — macOS accessibility + screenshots (default)</option>
            <option value="playwright">Browser automation — Playwright (optional)</option>
          </select>
        </Field>
        <Field label="Browser application">
          <select value={settings.browserApp} onChange={(event) => setSettings({ ...settings, browserApp: event.target.value })}>
            <option value="com.google.Chrome">Google Chrome</option><option value="com.apple.Safari">Safari</option><option value="org.chromium.Chromium">Chromium</option><option value="com.microsoft.edgemac">Microsoft Edge</option><option value="com.brave.Browser">Brave</option><option value="org.mozilla.firefox">Firefox</option>
          </select>
        </Field>
        <Field
          label="Allowed applications (bundle IDs, one per line)"
          hint="Include the selected browser. To enable a native app, add its bundle ID (for example com.apple.TextEdit or com.apple.calculator). Allow only apps you want agents to operate. Window screenshots and accessibility text go to your agent’s model provider. App permissions are not an OS sandbox; app network traffic is not intercepted in Computer mode."
        >
          <textarea rows={4} value={apps} onChange={(event) => setApps(event.target.value)} />
        </Field>
        <Toolbar>
          <Button variant="accent" onClick={() => void run(() => api.browserSettings({ ...settings, allowedApps: [...new Set(apps.split(/[\n,]/).map((app) => app.trim()).filter(Boolean))] }))}>Save control settings</Button>
          <Button onClick={() => void run(() => api.computerPermissions(false))}>Check permissions</Button>
          <Button onClick={() => void run(() => api.computerPermissions(true))}>Request macOS permissions</Button>
        </Toolbar>
      </fieldset>
      {active ? <p className="muted">Release all active sessions before changing settings or requesting permissions.</p> : null}
      {data.permissions ? (
        <p role="status">
          {data.permissions.supported ? `Accessibility: ${data.permissions.accessibility ? 'Granted' : 'Needed'} · Screen Recording: ${data.permissions.screenRecording ? 'Granted' : 'Needed'}` : 'Computer control requires macOS 14 or later.'} {data.permissions.message}
        </p>
      ) : (
        <p className="muted">Computer mode needs macOS Accessibility and Screen Recording permission for the Buddi helper/service. Check permissions before the first task; macOS may require restarting the service after granting them.</p>
      )}
    </Details>
  );
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
  const state = data?.busy ? 'Working' : data?.state === 'running' ? 'Ready' : data?.state ?? 'Connecting';
  const tone = data?.busy || data?.state === 'running' ? 'good' : data?.state === 'stopped' || data?.state === 'error' ? 'critical' : undefined;
  return (
    <section className="browser-panel" data-compact={compact ? 'true' : undefined} aria-label="Host browser">
      <div className="browser-heading">
        <div>
          {compact ? null : <p className="browser-eyebrow">On your host machine</p>}
          <h2 className="browser-title">{computer ? 'Computer' : 'Browser'}</h2>
        </div>
        <Pill tone={tone}>
          <span role="status">{state}</span>
        </Pill>
      </div>
      {compact ? (
        <a className="browser-full-view" href="#/browser">{computer ? 'Open computer view & settings ↗' : 'Open full browser view ↗'}</a>
      ) : (
        <p className="ui-page-lede">{computer ? 'Your apps, operated through macOS accessibility, screenshots and input. No browser debugging connection.' : 'A real browser window, driven by your assistant. You stay in control.'}</p>
      )}
      <ErrorBanner message={error ?? failure} />
      <Toolbar>
        <Button variant="danger" disabled={!canControl || data?.state === 'stopped'} onClick={() => void control('stop')}>{computer ? 'Stop computer control' : 'Stop all browsers'}</Button>
        <Button disabled={!canControl || !data?.session || data?.state === 'paused'} onClick={() => void control('takeover')}>Take over</Button>
        <Button disabled={!canControl || data?.busy || !['stopped', 'paused'].includes(data?.state ?? '')} onClick={() => void control('resume')}>Resume access</Button>
        <Button disabled={!canControl || !data?.session} onClick={() => void control('release')}>{computer ? 'Release control' : 'Close & release'}</Button>
      </Toolbar>
      {compact ? <Details summary="About these controls"><p className="muted">{help}</p></Details> : <p className="muted">{help}</p>}
      {data?.message ? <Notice tone="warning" role="status">{data.message}</Notice> : null}
      {data?.session ? (
        <div className="browser-task">
          <div className="ui-row"><strong>{data.session.agentId}</strong><span className="muted">{data.session.steps} / {data.session.maxSteps} steps</span></div>
          {!compact ? <p>{data.session.task}</p> : null}
          <p className="muted">Last action: {data.lastAction ?? 'None'} · Access expires {new Date(data.session.expiresAt).toLocaleTimeString()}</p>
        </div>
      ) : (
        <p className="browser-task muted">{data?.enabled ? computer ? 'No agent is driving. Ask an agent granted browser.* to open a website or an allowed native app.' : 'No agent is driving. Ask an agent granted browser.* to open a website.' : 'The host browser is unavailable. Start buddi serve on a machine with a desktop session.'}</p>
      )}
      <div className="browser-window">
        <div className="browser-address"><span aria-hidden="true">◉</span><span>{data?.page?.url ?? (computer ? 'Waiting for an application' : 'Waiting for a website')}</span></div>
        {data?.hasScreenshot && data.page ? (
          <figure>
            <img key={data.page.id} src={`/api/browser/screenshot?v=${encodeURIComponent(data.page.id)}${data.session ? `&sessionId=${encodeURIComponent(data.session.id)}` : ''}`} alt={`Last browser observation: ${data.page.title || data.page.url}`} />
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
      <p className="muted">{computer ? 'Sign in directly in the host app during takeover. Don’t send passwords or MFA codes in chat. Native apps retain your existing logins and documents. Secure accessibility fields are masked; other sensitive window content can still appear in screenshots.' : 'Sign in directly in this conversation’s host tab during takeover. Don’t send passwords or MFA codes in chat. Agent tabs share saved logins and cookies.'} Screenshots update after agent actions; this is not a live video feed.</p>
    </section>
  );
}
