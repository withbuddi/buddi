/**
 * The lock screen (docs/dashboard.md, "Lock screen"; the kit's
 * `LockScreen.jsx`). A privacy screen over a signed-in dashboard, drawn like
 * an OS lock screen, and the only thing in the page while it shows.
 *
 * What it draws comes from `GET /api/lock/screen`, the one data call a locked
 * session may make: its own clock — the time and the date in the owner's
 * zone, their way unless picked for the lock screen, and a second zone if one
 * was — its own widgets (compact, at most four, never a sensitive one; a
 * sentence takes one column so an empty day never stretches into a hollow
 * card), how many approvals and notifications are waiting — counts, never
 * what they are; each a button that opens its list once unlocked — and the
 * focus while one is on. `LockFace` draws all but the unlock, and the lock
 * screen editor draws the same face as its preview.
 *
 * On a desk the PIN field is focused and typing goes straight into it. On a
 * phone the glance comes first and "Enter PIN" opens a pad, so the keyboard
 * never jumps the layout. A wrong PIN says how many tries are left; after
 * five the server makes it wait, and the field counts down.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, isUnreachable, type FocusState, type LockClockView, type LockScreenData, type LockState } from '../api';
import { useMediaQuery } from '../useMediaQuery';
import { useMinute } from './useMinute';
import { WidgetBodyView } from '../views/parts/WidgetBody';
import { CLOCK_WIDGET, useOnTheMinute } from '../views/parts/HomeWidgets';
import { Button, Icon, Mark, Modal } from '../ui';
import { FOCUS_LABELS, focusUntilLabel } from './Rail';
import { fmtClock, fmtDate, fmtMoment, underFormats } from '../format';
import { NEEDS_ROUTE, NOTIFICATIONS_RECENT_ROUTE } from '../routes';

/** A phone: the glance first, then the pad. */
export const LOCK_PHONE_QUERY = '(max-width: 720px)';
/** How often the lock screen asks again: the time, the counts, an unlock elsewhere. */
export const LOCK_SCREEN_POLL_MS = 30_000;

const DELAY_WORDS: Record<number, string> = { 1: 'a minute', 5: '5 minutes', 15: '15 minutes', 60: 'an hour' };

function clock(date: Date, timezone: string): { time: string; day: string } {
  return {
    time: fmtClock(date, timezone),
    // "Thursday, 1 October", whatever this ICU's taste in commas.
    day: fmtDate(date, timezone, { weekday: true }),
  };
}

/**
 * What `fn` draws in the lock screen's formats: the big clock's time format
 * (its own pick, else the Profile, else the browser's, as the gateway resolved
 * it) and its date style. Every time on the screen goes through here, so the
 * honesty line, the focus chip and the second clock never read another way —
 * the shell's formats are not even set on a page that opens locked. With no
 * view yet, the shell's formats as they are.
 */
export function inLockFormats<T>(view: LockClockView | undefined, fn: () => T): T {
  if (!view) return fn();
  return underFormats({ timeFormat: view.time, ...(view.date === 'off' ? {} : { dateFormat: view.date }) }, fn);
}

/** The honesty line: who locked it, and when — in the big clock's format. */
export function lockedLine(state: Pick<LockState, 'lockedAt' | 'reason' | 'delayMinutes'>, timezone: string, now: Date = new Date(), view?: LockClockView): string {
  return inLockFormats(view, () => lockedWords(state, timezone, now));
}

