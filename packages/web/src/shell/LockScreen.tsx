/**
 * The lock screen (docs/dashboard.md, "Lock screen"; the kit's
 * `LockScreen.jsx`). A privacy screen over a signed-in dashboard, drawn like
 * an OS lock screen, and the only thing in the page while it shows.
 *
 * What it draws comes from `GET /api/lock/screen`, the one data call a locked
 * session may make: the time in the owner's zone, the widgets that are not
 * sensitive (compact, at most four), how many approvals and notifications are
 * waiting — counts, never what they are — and the focus that is on.
 *
 * On a desk the PIN field is focused and typing goes straight into it. On a
 * phone the glance comes first and "Enter PIN" opens a pad, so the keyboard
 * never jumps the layout. A wrong PIN says how many tries are left; after
 * five the server makes it wait, and the field counts down.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, isUnreachable, type LockScreenData, type LockState } from '../api';
import { useMediaQuery } from '../useMediaQuery';
import { WidgetBodyView } from '../views/parts/HomeWidgets';
import { Button, Icon, Mark, Modal } from '../ui';
import { FOCUS_LABELS, focusUntilLabel } from './Rail';

/** A phone: the glance first, then the pad. */
export const LOCK_PHONE_QUERY = '(max-width: 720px)';
/** How often the lock screen asks again: the time, the counts, an unlock elsewhere. */
export const LOCK_SCREEN_POLL_MS = 30_000;

const DELAY_WORDS: Record<number, string> = { 1: 'a minute', 5: '5 minutes', 15: '15 minutes', 60: 'an hour' };

function clock(date: Date, timezone: string): { time: string; day: string } {
  return {
    time: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(date),
    // "Thursday, 1 October", whatever this ICU's taste in commas.
    day: `${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(date)}, ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' }).format(date)}`,
  };
}

/** The honesty line: who locked it, and when. */
export function lockedLine(state: Pick<LockState, 'lockedAt' | 'reason' | 'delayMinutes'>, timezone: string, now: Date = new Date()): string {
  if (!state.lockedAt) return 'Locked';
  const at = new Date(state.lockedAt);
  const sameDay = clock(at, timezone).day === clock(now, timezone).day;
  const when = sameDay
    ? clock(at, timezone).time
    : new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at);
  if (state.reason === 'idle') return `Locked after ${state.delayMinutes ? DELAY_WORDS[state.delayMinutes] ?? `${state.delayMinutes} minutes` : 'a while'} away, at ${when}`;
  if (state.reason === 'start') return `Locked since this session began, at ${when}`;
  return `Locked by you at ${when}`;
}

/** The minute, re-read on the minute. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => { setNow(new Date()); arm(); }, 60_000 - (Date.now() % 60_000) + 50);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** Seconds until `iso`, ticking; 0 once it has passed. */
function useSecondsUntil(iso: string | null): number {
  const left = (): number => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000)) : 0);
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (!iso) return undefined;
    const timer = window.setInterval(() => setSeconds(left()), 500);
    return () => window.clearInterval(timer);
  }, [iso]);
  return seconds;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function LockGlyph({ size = 16 }: { size?: number }): JSX.Element {
  return <Icon name="lock" size={size} />;
}

function GoGlyph({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h9.6M8.6 4l4 4-4 4" />
    </svg>
  );
}

function BackGlyph(): JSX.Element {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.6 5h8a1.4 1.4 0 0 1 1.4 1.4v7.2A1.4 1.4 0 0 1 15.6 15h-8L3 10z" />
      <path d="M9.6 8l4 4M13.6 8l-4 4" />
    </svg>
  );
}

