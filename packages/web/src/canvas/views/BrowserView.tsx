/**
 * The Page tab: the page an agent is looking at, beside the conversation
 * looking at it (docs/browser.md; the kit's `BrCanvas` in buddi-design
 * Browser.jsx).
 *
 * Who is looking where, the live picture, Take over and Stop. Nothing else: no
 * step list, no counter, no mode, no observation time. One quiet line says
 * where it looks — "Looking at amazon.com · in buddi’s browser", "· in your
 * Chrome · background tab", "· in Numbers" — or that it waits for the owner.
 *
 * The picture is re-requested on a timer rather than streamed: the route hands
 * back whatever the last observation captured, and asking again is the whole
 * of "live". The asking pauses while the tab is in the background and gives up
 * after a few failures. **When the page closes the gateway has nothing left to
 * serve**, so this keeps its own copy: the last status it saw, and the last
 * frame as bytes held in the page. That copy is what a closed page shows.
 *
 * Take over is the remote hand in this same frame: "You have the page",
 * nothing typed is kept, Keyboard · Give it back; the agent carries on with no
 * new message. Who holds the page is the server's word (a paused page is the
 * owner's), not this tab's: a take-over from a chat card, a reload, or a route
 * with no remote hand still shows Give it back.
 */
import { useEffect, useRef, useState } from 'react';
import { api, csrfToken, type BrowserStatus } from '../../api';
import { fmtClock } from '../../format';
import { ActionMenu, Button, Notice, Toolbar } from '../../ui';
import { RemoteHand } from '../../views/RemoteHand';
import { appWord, lookingLine, siteOfUrl } from '../../views/Browser';
import { useThisMachine } from '../../useThisMachine';

/** How often the last observation is re-requested while a page is open. */
export const BROWSER_POLL_MS = 2000;

/**
 * How many pictures may fail to arrive before the asking stops. A route that
 * has refused five times in a row is not about to answer the sixth, and the
 * tab still has the last frame that did arrive.
 */
export const MAX_SCREENSHOT_FAILURES = 5;

export interface BrowserViewProps {
  status: BrowserStatus | undefined;
  error: string | null;
  reload: () => void;
  /** Is the page still open? */
  live: boolean;
  /** Who is looking, for the lines that name it. */
  agentName?: string;
  /** The owner's zone, for the paused and done times. */
  timezone?: string;
  /**
   * Agents' browsing is paused and this conversation asked for a page: the
   * tab says so with Resume, even though no page is open.
   */
  paused?: { at: string; until?: string } | null;
}

/** Where the route serves the picture for the observation on screen now. */
function screenshotUrl(status: BrowserStatus, refresh?: number): string | null {
  if (!status.hasScreenshot || !status.page) return null;
  const session = status.session ? `&sessionId=${encodeURIComponent(status.session.id)}` : '';
  return `/api/browser/screenshot?v=${encodeURIComponent(status.page.id)}${session}${refresh ? `&tick=${refresh}` : ''}`;
}

/** The letter on the page's tile: the site's, or the app's. */
function tileLetter(status: BrowserStatus | undefined): string {
  if (status?.route === 'apps' && status.page?.appId) return appWord(status.page.appId).charAt(0).toUpperCase();
  const site = siteOfUrl(status?.page?.url);
  return (site ?? status?.page?.title ?? '·').charAt(0).toUpperCase();
}

