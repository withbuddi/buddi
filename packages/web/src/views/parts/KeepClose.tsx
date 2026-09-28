/**
 * "Keep buddi one click away": the line on Home that offers the dashboard as
 * an app.
 *
 * When the browser has offered an install (`beforeinstallprompt`, Chrome and
 * Edge), **Install app** hands it that prompt. Otherwise one sentence says
 * where the browser keeps the item. The bookmark shortcut is always there, and
 * on the Mac buddi runs on, the double-clickable app `buddi dashboard
 * --install-app` writes. Shown until dismissed; never inside the installed app.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Button, Notice, Toolbar } from '../../ui';

/** Set once the owner dismissed the line or installed the app. */
export const KEEP_CLOSE_KEY = 'buddi.keepClose';

/** The part of Chrome's `BeforeInstallPromptEvent` used here. */
interface InstallPrompt extends Event {
  prompt: () => Promise<unknown>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/*
 * The event can fire before Home mounts, so it is caught when this module
 * loads and kept for whoever renders the line.
 */
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
function announce(): void {
  for (const listener of listeners) listener();
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    announce();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    remember();
    announce();
  });
}

/** For tests: forget a caught prompt. */
export function resetInstallPrompt(): void {
  deferred = null;
  announce();
}

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(KEEP_CLOSE_KEY) !== null;
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(KEEP_CLOSE_KEY, 'dismissed');
  } catch {
    /* A private window: the line comes back next visit, which is harmless. */
  }
}

function standalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch {
    return false;
  }
}

export function onLoopback(hostname: string = window.location.hostname): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Where this browser keeps "install", in one sentence; null when it has none. */
export function installHint(userAgent: string): string | null {
  if (/Edg\//.test(userAgent)) return 'In Edge, choose Apps → Install buddi from the … menu.';
  if (/(Chrome|CriOS)\//.test(userAgent)) return 'In Chrome, click the install icon in the address bar.';
  if (/Safari\//.test(userAgent) && /Mac/.test(userAgent)) return 'In Safari, choose File → Add to Dock.';
  return null;
}

function isMac(userAgent: string): boolean {
  return /Mac|iPhone|iPad/.test(userAgent);
}

export function KeepClose(): JSX.Element | null {
  const [hidden, setHidden] = useState(() => dismissed() || standalone());
  const [prompt, setPrompt] = useState<InstallPrompt | null>(deferred);
  const [platform, setPlatform] = useState<string | undefined>(undefined);

  useEffect(() => {
    const listener = (): void => {
      setPrompt(deferred);
      if (dismissed()) setHidden(true);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    api.session().then((s) => { if (live) setPlatform(s.platform); }, () => undefined);
    return () => { live = false; };
  }, [hidden]);

  if (hidden) return null;

  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const local = onLoopback();
  const hint = prompt ? null : installHint(agent);

  const dismiss = (): void => {
    remember();
    setHidden(true);
  };

  const install = (): void => {
    const event = prompt;
    if (!event) return;
    void event.prompt().then(async () => {
      const choice = await event.userChoice;
      deferred = null;
      setPrompt(null);
      if (choice?.outcome === 'accepted') dismiss();
    }, () => undefined);
  };

  return (
    <Notice tone="accent" title="Keep buddi one click away.">
      <p>
        {hint ? `${hint} ` : null}
        Or bookmark it with {isMac(agent) ? '⌘D' : 'Ctrl+D'}.
        {!local ? ' This tailnet address installs as its own app, separate from the one on the machine buddi runs on.' : null}
      </p>
      {local && platform === 'darwin' ? (
        <p>
          {/* The page names no outside host (bundle.test.ts), so the pointer is the doc's name: docs/cli.md, Everyday. */}
          On this Mac, <span className="mono">buddi dashboard --install-app</span> puts a double-clickable app in
          ~/Applications (docs/cli.md, under Everyday).
        </p>
      ) : null}
      <Toolbar align="end">
        <Button variant="ghost" onClick={dismiss}>Not now</Button>
        {prompt ? <Button variant="accent" onClick={install}>Install app</Button> : null}
      </Toolbar>
    </Notice>
  );
}
