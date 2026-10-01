/**
 * The lock gate and the lock screen: nothing of the app is in the page while
 * locked, a 423 anywhere brings the lock screen up, the shortcut and Lock now
 * lock, the page locks itself after the delay with nobody using it, and the
 * screen says what is true — tries left, the wait, why it locked — and how to
 * get back in when the PIN is forgotten.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ApiError, LOCKED, api, type LockScreenData, type LockState } from '../api';
import { LockGate, isLockShortcut, lockShortcutLabel, useLock } from './lock';
import { LockScreen, lockClockText, lockColumns, lockedLine } from './LockScreen';
import { setDisplayFormats } from '../format';

const open: LockState = { pin: true, locked: false, lockedAt: null, reason: null, delayMinutes: 5, background: 'field', image: null, waitUntil: null, triesLeft: null };
const locked: LockState = { ...open, locked: true, lockedAt: '2026-10-01T12:02:00Z', reason: 'owner' };
const screenData = (over: Partial<LockScreenData> = {}): LockScreenData => ({
  ...locked,
  now: '2026-10-01T12:32:00Z',
  timezone: 'Europe/Paris',
  owner: 'Sam',
  approvals: 2,
  unread: 3,
  focus: null,
  widgets: [{ key: 'l1', id: 'demo.now', title: 'Weather at home', size: 'small', view: { state: 'ok', body: { kind: 'stat', value: '19°C', caption: 'Partly cloudy' } as never } }],
  ...over,
});

function App(): JSX.Element {
  const lock = useLock();
  return (
    <div>
      <p>The secret inbox</p>
      <button type="button" onClick={lock.lockNow}>Lock it</button>
    </div>
  );
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('the lock gate', () => {
  it('draws the app while open, and only the lock screen — no app in the page — while locked', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue(open);
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    const lockNow = vi.spyOn(api, 'lockNow').mockResolvedValue(locked);
    render(<LockGate><App /></LockGate>);
    expect(await screen.findByText('The secret inbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lock it' }));
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
    expect(lockNow).toHaveBeenCalledWith('owner');
    expect(document.body.textContent).not.toContain('The secret inbox');
    expect(localStorage.getItem('buddi-locked')).toBe('1');
  });

  it('starts on the lock screen when the session is locked', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue(locked);
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    render(<LockGate><App /></LockGate>);
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
    expect(screen.queryByText('The secret inbox')).toBeNull();
    expect(await screen.findByText('Sam')).toBeInTheDocument();
  });

  it('goes to the lock screen the moment the server answers 423 anywhere', async () => {
    const state = vi.spyOn(api, 'lockState').mockResolvedValue(open);
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    render(<LockGate><App /></LockGate>);
    await screen.findByText('The secret inbox');
    state.mockResolvedValue(locked);
    act(() => { window.dispatchEvent(new Event(LOCKED)); });
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
    expect(screen.queryByText('The secret inbox')).toBeNull();
  });

  it('locks with the keyboard shortcut from anywhere, a text field included', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue(open);
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    const lockNow = vi.spyOn(api, 'lockNow').mockResolvedValue(locked);
    render(<LockGate><App /><input aria-label="draft" /></LockGate>);
    await screen.findByText('The secret inbox');
    screen.getByLabelText('draft').focus();
    // jsdom is not a Mac: Ctrl+Alt+L.
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true });
    expect(await screen.findByTestId('lock-screen')).toBeInTheDocument();
    expect(lockNow).toHaveBeenCalledWith('owner');
  });

  it('without a PIN, Lock now opens Settings → Lock screen instead', async () => {
    vi.spyOn(api, 'lockState').mockResolvedValue({ ...open, pin: false });
    const lockNow = vi.spyOn(api, 'lockNow');
    render(<LockGate><App /></LockGate>);
    await screen.findByText('The secret inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Lock it' }));
    expect(window.location.hash).toBe('#/settings/lock');
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('locks itself after the delay with nobody using the page, and reports use at most twice a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(api, 'lockState').mockResolvedValue({ ...open, delayMinutes: 1 });
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    const lockNow = vi.spyOn(api, 'lockNow').mockResolvedValue({ ...locked, reason: 'idle' });
    const activity = vi.spyOn(api, 'lockActivity').mockResolvedValue(null);
    render(<LockGate><App /></LockGate>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('The secret inbox')).toBeInTheDocument();
    // Opening the page is not use.
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(activity).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'a' });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(activity).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(window);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(activity).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(65_000); });
    expect(lockNow).toHaveBeenCalledWith('idle');
  });

  it('knows its shortcut: ⌃⌘L on a Mac, Ctrl+Alt+L elsewhere', () => {
    expect(lockShortcutLabel(true)).toBe('⌃⌘L');
    expect(lockShortcutLabel(false)).toBe('Ctrl+Alt+L');
    const key = { key: 'l', code: 'KeyL', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(isLockShortcut({ ...key, metaKey: true }, true)).toBe(true);
    expect(isLockShortcut({ ...key, altKey: true }, true)).toBe(false);
    expect(isLockShortcut({ ...key, altKey: true }, false)).toBe(true);
    expect(isLockShortcut({ ...key, metaKey: true }, false)).toBe(false);
    expect(isLockShortcut({ ...key, altKey: true, shiftKey: true }, false)).toBe(false);
    expect(isLockShortcut({ ...key, key: 'k', code: 'KeyK', altKey: true }, false)).toBe(false);
  });
});

describe('the lock screen', () => {
  const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

  it('shows the time, counts only, the widgets, and the honest line; the PIN field holds focus', async () => {
    // The honest line names the day once it isn't today: pin the clock to the lock's day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T13:00:00Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    render(<LockScreen initial={locked} onUnlocked={() => {}} />);
    expect(await screen.findByLabelText('Waiting for you')).toHaveTextContent('2 approvals waiting');
    expect(screen.getByLabelText('Waiting for you')).toHaveTextContent('3 notifications');
    expect(screen.getByRole('group', { name: 'Weather at home' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Locked by you at 14:02');
    expect(screen.getByLabelText('PIN')).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'buddi is locked' })).toBeInTheDocument();
  });

  it('unlocks with the right PIN, and says how many tries are left after a wrong one', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    const unlock = vi.spyOn(api, 'unlock')
      .mockRejectedValueOnce(new ApiError(403, 'That PIN isn’t right.', { triesLeft: 3, waitUntil: null }))
      .mockResolvedValueOnce(open);
    const done = vi.fn();
    render(<LockScreen initial={locked} onUnlocked={done} />);
    const u = user();
    const field = screen.getByLabelText('PIN');
    await u.type(field, '12ab34');
    expect(field).toHaveValue('1234');
    await u.keyboard('{Enter}');
    expect(await screen.findByText('That PIN isn’t right. 3 tries left.')).toBeInTheDocument();
    expect(field).toHaveValue('');
    await u.type(field, '2468{Enter}');
    await waitFor(() => expect(done).toHaveBeenCalledWith(open));
    expect(unlock).toHaveBeenLastCalledWith('2468');
  });

  it('draws its own clock: picked formats, no date, a second zone with how far ahead it is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-01T12:32:00Z') });
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData({ clockView: { time: '12h', date: 'off', zone: { label: 'Tokyo', timezone: 'Asia/Tokyo' } } }));
    const { container } = render(<LockScreen initial={locked} onUnlocked={() => {}} />);
    await screen.findByLabelText('Waiting for you');
    const time = container.querySelector('.lk-time')!;
    expect(time).toHaveAttribute('aria-label', '2:32 PM');
    expect(time.querySelector('.lk-ampm')).toHaveTextContent('PM');
    expect(container.querySelector('.lk-date')).toBeNull();
    expect(container.querySelector('.lk-zone')).toHaveTextContent('Tokyo9:32 PM7 h ahead');
  });

  it('draws a sentence one column wide, so an empty day is never a hollow card', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData({
      widgets: [{ key: 'l2', id: 'demo.today', title: 'Coming up', size: 'medium', view: { state: 'ok', body: { kind: 'text', icon: 'calendar', text: 'Free for the rest of today.' } } }],
    }));
    render(<LockScreen initial={locked} onUnlocked={() => {}} />);
    const tile = await screen.findByRole('group', { name: 'Coming up' });
    expect(tile).toHaveAttribute('data-size', 'small');
    expect(tile).toHaveAttribute('data-kind', 'text');
    expect(tile.closest('.lk-grid')).toHaveAttribute('data-cols', '1');
  });

  it('opens Notifications once unlocked when its count was tapped', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    vi.spyOn(api, 'unlock').mockResolvedValue(open);
    window.location.hash = '#/';
    const done = vi.fn();
    render(<LockScreen initial={locked} onUnlocked={done} />);
    const u = user();
    await u.click(await screen.findByRole('button', { name: /3 notifications/ }));
    expect(screen.getByRole('button', { name: /3 notifications/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Unlock to open your notifications.');
    expect(screen.getByLabelText('PIN')).toHaveFocus();
    await u.type(screen.getByLabelText('PIN'), '2468{Enter}');
    await waitFor(() => expect(done).toHaveBeenCalledWith(open));
    expect(window.location.hash).toBe('#/settings/notifications/recent');
    window.location.hash = '';
  });

  it('counts the wait down and keeps the field shut while it runs', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData({ waitUntil: new Date(Date.now() + 30_000).toISOString(), triesLeft: 0 }));
    render(<LockScreen initial={{ ...locked, waitUntil: new Date(Date.now() + 30_000).toISOString() }} onUnlocked={() => {}} />);
    expect(await screen.findByText(/Too many tries\. Try again in 0:(29|30)\./)).toBeInTheDocument();
    expect(screen.getByLabelText('PIN')).toBeDisabled();
  });

  it('answers Forgot PIN with the two commands to run on the computer buddi runs on', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData());
    render(<LockScreen initial={locked} onUnlocked={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Forgot PIN?' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Forgot your PIN?' });
    expect(dialog).toHaveTextContent('buddi dashboard --unlock');
    expect(dialog).toHaveTextContent('buddi dashboard --remove-pin');
  });

  it('leaves by itself when another tab or device unlocked the session', async () => {
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData({ locked: false }));
    const done = vi.fn();
    render(<LockScreen initial={locked} onUnlocked={done} />);
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('says why it locked, in the owner’s zone', () => {
    const now = new Date('2026-10-01T12:30:00Z');
    expect(lockedLine({ lockedAt: '2026-10-01T12:02:00Z', reason: 'owner', delayMinutes: 5 }, 'Europe/Paris', now)).toBe('Locked by you at 14:02');
    expect(lockedLine({ lockedAt: '2026-10-01T12:02:00Z', reason: 'idle', delayMinutes: 5 }, 'Europe/Paris', now)).toBe('Locked after 5 minutes away, at 14:02');
    expect(lockedLine({ lockedAt: '2026-10-01T12:02:00Z', reason: 'idle', delayMinutes: 60 }, 'Europe/Paris', now)).toBe('Locked after an hour away, at 14:02');
    expect(lockedLine({ lockedAt: '2026-10-01T12:02:00Z', reason: 'start', delayMinutes: 5 }, 'Europe/Paris', now)).toBe('Locked since this session began, at 14:02');
    expect(lockedLine({ lockedAt: '2026-09-30T16:02:00Z', reason: 'owner', delayMinutes: 5 }, 'Europe/Paris', now)).toMatch(/^Locked by you at Wed 30 Sept?, 18:02$/);
  });
});

describe('one format on the lock screen', { timeout: 180_000 }, () => {
  const now = new Date('2026-10-01T16:59:30Z');
  const at = { lockedAt: '2026-10-01T16:59:00Z', reason: 'owner' as const, delayMinutes: 5 as const };
  afterEach(() => setDisplayFormats({ timeFormat: null, dateFormat: null }));

  it('writes the honesty line in the big clock’s format, whatever the shell’s formats say', () => {
    // The shell on 12-hour (or never set: a page that opens locked), the lock clock on 24-hour.
    setDisplayFormats({ timeFormat: '12h' });
    const view = { time: '24h' as const, date: null, zone: null };
    expect(lockClockText(now, 'Europe/Paris', view).time).toBe('18:59');
    expect(lockedLine(at, 'Europe/Paris', now, view)).toBe('Locked by you at 18:59');
    // And the other way round: a 12-hour lock clock over a 24-hour shell.
    setDisplayFormats({ timeFormat: '24h' });
    const twelve = { time: '12h' as const, date: null, zone: { label: 'Ben', timezone: 'America/New_York' } };
    const text = lockClockText(now, 'Europe/Paris', twelve);
    expect(text.time).toMatch(/^6:59\s?PM$/);
    expect(text.zone?.time).toMatch(/^12:59\s?PM$/);
    expect(lockedLine(at, 'Europe/Paris', now, twelve)).toMatch(/^Locked by you at 6:59\s?PM$/);
  });

  it('never mixes on the screen: the clock and the line under the PIN agree', async () => {
    setDisplayFormats({ timeFormat: '24h' });
    vi.spyOn(api, 'lockScreen').mockResolvedValue(screenData({ ...at, now: now.toISOString(), clockView: { time: '12h', date: null, zone: null } }));
    render(<LockScreen initial={{ ...locked, ...at }} onUnlocked={() => {}} />);
    await waitFor(() => expect(screen.getByText(/^Locked by you at .*6:59\s?PM$/)).toBeInTheDocument());
    expect(document.querySelector('.lk-time')?.getAttribute('aria-label')).toMatch(/[AP]M$/);
  });
});

describe('the lock grid', () => {
  it('is as wide as its widest row, so the block stays centred', () => {
    // Medium, small, medium, small fills rows of three, not a grid of four.
    expect(lockColumns(['medium', 'small', 'medium', 'small'], false)).toBe(3);
    expect(lockColumns(['small', 'small', 'small', 'small'], false)).toBe(4);
    expect(lockColumns(['medium', 'medium'], false)).toBe(4);
    expect(lockColumns(['medium', 'small', 'small', 'small'], false)).toBe(4);
    expect(lockColumns(['small'], false)).toBe(1);
    expect(lockColumns(['medium', 'small'], true)).toBe(2);
    expect(lockColumns(['small'], true)).toBe(1);
  });
});