export function BrowserView({ status, error, reload, live, agentName = 'The agent', timezone, paused = null }: BrowserViewProps): JSX.Element {
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  /*
   * One counter, appended to the screenshot's URL. The image element is the
   * poller: a new query means a new request, and nothing here has to hold a
   * picture in memory or diff one.
   */
  const [tick, setTick] = useState(0);
  const [failures, setFailures] = useState(0);
  const stalled = failures >= MAX_SCREENSHOT_FAILURES;
  useEffect(() => {
    if (!live || stalled) return undefined;
    const handle = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick((value) => value + 1);
    }, BROWSER_POLL_MS);
    return () => window.clearInterval(handle);
  }, [live, stalled]);

  // The last status this tab saw while the page was its own: after the close
  // there is nothing to read, and this is the record of what there was.
  const remembered = useRef<BrowserStatus | null>(null);
  if (live && status?.session) remembered.current = status;
  const [closedAt, setClosedAt] = useState<number | null>(null);
  useEffect(() => { if (!live && remembered.current && closedAt === null) setClosedAt(Date.now()); if (live) setClosedAt(null); }, [live]);

  /* The last frame, kept as bytes: fetched once per observation. */
  const [frame, setFrame] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  const observation = status?.page?.id ?? null;
  useEffect(() => {
    const url = live && status ? screenshotUrl(status) : null;
    if (!url || typeof fetch !== 'function' || typeof URL?.createObjectURL !== 'function') return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok || cancelled) return;
        const bytes = await response.blob();
        if (cancelled) return;
        const object = URL.createObjectURL(bytes);
        if (held.current) URL.revokeObjectURL(held.current);
        held.current = object;
        setFrame(object);
      } catch { /* the live image element is still trying */ }
    })();
    return () => { cancelled = true; };
  }, [live, observation]);
  useEffect(() => () => { if (held.current && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(held.current); }, []);

  const kept = remembered.current;
  const shown = live ? status : kept ?? status;

  /* ---- the owner's hand ---- */
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [driving, setDriving] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const machine = useThisMachine();
  const session = shown?.session;
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  const takeOver = () => void act(async () => {
    setNote(null); setOffline(false);
    const asked = session?.id;
    const next = await api.browserControl('takeover', asked);
    // The answer is the page asked about; with several open, never another one.
    if (next.hand && next.session && (!asked || next.session.id === asked)) setDriving(next.session.id);
    else if (next.handReason === 'browser-offline') setOffline(true);
    else setNote(next.handMessage ?? null);
  });
  const giveBack = () => void act(async () => { setDriving(null); setTyping(false); await api.browserControl('resume', session?.id); });
  const stopPage = () => void act(async () => { setDriving(null); await api.browserControl('stop', session?.id); });
  const ownBrowser = () => void act(async () => {
    if (!session) return;
    // This conversation, pinned to buddi's own browser; the agent opens the page there next.
    await api.browserPin(session.conversationId, 'own');
    await api.browserControl('release', session.id);
    setOffline(false);
    setNote('This conversation uses buddi’s browser now. Send the agent a message and it opens the page there.');
  });
  // The owner holds this page when the server says it is paused, however it got there.
  const owned = live && !!status?.session && status.state === 'paused';
  const hand = owned && driving && status?.session?.id === driving ? driving : null;

  /* ---- what the header says ---- */
  const taking = owned;
  const waiting = live && !!shown?.needsOwner;
  const done = !live && !paused;
  const site = siteOfUrl(shown?.page?.url) ?? (shown?.page?.appId ? appWord(shown.page.appId) : 'the page');
  const where = shown?.route === 'chrome' ? 'in your Chrome · background tab' : shown?.route === 'apps' ? `in ${site}` : 'in buddi’s browser';
  const title = paused ? 'Browsing is paused' : shown?.page?.title || site;
  const line = paused ? `By you at ${fmtClock(new Date(paused.at), zone)} · ${paused.until ? `until ${fmtClock(new Date(paused.until), zone)}` : 'until you resume it'}`
    : taking ? `You have the page · ${where}`
    : done ? `${agentName} looked at ${site} · done${closedAt ? ` at ${fmtClock(new Date(closedAt), zone)}` : ''}`
    : shown ? lookingLine(shown) : 'Opening the page…';
  const src = live ? (shown ? screenshotUrl(shown, tick) : null) : frame;

  return (
    <div className="br-canvas" data-testid="browser-view" data-live={live ? 'true' : 'false'}>
      <header className="br-head">
        <span className="br-tile" aria-hidden="true">{paused ? <GlobeGlyph /> : tileLetter(shown)}</span>
        <span className="br-head-text">
          <span className="br-head-title">{title}</span>
          <span className="br-head-line" role="status">{live && !waiting && !taking && !paused ? <span className="br-live" aria-hidden="true" /> : null}{line}</span>
        </span>
        {taking ? (
          <Toolbar align="end">
            {hand ? <Button size="sm" variant={typing ? 'accent' : 'ghost'} aria-pressed={typing} onClick={() => setTyping(!typing)}>Keyboard</Button>
              : <Button size="sm" variant="ghost" disabled={busy} onClick={takeOver}>Drive it here</Button>}
            <Button size="sm" variant="accent" disabled={busy} onClick={giveBack}>Give it back</Button>
          </Toolbar>
        ) : paused ? (
          <Button size="sm" variant="accent" disabled={busy} onClick={() => void act(async () => { await api.browserControl('resume'); })}>Resume</Button>
        ) : done || !session ? null : (
          <Toolbar align="end">
            <Button size="sm" disabled={busy || !shown?.enabled} onClick={stopPage}>Stop</Button>
            <Button size="sm" variant={waiting ? 'accent' : undefined} disabled={busy || !shown?.enabled || shown?.state === 'paused'} onClick={takeOver}>Take over</Button>
          </Toolbar>
        )}
      </header>
      {taking ? <p className="br-hand-said" role="status">{hand ? `Nothing you type here is kept. ${agentName} carries on when you give it back.` : `${agentName} waits. It carries on when you give the page back.`}</p> : null}
      {failure || error ? <Notice tone="critical" role="alert">{failure ?? error}</Notice> : null}
      {note ? <Notice tone="warning" role="status">{note}</Notice> : null}
      {offline ? (
        <Notice tone="warning" role="status" title="Your Chrome isn’t connected."
          action={<Toolbar align="end"><Button size="sm" disabled={busy} onClick={ownBrowser}>Use buddi’s browser</Button><Button size="sm" variant="accent" disabled={busy} onClick={takeOver}>Try again</Button></Toolbar>}>
          {`Open Chrome on ${machine} and try again, or let this conversation use buddi’s own browser.`}
        </Notice>
      ) : null}
      {paused ? (
        <div className="br-frame br-frame-empty"><p className="ui-empty">{`No page is open. Agents look again when you resume${paused.until ? `, or by themselves at ${fmtClock(new Date(paused.until), zone)}` : ''}.`}</p></div>
      ) : hand ? (
        <div className="br-frame" data-state="yours">
          <RemoteHand sessionId={hand} csrf={csrfToken()} onGiveBack={giveBack} bare typing={typing} onTyping={setTyping} />
        </div>
      ) : (
        <div className="br-frame" data-state={waiting ? 'waiting' : done ? 'done' : 'live'}>
          {src ? (
            <img
              key={live ? shown?.page?.id ?? 'live' : 'kept'}
              className="br-shot"
              src={src}
              alt={`What ${agentName} sees: ${shown?.page?.title || site}`}
              onError={() => setFailures((count) => count + 1)}
              onLoad={() => setFailures(0)}
            />
          ) : <p className="ui-empty br-frame-wait">{live ? 'The page appears here as soon as it opens.' : 'No picture of this page was kept.'}</p>}
        </div>
      )}
      {done ? <p className="br-ended" role="status">The page is closed. This is the last thing it showed.</p>
        : live && stalled ? <p className="br-ended" role="status">The newest picture didn’t load. Showing the one before it.</p> : null}
    </div>
  );
}

