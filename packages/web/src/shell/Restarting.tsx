/**
 * "Restarting buddi": the whole window while buddi restarts under the page.
 *
 * Kit: ui_kits/dashboard/Restarting.jsx. Calm on purpose — the Blob working on
 * the quiet field, what the restart is for, a slim indeterminate line, and
 * after ten seconds how long it has taken. Never red: a restart is buddi doing
 * what it was asked. After the patience runs out (ninety seconds; five
 * minutes for an upgrade) it says it is still waiting, what to check on the
 * computer and offers Reload, and keeps asking all the same. The watching and
 * the reload are `restart.ts`'s; this draws it, and keeps the shell under it
 * inert so nothing behind it is reachable from the keyboard.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { linkDownSince, onLinkChange } from '../api';
import { Button } from '../ui';
import { Blob } from '../ui/Blob';
import { STREAM_RECONNECTED } from './freshness';
import {
  RESTART_PATIENCE_MS,
  checkForRestart,
  learnBoot,
  onRestartChange,
  restartDeps,
  restartState,
  type RestartState,
} from './restart';
import { LOOPBACK } from './Unreachable';

/** When the elapsed time joins the foot. */
export const SHOW_ELAPSED_MS = 10_000;

/** The restart being waited for, or null. */
export function useRestart(): RestartState | null {
  return useSyncExternalStore(onRestartChange, restartState, restartState);
}

/** The title and the line, by what the restart is for. */
export function restartWords(state: RestartState): { title: string; line: string } {
  switch (state.kind) {
    case 'plugins':
      return { title: 'Restarting buddi', line: state.line ?? 'Loading your plugins…' };
    case 'upgrade':
      return { title: 'Upgrading buddi', line: state.line ?? 'Upgrading…' };
    case 'restore':
      return { title: 'Restoring buddi', line: state.line ?? 'Putting your backup in place…' };
    case 'recovery':
      return { title: 'Restarting buddi', line: state.line ?? 'Turning schedules, watchers and the phone back on…' };
    case 'stop':
      return { title: 'buddi is stopped', line: 'This page comes back by itself once buddi is started again.' };
    default:
      return { title: 'Restarting buddi', line: state.line ?? 'Back in a few seconds…' };
  }
}

/** 0:12, 1:32. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Command({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="rs-cmd">
      <code className="rs-cmd-text">{command}</code>
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {});
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The screen itself, for a given restart and how long it has been going. */
export function RestartScreen({
  state,
  elapsedMs,
  hostname = window.location.hostname,
  onReload = () => restartDeps.reload(),
}: {
  state: RestartState;
  elapsedMs: number;
  hostname?: string;
  onReload?: () => void;
}): JSX.Element {
  const words = restartWords(state);
  const stopped = state.kind === 'stop';
  const long = !stopped && elapsedMs >= (state.patienceMs ?? RESTART_PATIENCE_MS);
  const here = LOOPBACK.test(hostname);
  const box = useRef<HTMLDivElement>(null);
  // The keyboard lands here, not on the page that is going away.
  useEffect(() => box.current?.focus(), []);
  const help = stopped
    ? here
      ? 'This starts it again, in Terminal on this computer:'
      : 'On the computer buddi runs on, this starts it again:'
    : here
      ? 'This says what it’s doing, in Terminal on this computer:'
      : 'On the computer buddi runs on, this says what it’s doing. Is that computer awake, and Tailscale on?';
  return (
    <div className="ui-fieldbg rs-field" data-quiet="true">
      <div
        ref={box}
        className="rs"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rs-title"
        tabIndex={-1}
        data-state={stopped ? 'stopped' : long ? 'long' : 'waiting'}
      >
        <div className="rs-body">
          <span className="ui-mascot rs-blob" data-size="lg" aria-hidden="true">
            <Blob role="core" state={stopped || long ? 'idle' : 'working'} className="ui-mascot-blob" />
          </span>
          <h1 id="rs-title" className="rs-title">{words.title}</h1>
          <p className="rs-line" role="status">{long ? 'Still waiting — buddi may need a hand.' : words.line}</p>
          {!long && state.step ? <p className="rs-step">{state.step}</p> : null}
          {stopped || long ? null : <div className="rs-track" aria-hidden="true"><span /></div>}
          {stopped || long ? (
            <div className="rs-help">
              <p className="rs-help-line">{help}</p>
              <Command command={stopped ? 'buddi service start' : 'buddi status'} />
            </div>
          ) : null}
          <div className="rs-foot">
            <span className="rs-meta">
              {stopped
                ? 'Checking every few seconds.'
                : long
                  ? `${clock(elapsedMs)} · still checking every few seconds`
                  : elapsedMs >= SHOW_ELAPSED_MS
                    ? `${clock(elapsedMs)} · this page reloads when buddi is back`
                    : 'This page reloads when buddi is back.'}
            </span>
            {stopped || long ? (
              <Button size="sm" variant={long ? 'accent' : undefined} onClick={onReload}>
                Reload
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Ticks once a second while a restart is up. */
function useElapsed(state: RestartState | null): number {
  const [now, setNow] = useState(() => restartDeps.now());
  useEffect(() => {
    if (!state) return undefined;
    setNow(restartDeps.now());
    const timer = window.setInterval(() => setNow(restartDeps.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state]);
  return state ? Math.max(0, now - state.startedAt) : 0;
}

/**
 * Around the whole app: learns which process served the page, notices a
 * restart it did not start once the link or the live stream comes back, and
 * while a restart is up draws the screen over an inert shell.
 */
export function RestartGate({ children }: { children: ReactNode }): JSX.Element {
  const state = useRestart();
  const elapsed = useElapsed(state);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void learnBoot();
    let wasDown = linkDownSince() !== null;
    const offLink = onLinkChange(() => {
      const down = linkDownSince() !== null;
      if (wasDown && !down) void checkForRestart();
      wasDown = down;
    });
    const onStream = (): void => void checkForRestart();
    window.addEventListener(STREAM_RECONNECTED, onStream);
    return () => {
      offLink();
      window.removeEventListener(STREAM_RECONNECTED, onStream);
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.toggleAttribute('inert', state !== null);
    if (state) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  }, [state]);

  return (
    <>
      <div ref={host} className="rs-host">{children}</div>
      {state ? <RestartScreen state={state} elapsedMs={elapsed} /> : null}
    </>
  );
}
