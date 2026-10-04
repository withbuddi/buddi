/**
 * Installing the dashboard as an app, in three places.
 *
 * - **Home**, at the foot: one quiet line, "Install buddi as an app, one click
 *   from your dock", with Install and Not now — only when the browser has
 *   actually offered an install (`beforeinstallprompt`, Chrome and Edge),
 *   until dismissed, and never inside the installed app.
 * - **The owner menu**: "Install the app", whenever the browser offers it and
 *   this is not already the installed app (`useInstallPrompt`).
 * - **Settings → System**: the rest (`AppInstallSection`) — where this
 *   browser keeps "install", the bookmark shortcut, the tailnet note and, on
 *   the Mac buddi runs on, the double-clickable app
 *   `buddi dashboard --install-app` writes.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Button, Section, Stack, Toolbar } from '../../ui';

/** Set once the owner dismissed the line or installed the app. */
export const KEEP_CLOSE_KEY = 'buddi.keepClose';

/** The part of Chrome's `BeforeInstallPromptEvent` used here. */
export interface InstallPrompt extends Event {
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

/**
 * The browser's install prompt, when it offered one, it has not been used,
 * and this is not already the installed app: first run's chapter 4, the owner
 * menu, Home's line and Settings hand it over from their buttons.
 */
export function useInstallPrompt(): InstallPrompt | null {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(deferred);
  useEffect(() => {
    const listener = (): void => setPrompt(deferred);
    listeners.add(listener);
    // It may have arrived between the first render and this effect.
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return standalone() ? null : prompt;
}

/**
 * Show the browser's install dialog. A prompt is good once, so it is
 * forgotten whatever the answer; accepted, Home's line is not offered again.
 */
export async function installApp(prompt: InstallPrompt): Promise<boolean> {
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (deferred === prompt) deferred = null;
    const accepted = choice?.outcome === 'accepted';
    if (accepted) remember();
    announce();
    return accepted;
  } catch {
    return false;
  }
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

/**
 * The page is running inside buddi.app's own window: its WKWebView names
 * itself `buddi-mac/<version>` in the user agent (MainWindowController).
 */
export function inBuddiApp(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bbuddi-mac\/\S+/.test(userAgent);
}

/** Where this browser keeps "install", in one sentence; null when it has none (or it is buddi.app already). */
export function installHint(userAgent: string): string | null {
  if (inBuddiApp(userAgent)) return null;
  if (/Edg\//.test(userAgent)) return 'In Edge, choose Apps → Install buddi from the … menu.';
  if (/(Chrome|CriOS)\//.test(userAgent)) return 'In Chrome, click the install icon in the address bar.';
  if (/Safari\//.test(userAgent) && /Mac/.test(userAgent)) return 'In Safari, choose File → Add to Dock.';
  return null;
}

function isMac(userAgent: string): boolean {
  return /Mac|iPhone|iPad/.test(userAgent);
}

/** Home's line: only when the browser offered an install, until Not now. */
export function KeepClose(): JSX.Element | null {
  const prompt = useInstallPrompt();
  const [hidden, setHidden] = useState(dismissed);
  if (hidden || !prompt) return null;

  const dismiss = (): void => {
    remember();
    setHidden(true);
  };

  return (
    <div className="home-install" role="region" aria-label="Install buddi">
      <p className="home-install-text">Install buddi as an app, one click from your dock.</p>
      <Toolbar align="end">
        <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
        <Button size="sm" variant="accent" onClick={() => { void installApp(prompt).then((accepted) => { if (accepted) setHidden(true); }); }}>Install</Button>
      </Toolbar>
    </div>
  );
}

/**
 * Settings → System: every way to keep the dashboard one click away. Not
 * shown inside the installed app, which is already that.
 */
export function AppInstallSection(): JSX.Element | null {
  const prompt = useInstallPrompt();
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  const [inApp] = useState(standalone);

  useEffect(() => {
    if (inApp) return undefined;
    let live = true;
    api.session().then((s) => { if (live) setPlatform(s.platform); }, () => undefined);
    return () => { live = false; };
  }, [inApp]);

  if (inApp) return null;

  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const local = onLoopback();
  const hint = prompt ? null : installHint(agent);

  return (
    <Section
      title="The dashboard as an app"
      panel
      foot={prompt ? (
        <Toolbar align="end">
          <Button variant="accent" onClick={() => { void installApp(prompt); }}>Install the app</Button>
        </Toolbar>
      ) : undefined}
    >
      <Stack>
        <p>
          {prompt ? 'This browser can install buddi as an app: its own window, the Blob as its icon. ' : hint ? `${hint} ` : null}
          Or bookmark it with {isMac(agent) ? '⌘D' : 'Ctrl+D'}.
          {!local ? ' This tailnet address installs as its own app, separate from the one on the machine buddi runs on.' : null}
        </p>
        {local && platform === 'darwin' ? (
          <p>
            {/* The page names no outside host (bundle.test.ts), so the pointer is the doc's name: docs/cli.md, Everyday. */}
            On this Mac, <span className="mono">buddi dashboard --install-app</span> puts a double-clickable app in
            ~/Applications that signs you in each time it opens (docs/cli.md, under Everyday).
          </p>
        ) : null}
      </Stack>
    </Section>
  );
}