function GlobeGlyph(): JSX.Element {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.2" /><path d="M2.8 10h14.4M10 2.8c2.2 2.3 2.2 12.1 0 14.4M10 2.8c-2.2 2.3-2.2 12.1 0 14.4" /></svg>;
}

/**
 * The Canvas overflow on the Page tab: Stop agents' browsing for an hour or
 * until the owner says, show the own browser's window, the full page view.
 */
export function BrowserMenu({ status, timezone, reload }: { status: BrowserStatus | undefined; timezone?: string; reload: () => void }): JSX.Element {
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutes = status?.settings?.stopExpiryMinutes ?? 60;
  const back = fmtClock(new Date(Date.now() + (minutes || 60) * 60_000), zone);
  const run = (action: () => Promise<unknown>) => void action().catch(() => undefined).finally(reload);
  return (
    <ActionMenu label="More for this page" items={[
      { heading: 'Stop agents’ browsing' },
      { label: 'For an hour', hint: `Every agent, every conversation; back on at ${back}`, onSelect: () => run(() => api.browserControl('stop')) },
      { label: 'Until I say', hint: 'Until you press Resume', onSelect: () => run(() => api.browserControl('stop', undefined, { forever: true })) },
      'separator',
      status?.settings && !status.settings.showWindow ? { label: 'Show the window', hint: 'A window on this machine, for sites that refuse a hidden browser', onSelect: () => run(() => api.browserSettings({ showWindow: true })) } : null,
      { label: 'Open the full page view', hint: 'Every page agents have open', onSelect: () => { window.location.hash = '#/browser'; } },
    ]} />
  );
}
