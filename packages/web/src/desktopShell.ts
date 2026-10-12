/**
 * buddi's desktop app (apps/desktop, Linux and Windows): the dashboard in a
 * window of its own. Its initialization script, which runs only on the
 * dashboard's own origin inside the app, sets `window.__BUDDI_DESKTOP__`; a
 * browser has none. buddi.app on a Mac is `standalone` (KeepClose.tsx).
 */
export interface DesktopShell {
  os: string;
  /** The owner confirmed "Remove buddi": the app stops reconnecting and says when buddi is gone. */
  removing: () => void;
}

export function desktopShell(): DesktopShell | undefined {
  if (typeof window === 'undefined') return undefined;
  const shell = (window as unknown as { __BUDDI_DESKTOP__?: DesktopShell }).__BUDDI_DESKTOP__;
  return shell && typeof shell.removing === 'function' ? shell : undefined;
}
