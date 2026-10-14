/**
 * Open in app: an Office document opened in the owner's own app — Word,
 * Excel, Numbers, LibreOffice — on the computer buddi runs on, with each save
 * there coming back as his next version (docs/files.md, "Office documents").
 *
 * The same on the Canvas and in Files: a button beside Download, and a bar
 * while the file is open. A save refused because buddi wrote a newer version
 * meanwhile gets the bar every refused save gets — "This file changed since
 * you opened it", Show theirs / Keep mine. From another device the button is
 * there but off, and says why: the app would open on the other computer.
 */
import { CHANGED_SINCE } from '@buddi/core/text-files';
import { opensInApp } from '@buddi/core/office-files';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type OpenInAppState } from '../api';
import { Button, Notice } from '../ui';
import { useOnThisMachine, useThisMachine } from '../useThisMachine';

/** How often an open file is asked about. */
export const OPEN_POLL_MS = 2_000;

export { opensInApp };

export interface OpenInApp {
  /** This dashboard is on the machine buddi runs on. */
  local: boolean;
  state: OpenInAppState;
  busy: boolean;
  error: string | null;
  open: () => Promise<void>;
  resolve: (keep: 'mine' | 'theirs' | 'new') => Promise<void>;
}

/**
 * The file's Open in app state, asked while it is open. `onSaved` hears each
 * version a save in the app brought back, so the preview can draw it.
 */
export function useOpenInApp(fileId: string, onSaved?: (version: number) => void): OpenInApp {
  const local = useOnThisMachine();
  const [state, setState] = useState<OpenInAppState>({ open: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<number | undefined>(undefined);
  const heard = useRef(onSaved);
  heard.current = onSaved;

  const take = useCallback((next: OpenInAppState): void => {
    setState(next);
    if (next.savedVersion !== undefined && next.savedVersion !== saved.current) {
      saved.current = next.savedVersion;
      heard.current?.(next.savedVersion);
    }
  }, []);

  // Already open (another tab, a reload): picked up again.
  useEffect(() => {
    if (!local) return;
    let live = true;
    saved.current = undefined;
    api.openInAppState(fileId).then((s) => { if (live) { saved.current = s.savedVersion; setState(s); } }, () => undefined);
    return () => { live = false; };
  }, [fileId, local]);

  // While open, asked every few seconds: a save in the app arrives as a new version.
  useEffect(() => {
    if (!local || !state.open) return;
    const timer = setInterval(() => { api.openInAppState(fileId).then(take, () => undefined); }, OPEN_POLL_MS);
    return () => clearInterval(timer);
  }, [fileId, local, state.open, take]);

  const open = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      take(await api.openInApp(fileId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [fileId, take]);

  const resolve = useCallback(async (keep: 'mine' | 'theirs' | 'new'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.resolveOpenInApp(fileId, keep);
      take(next);
      if (keep === 'theirs' && state.current) heard.current?.(state.current.version);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [fileId, take, state.current]);

  return { local, state, busy, error, open, resolve };
}

/** The button, beside Download. Off from another device, with the reason as its title and beside it. */
export function OpenInAppButton({ app }: { app: OpenInApp }): JSX.Element {
  const machine = useThisMachine();
  const note = `Open in app works on ${machine === 'this Mac' ? 'the Mac' : 'the computer'} buddi runs on.`;
  return (
    <>
      {app.local ? null : <span className="muted">{note}</span>}
      <Button disabled={!app.local || app.busy} title={app.local ? 'Open it in this computer’s app for this kind of file' : note} onClick={() => { void app.open(); }}>
        {app.busy && !app.state.open ? 'Opening…' : 'Open in app'}
      </Button>
    </>
  );
}

/** While it is open: where saves go, a refused save's choice, his kept copy, or why it could not open. */
export function OpenInAppBar({ app }: { app: OpenInApp }): JSX.Element | null {
  const { state, error } = app;
  if (error) return <Notice tone="critical" role="alert">{error}</Notice>;
  if (state.closed && state.savedAs) return <Notice role="status">Your copy is saved in Files as {state.savedAs.filename ?? 'a new file'}.</Notice>;
  if (!state.open) return null;
  const saveAsNew = <Button size="sm" disabled={app.busy} onClick={() => { void app.resolve('new'); }}>Save mine as new file</Button>;
  if (state.state === 'deleted') {
    return (
      <Notice role="status" action={state.unsaved ? saveAsNew : undefined}>
        This file was deleted from Files; saves in the app no longer come back here.{state.unsaved ? ' Your copy in the app is kept.' : ''}
      </Notice>
    );
  }
  if (state.state === 'conflict' && state.conflict && state.current) {
    return (
      <Notice tone="warning" role="status" action={
        <span className="ui-toolbar">
          <Button size="sm" disabled={app.busy} onClick={() => { void app.resolve('theirs'); }}>Show theirs</Button>
          <Button size="sm" variant="accent" disabled={app.busy} onClick={() => { void app.resolve('mine'); }}>Keep mine</Button>
        </span>
      }>
        {CHANGED_SINCE}{state.conflict === 'workspace' ? ': a command changed its copy in buddi’s workspace.' : ` (v${state.current.version} is newer).`} Your save in the app is waiting: Keep mine saves it over, Show theirs keeps v{state.current.version}.
      </Notice>
    );
  }
  if (state.state === 'detached') {
    return (
      <Notice role="status" action={state.unsaved ? saveAsNew : undefined}>
        {state.unsaved ? 'You kept their version. Your copy in the app is kept, and no longer comes back here.' : 'You kept their version.'}
      </Notice>
    );
  }
  return (
    <Notice role="status">
      {state.launch === 'unconfirmed' ? 'Opening in your app… if nothing opens, open it again. ' : 'Open in your app. '}
      Each save there comes back here as a new version{state.savedVersion !== undefined ? `; your last is v${state.savedVersion}` : ''}.
    </Notice>
  );
}
