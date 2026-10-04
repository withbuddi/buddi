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
 * with no remote hand still shows Give it back. **After a reload the hand
 * reattaches by itself** on a desktop: the server says the page is the
 * owner's, so the tab asks for the hand again instead of showing a picture
 * that no longer takes clicks.
 *
 * The picture sits in a small browser window (Amen, 2026-10-03: "like a real
 * window"; the kit has no window treatment, so this one is drawn here): back,
 * forward, reload and the address on a bar above the page. While the agent
 * drives the bar is there but asleep and the address copies on a click; while
 * the owner holds the page the buttons work and a typed address goes, through
 * the same address check every agent navigation passes. Enlarge opens the same
 * window over the whole dashboard, header and all; Esc closes it.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, csrfToken, type BrowserStatus, type LoginSeen } from '../../api';
import { fmtClock } from '../../format';
import { ActionMenu, Button, Icon, Notice, Toolbar } from '../../ui';
import { RemoteHand, type HandNav, type RemoteHandHandle } from '../../views/RemoteHand';
import { useMediaQuery } from '../../useMediaQuery';
import { appWord, lookingLine, siteOfUrl } from '../../views/Browser';
import { useThisMachine } from '../../useThisMachine';
import { SaveLoginCard } from './SaveLoginCard';

/** How often the last observation is re-requested while a page is open. */
export const BROWSER_POLL_MS = 2000;

/**
 * How many pictures may fail to arrive before the asking stops. A route that
 * has refused five times in a row is not about to answer the sixth, and the
 * tab still has the last frame that did arrive.
 */
export const MAX_SCREENSHOT_FAILURES = 5;

/**
 * A device whose keyboard has to be asked for: no hover, a finger for a
 * pointer. Width is not the test — a narrow desktop window still has keys.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/** The Canvas overflow's "full page view" asks the Page tab to enlarge with this. */
export const BROWSER_ENLARGE_EVENT = 'buddi:browser-enlarge';

/** How long a window button's load shows as in progress when no frame says it landed. */
const NAV_SPIN_MS = 8_000;
/** The scheme a bare host gets. */
const WEB = 'https:';

/**
 * What the owner typed into the address field, as an address to go to — or
 * null for something that is not a web address. A bare host gets https; the
 * driver still checks the result the way it checks an agent's.
 */