function CopyCommand({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <div className="so-cmd">
      <code className="so-cmd-text">{text}</code>
      <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

/** "Forgot PIN?": the honest way back in, from the computer buddi runs on. */
function Forgot({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal title="Forgot your PIN?" onClose={onClose} foot={<Button variant="accent" onClick={onClose}>Done</Button>}>
      <div className="lk-forgot">
        <p className="lk-forgot-text">The PIN covers this dashboard; it doesn’t sign you in. On the computer buddi runs on, run one of these:</p>
        <div className="lk-forgot-way">
          <CopyCommand text="buddi dashboard --unlock" />
          <p className="lk-forgot-hint">Opens buddi without the PIN, once. It prints a link for your other devices too, good for five minutes.</p>
        </div>
        <div className="lk-forgot-way">
          <CopyCommand text="buddi dashboard --remove-pin" />
          <p className="lk-forgot-hint">Removes the PIN on every device. Set a new one in Settings → Lock screen.</p>
        </div>
      </div>
    </Modal>
  );
}

function Badges({ approvals, unread }: { approvals: number; unread: number }): JSX.Element | null {
  const items: Array<{ key: string; n: number; text: string }> = [];
  if (approvals > 0) items.push({ key: 'approvals', n: approvals, text: approvals === 1 ? 'approval waiting' : 'approvals waiting' });
  if (unread > 0) items.push({ key: 'unread', n: unread, text: unread === 1 ? 'notification' : 'notifications' });
  if (items.length === 0) return null;
  return (
    <ul className="lk-badges" aria-label="Waiting for you">
      {items.map((b) => (
        <li key={b.key} className="lk-chip" data-kind={b.key}>
          <span className="ui-badge" aria-hidden="true">{b.n > 99 ? '99+' : b.n}</span>
          <span><span className="lk-sr">{b.n} </span>{b.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Widgets({ widgets, phone }: { widgets: LockScreenData['widgets']; phone: boolean }): JSX.Element | null {
  if (widgets.length === 0) return null;
  // How many columns the widgets fill: a medium one takes two on a desk.
  const cols = Math.min(phone ? 2 : 4, widgets.reduce((n, w) => n + (!phone && w.size === 'medium' ? 2 : 1), 0));
  return (
    <div className="lk-widgets">
      <div className="lk-grid" data-phone={phone ? 'true' : undefined} data-cols={cols}>
        {widgets.map((w) => {
          const size = phone ? 'small' : w.size;
          return (
            <div key={w.id} className="wg-frame" data-variant="compact" data-size={size} role="group" aria-label={w.title}>
              <div className="wg-body"><WidgetBodyView body={w.view.body} size={size} /></div>
              <span className="wg-compact-title">{w.title}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Pad({ value, disabled, onDigit, onBack, onSubmit }: { value: string; disabled: boolean; onDigit: (d: string) => void; onBack: () => void; onSubmit: () => void }): JSX.Element {
  return (
    <div className="lk-pad" role="group" aria-label="PIN pad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
        <button key={k} type="button" className="lk-key" disabled={disabled} onClick={() => onDigit(k)}>{k}</button>
      ))}
      <button type="button" className="lk-key" data-kind="quiet" aria-label="Delete" disabled={disabled || value.length === 0} onClick={onBack}><BackGlyph /></button>
      <button type="button" className="lk-key" disabled={disabled} onClick={() => onDigit('0')}>0</button>
      <button type="button" className="lk-key" data-kind="go" aria-label="Unlock" disabled={disabled || value.length < 4} onClick={onSubmit}><GoGlyph size={18} /></button>
    </div>
  );
}

export function LockScreen({ initial, onUnlocked }: { initial: LockState | null; onUnlocked: (state: LockState) => void }): JSX.Element {
  const phone = useMediaQuery(LOCK_PHONE_QUERY);
  const now = useMinute();
  const [data, setData] = useState<LockScreenData | null>(null);
  const state: LockState | null = data ?? initial;
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<string | null>(initial?.waitUntil ?? null);
  const [busy, setBusy] = useState(false);
  const [down, setDown] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [pad, setPad] = useState(false);
  const [opening, setOpening] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const waitLeft = useSecondsUntil(waitUntil);
  const waiting = waitLeft > 0;
  const done = useRef(onUnlocked);
  done.current = onUnlocked;

  const load = useCallback(() => {
    api.lockScreen().then((next) => {
      setDown(false);
      setData(next);
      setWaitUntil(next.waitUntil);
      if (!next.locked) done.current(next);
    }).catch((err: unknown) => {
      // Signed out underneath the lock: the gateway's own page says what to do.
      if (err instanceof ApiError && err.status === 401) window.location.reload();
      else if (isUnreachable(err)) setDown(true);
    });
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, LOCK_SCREEN_POLL_MS);
    const onVisible = (): void => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  // The field holds focus on a desk: typing is unlocking.
  useEffect(() => {
    if (!phone && !forgot && !waiting) field.current?.focus();
  }, [phone, forgot, waiting, busy]);
  useEffect(() => {
    if (!waiting && waitUntil) setWrong(null);
  }, [waiting, waitUntil]);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (busy || waiting || pin.length < 4) return;
    setBusy(true);
    api.unlock(pin).then((next) => {
      setPin('');
      if (next.locked) { setBusy(false); return; }
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (still) { done.current(next); return; }
      setOpening(true);
      window.setTimeout(() => done.current(next), 240);
    }).catch((err: unknown) => {
      setBusy(false);
      setPin('');
      if (!(err instanceof ApiError)) return setWrong('Something went wrong. Try again.');
      const detail = (err.detail ?? {}) as { triesLeft?: number; waitUntil?: string | null };
      if (err.status === 403 || err.status === 429) {
        if (detail.waitUntil) setWaitUntil(detail.waitUntil);
        const left = detail.triesLeft ?? 0;
        setWrong(detail.waitUntil ? 'That PIN isn’t right.' : `That PIN isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      } else if (isUnreachable(err)) {
        setWrong('buddi isn’t answering. Try again in a moment.');
      } else {
        setWrong(err.message);
      }
    });
  };

  const timezone = data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { time, day } = clock(now, timezone);
  const background = state?.background === 'image' && !state.image ? 'field' : (state?.background ?? 'field');
  const owner = data?.owner ?? null;
  const note = down
    ? { tone: 'critical' as const, text: 'buddi isn’t answering. The lock stays until it does.' }
    : waiting
      ? { tone: 'critical' as const, text: `Too many tries. Try again in ${mmss(waitLeft)}.` }
      : wrong
        ? { tone: 'critical' as const, text: wrong }
        : { tone: undefined, text: state ? lockedLine(state, timezone, now) : 'Locked' };
  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 8);
  const who = (
    <div className="lk-who">
      <span className="lk-face" aria-hidden="true">{(owner ?? 'You').slice(0, 1).toUpperCase()}</span>
      {owner ? <span className="lk-owner">{owner}</span> : null}
    </div>
  );
  const focus = data?.focus ?? null;

  return (
    <div
      className="lk"
      data-bg={background}
      data-phone={phone ? 'true' : undefined}
      data-view={pad ? 'pad' : 'glance'}
      data-opening={opening ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="buddi is locked"
      data-testid="lock-screen"
    >
      {background === 'image' && state?.image ? (
        <div className="lk-ground" aria-hidden="true">
          <img className="lk-photo" src={state.image} alt="" />
          <div className="lk-scrim" />
        </div>
      ) : (
        <div className="ui-fieldbg lk-ground" aria-hidden="true" />
      )}
      <header className="lk-top">
        <span className="lk-brand"><Mark size="sm" /><span>buddi</span></span>
        <span className="lk-top-spacer" />
        {focus ? (
          <span className="lk-chip" data-kind="focus">
            <Icon name="moon" size={13} />
            <span>{phone ? capital(focusUntilLabel(focus, timezone, now)) : `${FOCUS_LABELS[focus.mode]} ${focusUntilLabel(focus, timezone, now)}`}</span>
          </span>
        ) : null}
      </header>

      <div className="lk-main">
        <p className="lk-date">{day}</p>
        <p className="lk-time">{time}</p>
        {pad || !data ? null : <Badges approvals={data.approvals} unread={data.unread} />}
        {pad || !data ? null : <Widgets widgets={data.widgets} phone={phone} />}
      </div>

      <footer className="lk-unlock">
        {phone && !pad ? (
          <>
            <button type="button" className="lk-chip lk-enter" onClick={() => setPad(true)}><LockGlyph size={14} /><span>Enter PIN</span></button>
            <p className="lk-note" data-tone={note.tone} role="status" aria-live="polite">{note.text}</p>
          </>
        ) : phone ? (
          <>
            {who}
            <div className="lk-dots" aria-hidden="true" data-state={wrong ? 'wrong' : undefined}>
              {pin.length === 0 ? <span className="lk-dots-empty">Enter your PIN</span> : Array.from(pin).map((_, i) => <span key={i} className="lk-dot" />)}
            </div>
            <span className="lk-sr" aria-live="polite">{pin.length === 1 ? '1 digit entered' : `${pin.length} digits entered`}</span>
            <p className="lk-note" data-tone={note.tone} role="status" aria-live="polite">{note.text}</p>
            <Pad
              value={pin}
              disabled={waiting || busy}
              onDigit={(d) => { setWrong(null); setPin(digits(pin + d)); }}
              onBack={() => setPin(pin.slice(0, -1))}
              onSubmit={() => submit()}
            />
            <div className="lk-pad-foot">
              <button type="button" className="lk-link" onClick={() => setForgot(true)}>Forgot PIN?</button>
              <button type="button" className="lk-link" onClick={() => { setPad(false); setPin(''); setWrong(null); }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            {who}
            <form className="lk-pin" data-state={wrong && !waiting ? 'wrong' : waiting ? 'wait' : undefined} onSubmit={submit}>
              <LockGlyph size={15} />
              <input
                ref={field}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                aria-label="PIN"
                aria-describedby="lk-note"
                placeholder={waiting ? 'Wait a moment' : 'Enter your PIN'}
                disabled={waiting}
                value={pin}
                onChange={(e) => { setWrong(null); setPin(digits(e.target.value)); }}
              />
              <button type="submit" className="lk-go" aria-label="Unlock" disabled={busy || waiting || pin.length < 4}><GoGlyph /></button>
            </form>
            <p className="lk-note" id="lk-note" data-tone={note.tone} role="status" aria-live="polite">{note.text}</p>
            <button type="button" className="lk-link" onClick={() => setForgot(true)}>Forgot PIN?</button>
          </>
        )}
      </footer>
      {forgot ? <Forgot onClose={() => setForgot(false)} /> : null}
    </div>
  );
}

function capital(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}
