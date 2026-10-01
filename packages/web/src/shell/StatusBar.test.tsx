/** The footer status line: each item from state, its link, the zone, the update dot, the minute, and the phone's fold. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { LockContext } from './lock';
import { RailStatus, StatusBar, linkKind, statusItems, statusTone, zoneName, type ShellStatus } from './StatusBar';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const base: ShellStatus = {
  link: 'local',
  focus: { mode: 'do-not-disturb', until: '2026-10-01T19:30:00Z', startedAt: '2026-10-01T17:30:00Z', by: 'dashboard' },
  working: 2,
  paused: false,
  failed: 1,
  approvals: 3,
  version: { current: '0.1.0-pre.28', latest: '0.1.0-pre.29', updateAvailable: true },
  timezone: 'UTC',
};
const NOW = new Date('2026-10-01T18:05:00Z');

describe('the status line', () => {
  it('draws every item from state, each a link to where it is decided', () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    const go = vi.fn();
    render(<StatusBar status={base} onNavigate={go} />);
    const bar = screen.getByRole('contentinfo', { name: 'Status' });
    const link = (name: RegExp): HTMLElement => within(bar).getByRole('link', { name });
    expect(link(/^Connection: Local$/)).toHaveAttribute('href', '#/settings/system');
    expect(link(/^Focus: Do not disturb until 19:30$/)).toHaveAttribute('href', '#/settings/notifications');
    expect(link(/^Work: 2 agents working, Queue running, 1 failed$/)).toHaveAttribute('href', '#/activity/jobs?state=failed');
    expect(link(/^3 approvals waiting$/)).toHaveAttribute('href', '#/needs');
    expect(link(/^buddi 0\.1\.0-pre\.28/)).toHaveAttribute('href', '#/settings/system');
    expect(link(/^Your time: 18:05/)).toHaveAttribute('href', '#/settings/you');
    fireEvent.click(link(/approvals waiting/));
    expect(go).toHaveBeenCalledWith('#/needs');
  });

  it('leaves out focus and approvals when there are none, and says a paused queue', () => {
    const items = statusItems({ ...base, focus: null, approvals: 0, working: 0, failed: 0, paused: true }, NOW, 'UTC');
    expect(items.map((i) => i.key)).toEqual(['link', 'work', 'version', 'time']);
    const work = items.find((i) => i.key === 'work')!;
    expect(work.label).toBe('Work: Queue paused');
    expect(work.route).toBe('#/activity/jobs');
  });

  it('tells local from the tailnet, and says reconnecting while requests go unanswered', () => {
    expect(linkKind('127.0.0.1', false)).toBe('local');
    expect(linkKind('localhost', false)).toBe('local');
    expect(linkKind('amenophis.taild6f727.ts.net', false)).toBe('tailnet');
    expect(linkKind('amenophis.taild6f727.ts.net', true)).toBe('reconnecting');
    const link = statusItems({ ...base, link: 'reconnecting' }, NOW, 'UTC')[0]!;
    expect(link).toMatchObject({ text: 'Reconnecting…', dot: 'warning' });
  });

  it("names the owner's zone only when this device's is a different one", () => {
    const paris = { ...base, timezone: 'Europe/Paris' };
    expect(statusItems(paris, NOW, 'America/New_York').at(-1)).toMatchObject({ time: '20:05', zone: 'Paris', label: 'Your time: 20:05, Europe/Paris' });
    expect(statusItems(paris, NOW, 'Europe/Paris').at(-1)).toMatchObject({ time: '20:05', label: 'Your time: 20:05' });
    expect(statusItems(paris, NOW, 'Europe/Paris').at(-1)!.zone).toBeUndefined();
    expect(zoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneName('UTC')).toBe('UTC');
  });

  it('puts a dot on the version when a newer buddi is ready, and none otherwise', () => {
    const { rerender } = render(<StatusBar status={base} onNavigate={() => {}} />);
    expect(screen.getByTestId('status-update-dot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'buddi 0.1.0-pre.28, a newer buddi is ready: 0.1.0-pre.29' })).toBeInTheDocument();
    rerender(<StatusBar status={{ ...base, version: { current: '0.1.0-pre.28', updateAvailable: false } }} onNavigate={() => {}} />);
    expect(screen.queryByTestId('status-update-dot')).toBeNull();
  });

  it('moves the time on the minute, not before', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T18:05:10Z') });
    render(<StatusBar status={{ ...base, focus: null }} onNavigate={() => {}} />);
    expect(screen.getByRole('link', { name: /^Your time: 18:05/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(49_000); });
    expect(screen.getByRole('link', { name: /^Your time: 18:05/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getByRole('link', { name: /^Your time: 18:06/ })).toBeInTheDocument();
  });
});

describe('on a phone', { timeout: 180_000 }, () => {
  it('folds into one dot, the worst of what it says, that opens the same items', async () => {
    const go = vi.fn();
    render(<RailStatus status={base} onNavigate={go} />);
    expect(screen.getByTestId('rail-status-dot')).toHaveAttribute('data-tone', 'critical');
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Status' }));
    const menu = await screen.findByRole('menu');
    for (const name of [/^Connection: Local$/, /^Focus: /, /^Work: /, /^3 approvals waiting$/, /^buddi 0\.1\.0-pre\.28/, /^Your time: /]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole('menuitem', { name: /^Work: / }));
    expect(go).toHaveBeenCalledWith('#/activity/jobs?state=failed');
  });

  it('ends with Lock now, apart, while a PIN is set — and not without one', async () => {
    const lockNow = vi.fn();
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { unmount } = render(
      <LockContext.Provider value={{ pin: true, state: null, lockNow, update: () => {}, shortcut: '⌃⌘L' }}>
        <RailStatus status={base} onNavigate={vi.fn()} />
      </LockContext.Provider>,
    );
    await user.click(screen.getByRole('button', { name: 'Status' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.at(-1)).toHaveTextContent('Lock now');
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Lock now' }));
    expect(lockNow).toHaveBeenCalledTimes(1);
    unmount();
    render(<RailStatus status={base} onNavigate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Status' }));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: 'Lock now' })).not.toBeInTheDocument();
  });

  it('reads the dot from the state', () => {
    const calm: ShellStatus = { ...base, failed: 0, approvals: 0, version: { current: '1', updateAvailable: false } };
    expect(statusTone(calm)).toBe('good');
    expect(statusTone({ ...calm, approvals: 1 })).toBe('attention');
    expect(statusTone({ ...calm, paused: true })).toBe('warning');
    expect(statusTone({ ...calm, link: 'reconnecting' })).toBe('critical');
  });
});