export function addressFrom(typed: string): string | null {
  const text = typed.trim();
  if (text === '' || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:]+:\d+(\/|$)/.test(text) ? text : `${WEB}//${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

/** The address as the field draws it: host strong, the rest quiet. */
function addressParts(url: string | undefined): { host: string; rest: string; secure: boolean } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: url, rest: '', secure: false };
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host.replace(/^www\./, ''), rest, secure: parsed.protocol === 'https:' };
  } catch { return { host: url, rest: '', secure: false }; }
}

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
  const touch = useMediaQuery(TOUCH_QUERY);
  const handRef = useRef<RemoteHandHandle | null>(null);
  /** A sign-in the owner just made on the page they hold, waiting for their word. */
  const [login, setLogin] = useState<LoginSeen | null>(null);
  /** The page asked for its hand already, so a reload asks once and never loops. */
  const asked = useRef<string | null>(null);
  const session = shown?.session;
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setFailure(null);
    try { await action(); } catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); reload(); }
  };
  const takeOver = () => void act(async () => {
    setNote(null); setOffline(false);
    const wanted = session?.id;
    if (wanted) asked.current = wanted;
    const next = await api.browserControl('takeover', wanted);
    // The answer is the page asked about; with several open, never another one.
    // A page in your Chrome came to the front there: no hand, no frames, nothing to wait for.
    if (next.held?.where === 'chrome') return;
    if (next.hand && next.session && (!wanted || next.session.id === wanted)) setDriving(next.session.id);
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
  /** The owner holds a page in their own Chrome: it is in front there, so no hand is asked for and no frame waited on. */
  const inChrome = owned && status?.held?.where === 'chrome';
  const hand = owned && !inChrome && driving && status?.session?.id === driving ? driving : null;
  /*
   * Reattach after a reload. The hand is this tab's socket, and a reload loses
   * it while the server still says the page is the owner's: the picture shows
   * and nothing reaches it. On a desktop the tab asks for the hand again by
   * itself, once per page; a phone keeps "Drive it here", where taking the
   * hand from a desk across the room is not what a glance at the page means.
   * An app window has no hand to ask for.
   */
  const ownedId = owned ? status?.session?.id ?? null : null;
  useEffect(() => {
    if (!ownedId || driving === ownedId || touch || busy || status?.route === 'apps' || inChrome) return;
    if (asked.current === ownedId) return;
    takeOver();
  }, [ownedId, driving, touch]);
  useEffect(() => { if (!owned) asked.current = null; }, [owned]);

  /* ---- the window ---- */
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    const open = (): void => setEnlarged(true);
    window.addEventListener(BROWSER_ENLARGE_EVENT, open);
    return () => window.removeEventListener(BROWSER_ENLARGE_EVENT, open);
  }, []);
  useEffect(() => {
    if (!enlarged) return undefined;
    // Esc closes, unless something inside took it first: the page being driven, the address field.
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) setEnlarged(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enlarged]);
  /** Where the held page is now, as its frames say; the last observation until one does. */
  const [location, setLocation] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  useEffect(() => { setLocation(null); setNavigating(false); }, [hand]);
  useEffect(() => {
    if (!navigating) return undefined;
    const timer = window.setTimeout(() => setNavigating(false), NAV_SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [navigating]);
  const onLocation = (url: string): void => { setLocation(url); setNavigating(false); };
  const nav = (action: HandNav, url?: string): void => {
    setFailure(null);
    if (handRef.current?.nav(action, url)) setNavigating(true);
  };

  /* ---- what the header says ---- */
  const taking = owned;
  const waiting = live && !!shown?.needsOwner;
  const done = !live && !paused;
  const site = siteOfUrl(shown?.page?.url) ?? (shown?.page?.appId ? appWord(shown.page.appId) : 'the page');
  const where = shown?.route === 'chrome' ? 'in your Chrome · background tab' : shown?.route === 'apps' ? `in ${site}` : 'in buddi’s browser';
  const title = paused ? 'Browsing is paused' : shown?.page?.title || site;
  const line = paused ? `By you at ${fmtClock(new Date(paused.at), zone)} · ${paused.until ? `until ${fmtClock(new Date(paused.until), zone)}` : 'until you resume it'}`
    : inChrome ? 'You have the page · in your Chrome · it’s in front'
    : taking ? `You have the page · ${where}`
    : done ? `${agentName} looked at ${site} · done${closedAt ? ` at ${fmtClock(new Date(closedAt), zone)}` : ''}`
    : shown ? lookingLine(shown) : 'Opening the page…';
  const src = live ? (shown ? screenshotUrl(shown, tick) : null) : frame;
  const app = shown?.route === 'apps';
  const address = hand ? location ?? shown?.page?.url : shown?.page?.url;
  const loading = live && (navigating || (!taking && !!status?.busy));
  const enlarge = shown || live ? (
    <button type="button" className="ui-icon-btn br-enlarge" data-size="sm"
      aria-label={enlarged ? 'Back to the side' : 'Enlarge the page'} title={enlarged ? 'Back to the side (Esc)' : 'Enlarge the page'}
      onClick={() => setEnlarged(!enlarged)}>
      <Icon name={enlarged ? 'collapse' : 'expand'} />
    </button>
  ) : null;

  return (
    <div className="br-canvas" data-testid="browser-view" data-live={live ? 'true' : 'false'} data-enlarged={enlarged ? 'true' : undefined}
      {...(enlarged ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'The page, full size' } : {})}>
      <header className="br-head">
        <span className="br-tile" aria-hidden="true">{paused ? <GlobeGlyph /> : tileLetter(shown)}</span>
        <span className="br-head-text">
          <span className="br-head-title">{title}</span>
          <span className="br-head-line" role="status">{live && !waiting && !taking && !paused ? <span className="br-live" aria-hidden="true" /> : null}{line}</span>
        </span>
        {taking ? (
          <Toolbar align="end">
            {inChrome ? null : hand ? (touch ? <Button size="sm" variant={typing ? 'accent' : 'ghost'} aria-pressed={typing} onClick={() => setTyping(!typing)}>Type into the page</Button> : null)
              : <Button size="sm" variant="ghost" disabled={busy} onClick={takeOver}>Drive it here</Button>}
            <Button size="sm" variant="accent" disabled={busy} onClick={giveBack}>Give it back</Button>
            {enlarge}
          </Toolbar>
        ) : paused ? (
          <Button size="sm" variant="accent" disabled={busy} onClick={() => void act(async () => { await api.browserControl('resume'); })}>Resume</Button>
        ) : done || !session ? (enlarge ? <Toolbar align="end">{enlarge}</Toolbar> : null) : (
          <Toolbar align="end">
            <Button size="sm" disabled={busy || !shown?.enabled} onClick={stopPage}>Stop</Button>
            <Button size="sm" variant={waiting ? 'accent' : undefined} disabled={busy || !shown?.enabled || shown?.state === 'paused'} onClick={takeOver}>Take over</Button>
            {enlarge}
          </Toolbar>
        )}
      </header>
      {taking ? <p className="br-hand-said" role="status">{inChrome ? 'Finish in Chrome, then give it back.' : hand ? `Nothing you type here is kept. ${agentName} carries on when you give it back.${touch ? ' Tap Type into the page to bring up your keyboard.' : ''}` : `${agentName} waits. It carries on when you give the page back.`}</p> : null}
      {failure || error ? <Notice tone="critical" role="alert">{failure ?? error}</Notice> : null}
      {note ? <Notice tone="warning" role="status">{note}</Notice> : null}
      {offline ? (
        <Notice tone="warning" role="status" title="Your Chrome isn’t connected."
          action={<Toolbar align="end"><Button size="sm" disabled={busy} onClick={ownBrowser}>Use buddi’s browser</Button><Button size="sm" variant="accent" disabled={busy} onClick={takeOver}>Try again</Button></Toolbar>}>
          {`Open Chrome on ${machine} and try again, or let this conversation use buddi’s own browser.`}
        </Notice>
      ) : null}
      {login ? <SaveLoginCard login={login} onDone={() => setLogin(null)} /> : null}
      {paused ? (
        <div className="br-frame br-frame-empty"><p className="ui-empty">{`No page is open. Agents look again when you resume${paused.until ? `, or by themselves at ${fmtClock(new Date(paused.until), zone)}` : ''}.`}</p></div>
      ) : (
        <div className="br-window" data-state={hand ? 'yours' : waiting ? 'waiting' : done ? 'done' : 'live'}>
          <WindowBar
            app={app ? site : null}
            title={shown?.page?.title || undefined}
            address={address}
            held={!!hand}
            loading={loading}
            onNav={nav}
            onRefused={(message) => setFailure(message)}
          />
          {hand ? (
            <div className="br-frame" data-state="yours">
              <RemoteHand ref={handRef} sessionId={hand} csrf={csrfToken()} onGiveBack={giveBack} bare typing={typing} onTyping={setTyping} onLocation={onLocation} onLoginSeen={setLogin} />
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
        </div>
      )}
      {done ? <p className="br-ended" role="status">The page is closed. This is the last thing it showed.</p>
        : live && stalled ? <p className="br-ended" role="status">The newest picture didn’t load. Showing the one before it.</p> : null}
    </div>
  );
}

/**
 * The window's bar: back, forward, reload, the address, the title.
 *
 * Asleep while the agent drives (the buttons are drawn, disabled, so the frame
 * reads as a browser rather than a screenshot) and the address copies on a
 * click. Awake while the owner holds the page: the buttons go down the hand,
 * and the address is a field — Enter goes there, Esc puts it back.
 */
function WindowBar({ app, title, address, held, loading, onNav, onRefused }: {
  app: string | null;
  title?: string;
  address?: string;
  held: boolean;
  loading: boolean;
  onNav: (action: HandNav, url?: string) => void;
  onRefused: (message: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setDraft(null); }, [address, held]);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const parts = addressParts(address);
  const copy = (): void => {
    if (!address) return;
    void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined);
  };
  const go = (event: FormEvent): void => {
    event.preventDefault();
    if (draft === null) return;
    const url = addressFrom(draft);
    if (!url) { onRefused('That isn’t a web address. Type one like amazon.com/orders.'); return; }
    setDraft(null);
    onNav('navigate', url);
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const escape = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setDraft(null);
    event.currentTarget.blur();
  };
  return (
    <div className="br-window-bar" role="toolbar" aria-label="Page controls">
      {app ? <span className="br-window-app">{app}</span> : (
        <>
          <span className="br-window-nav">
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label="Back" title="Back" disabled={!held} onClick={() => onNav('back')}><Icon name="back" /></button>
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label="Forward" title="Forward" disabled={!held} onClick={() => onNav('forward')}><Icon name="forward" /></button>
            <button type="button" className="ui-icon-btn" data-size="sm" aria-label="Reload" title="Reload" disabled={!held} onClick={() => onNav('reload')}><Icon name="reload" /></button>
          </span>
          {held ? (
            <form className="br-address" data-editable="true" onSubmit={go}>
              <AddressMark secure={parts?.secure ?? false} />
              <input
                className="br-address-input"
                aria-label="Address"
                value={draft ?? address ?? ''}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={escape}
              />
              <button type="button" className="br-address-copy" aria-label={copied ? 'Copied' : 'Copy the address'} title={copied ? 'Copied' : 'Copy the address'} disabled={!address} onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
            </form>
          ) : (
            <button type="button" className="br-address" aria-label={copied ? 'Address copied' : 'Copy the address'} title={copied ? 'Copied' : 'Copy the address'} disabled={!address} onClick={copy}>
              <AddressMark secure={parts?.secure ?? false} />
              <span className="br-address-text">{parts ? <><span className="br-address-host">{parts.host}</span><span className="br-address-rest">{parts.rest}</span></> : <span className="br-address-rest">No address yet</span>}</span>
              {copied ? <span className="br-address-said" aria-hidden="true">Copied</span> : null}
            </button>
          )}
        </>
      )}
      {title ? <span className="br-window-title" title={title}>{title}</span> : null}
      {loading ? <span className="br-window-progress" role="progressbar" aria-label="Loading" /> : null}
    </div>
  );
}

function AddressMark({ secure }: { secure: boolean }): JSX.Element {
  return <span className="br-address-mark" aria-hidden="true"><Icon name={secure ? 'lock' : 'globe'} size={12} /></span>;
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
      { label: 'Open the full page view', hint: 'This page over the whole window; Esc comes back', onSelect: () => { window.dispatchEvent(new Event(BROWSER_ENLARGE_EVENT)); } },
    ]} />
  );
}