function lockedWords(state: Pick<LockState, 'lockedAt' | 'reason' | 'delayMinutes'>, timezone: string, now: Date): string {
  if (!state.lockedAt) return 'Locked';
  const at = new Date(state.lockedAt);
  const sameDay = clock(at, timezone).day === clock(now, timezone).day;
  const when = sameDay
    ? clock(at, timezone).time
    : fmtMoment(at, timezone);
  if (state.reason === 'idle') return `Locked after ${state.delayMinutes ? DELAY_WORDS[state.delayMinutes] ?? `${state.delayMinutes} minutes` : 'a while'} away, at ${when}`;
  if (state.reason === 'start') return `Locked since this session began, at ${when}`;
  return `Locked by you at ${when}`;
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

export type LockAfter = 'approvals' | 'unread';

/** Counts only: what is waiting, never what it is. Tapped, the dashboard opens on that list once unlocked. */
function Badges({ approvals, unread, after, onPick }: { approvals: number; unread: number; after?: LockAfter | null; onPick?: (next: LockAfter | null) => void }): JSX.Element | null {
  const items: Array<{ key: LockAfter; n: number; text: string }> = [];
  if (approvals > 0) items.push({ key: 'approvals', n: approvals, text: approvals === 1 ? 'approval waiting' : 'approvals waiting' });
  if (unread > 0) items.push({ key: 'unread', n: unread, text: unread === 1 ? 'notification' : 'notifications' });
  if (items.length === 0) return null;
  return (
    <ul className="lk-badges" aria-label="Waiting for you">
      {items.map((b) => (
        <li key={b.key}>
          <button
            type="button"
            className="lk-chip"
            data-kind={b.key}
            aria-pressed={after === b.key}
            disabled={!onPick}
            title={onPick ? (b.key === 'unread' ? 'Open your notifications once unlocked' : 'Open your approvals once unlocked') : undefined}
            onClick={() => onPick?.(after === b.key ? null : b.key)}
          >
            <span className="ui-badge" aria-hidden="true">{b.n > 99 ? '99+' : b.n}</span>
            <span><span className="lk-sr">{b.n} </span>{b.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * How many columns the lock grid needs: the widest row once the widgets flow
 * into rows of at most four (two on a phone), a medium taking two. The sum is
 * not it: medium, small, medium, small fills rows of three, and a grid of four
 * would leave an empty column on the right and pull the block off centre.
 */
export function lockColumns(sizes: ReadonlyArray<'small' | 'medium'>, phone: boolean): number {
  const max = phone ? 2 : 4;
  let widest = 0;
  let row = 0;
  for (const size of sizes) {
    const span = Math.min(size === 'medium' ? 2 : 1, max);
    if (row + span > max) row = 0;
    row += span;
    widest = Math.max(widest, row);
  }
  return widest;
}

function Widgets({ widgets, phone }: { widgets: LockScreenData['widgets']; phone: boolean }): JSX.Element | null {
  if (widgets.length === 0) return null;
  // A sentence (nothing today, nobody waiting) takes one column, so it never stretches into a hollow card.
  const sized = widgets.map((w) => ({ w, size: phone || w.view.body.kind === 'text' ? ('small' as const) : w.size }));
  const cols = lockColumns(sized.map(({ size }) => size), phone);
  return (
    <div className="lk-widgets">
      <div className="lk-grid" data-phone={phone ? 'true' : undefined} data-cols={cols}>
        {sized.map(({ w, size }) => (
          <div key={w.key ?? w.id} className="wg-frame" data-variant="compact" data-size={size} data-kind={w.view.body.kind} role="group" aria-label={w.title}>
            <div className="wg-body"><WidgetBodyView body={w.view.body} size={size} /></div>
            <span className="wg-compact-title">{w.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "2:32 PM" as the figure and a small "PM"; a 24-hour clock is all figure. */
function ClockFigure({ text }: { text: string }): JSX.Element {
  const match = /^(.*?)[\s\u202f]?([AaPp]\.?[Mm]\.?)$/.exec(text);
  return (
    <p className="lk-time" aria-label={text}>
      {match ? <>{match[1]}<span className="lk-ampm" aria-hidden="true">{match[2]}</span></> : text}
    </p>
  );
}

function zoneOffsetMinutes(at: Date, zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** "6 h behind", "5 h 30 ahead", "Same time", with ", tomorrow" or ", yesterday" when the day differs. */
export function zoneOffsetText(at: Date, zone: string, home: string): string {
  try {
    const diff = zoneOffsetMinutes(at, zone) - zoneOffsetMinutes(at, home);
    if (diff === 0) return 'Same time';
    const day = (z: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const other = day(zone) !== day(home) ? (diff > 0 ? ', tomorrow' : ', yesterday') : '';
    const h = Math.floor(Math.abs(diff) / 60);
    const m = Math.abs(diff) % 60;
    const span = m === 0 ? `${h} h` : h === 0 ? `${m} min` : `${h} h ${m}`;
    return `${span} ${diff > 0 ? 'ahead' : 'behind'}${other}`;
  } catch {
    return '';
  }
}

/** The clock's words: the time and the date the lock screen's way, and the second zone. */
export function lockClockText(now: Date, timezone: string, view: LockClockView | undefined): { time: string; day: string | null; zone: { label: string; time: string; offset: string } | null } {
  const v: LockClockView = view ?? { time: null, date: null, zone: null };
  return inLockFormats(view, () => ({
    time: fmtClock(now, timezone),
    // "Thursday, 1 October", whatever this ICU's taste in commas.
    day: v.date === 'off' ? null : fmtDate(now, timezone, { weekday: true }),
    zone: v.zone ? { label: v.zone.label, time: fmtClock(now, v.zone.timezone), offset: zoneOffsetText(now, v.zone.timezone, timezone) } : null,
  }));
}

/** What the face draws: the lock screen's data, or the editor's draft of it. */
export interface LockFaceData {
  timezone: string;
  background: LockState['background'];
  image: string | null;
  focus: FocusState | null;
  approvals: number;
  unread: number;
  widgets: LockScreenData['widgets'];
  clockView?: LockClockView;
}

/**
 * The face: the ground, the top line, the clock, the counts and the widgets.
 * The lock screen draws it over the unlock; the editor's preview draws it
 * alone, scaled.
 */
export function LockFace({ data, now, phone, pad = false, after, onPick }: { data: LockFaceData | null; now: Date; phone: boolean; pad?: boolean; after?: LockAfter | null; onPick?: (next: LockAfter | null) => void }): JSX.Element {
  const timezone = data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = lockClockText(now, timezone, data?.clockView);
  const background = data?.background === 'image' && !data.image ? 'field' : (data?.background ?? 'field');
  const focus = data?.focus ?? null;
  const focusText = focus ? inLockFormats(data?.clockView, () => (phone ? capital(focusUntilLabel(focus, timezone, now)) : `${FOCUS_LABELS[focus.mode]} ${focusUntilLabel(focus, timezone, now)}`)) : '';
  return (
    <>
      {background === 'image' && data?.image ? (
        <div className="lk-ground" aria-hidden="true">
          <img className="lk-photo" src={data.image} alt="" />
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
            <span>{focusText}</span>
          </span>
        ) : null}
      </header>

      <div className="lk-main">
        {clock.day ? <p className="lk-date">{clock.day}</p> : null}
        <ClockFigure text={clock.time} />
        {clock.zone ? (
          <p className="lk-zone">
            <span className="lk-zone-name">{clock.zone.label}</span>
            <span className="lk-zone-time">{clock.zone.time}</span>
            {clock.zone.offset ? <span className="lk-zone-off">{clock.zone.offset}</span> : null}
          </p>
        ) : null}
        {pad || !data ? null : <Badges approvals={data.approvals} unread={data.unread} after={after ?? null} {...(onPick ? { onPick } : {})} />}
        {pad || !data ? null : <Widgets widgets={data.widgets} phone={phone} />}
      </div>
    </>
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
  /** A count tapped: where the dashboard opens once the PIN is right. */
  const [after, setAfter] = useState<LockAfter | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const waitLeft = useSecondsUntil(waitUntil);
  const waiting = waitLeft > 0;
  const done = useRef(onUnlocked);
  const afterRef = useRef(after);
  afterRef.current = after;
  // Unlocked: open where a tapped count asked, then hand back.
  done.current = (next: LockState) => {
    if (afterRef.current) window.location.hash = afterRef.current === 'unread' ? NOTIFICATIONS_RECENT_ROUTE : NEEDS_ROUTE;
    onUnlocked(next);
  };
  const pick = (next: LockAfter | null): void => {
    setAfter(next);
    if (phone && next) setPad(true);
    else field.current?.focus();
  };

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

  // A World clock on the lock screen is asked again on the minute.
  useOnTheMinute(data?.widgets.some((w) => w.id === CLOCK_WIDGET && w.view.body.kind !== 'clocks') ?? false, load);

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
  const background = state?.background === 'image' && !state.image ? 'field' : (state?.background ?? 'field');
  const owner = data?.owner ?? null;
  const note = down
    ? { tone: 'critical' as const, text: 'buddi isn’t answering. The lock stays until it does.' }
    : waiting
      ? { tone: 'critical' as const, text: `Too many tries. Try again in ${mmss(waitLeft)}.` }
      : wrong
        ? { tone: 'critical' as const, text: wrong }
        : after
          ? { tone: undefined, text: after === 'unread' ? 'Unlock to open your notifications.' : 'Unlock to open your approvals.' }
          : { tone: undefined, text: state ? lockedLine(state, timezone, now, data?.clockView) : 'Locked' };
  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 8);
  const who = (
    <div className="lk-who">
      <span className="lk-face" aria-hidden="true">{(owner ?? 'You').slice(0, 1).toUpperCase()}</span>
      {owner ? <span className="lk-owner">{owner}</span> : null}
    </div>
  );

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
      <LockFace data={data ?? (state ? { ...emptyFace(state) } : null)} now={now} phone={phone} pad={pad} after={after} onPick={pick} />

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

/** The face before the first answer: the state's ground, nothing else yet. */
function emptyFace(state: LockState): LockFaceData {
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, background: state.background, image: state.image, focus: null, approvals: 0, unread: 0, widgets: [] };
}
