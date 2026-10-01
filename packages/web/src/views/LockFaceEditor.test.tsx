/**
 * Settings → Lock screen → What it shows: the preview draws the lock screen's
 * own face, the clock's choices save at once, the lock screen keeps its own
 * placements (up to four, never a sensitive one, a copy of Home's or any
 * widget), each with its own settings, and the focus line says when it shows.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { api, type LockScreenData, type WidgetInfo, type WidgetPlacement, type WidgetsAnswer } from '../api';
import { setDisplayFormats } from '../format';
import { LockFaceEditor } from './LockFaceEditor';

const INFO: WidgetInfo[] = [
  { id: 'weather.now', plugin: 'weather', title: 'Weather', sizes: ['small', 'medium'], settings: [{ key: 'place', kind: 'select', label: 'Place', inTitle: true, default: '', dynamic: true }] },
  { id: 'email.waiting', plugin: 'email', title: 'Waiting on you', sizes: ['small'] },
  { id: 'finance.month', plugin: 'finance', title: 'Spent this month', sizes: ['small'], sensitive: true },
  { id: 'buddi.clock', plugin: 'buddi', title: 'World clock', sizes: ['small', 'medium'], builtIn: true, settings: [{ key: 'places', kind: 'place', multiple: true, label: 'Places' }] },
];
const p = (key: string, widget: string, extra: Partial<WidgetPlacement> = {}): WidgetPlacement => ({ key, widget, size: 'small', settings: {}, ...extra });
const answer = (lock: WidgetPlacement[]): WidgetsAnswer => ({
  available: INFO,
  home: [p('h1', 'weather.now', { settings: { place: 'profile-work' }, label: 'Weather · Work' }), p('h2', 'finance.month')],
  lock,
  arranged: { home: true, lock: true },
  views: {},
});
const face: LockScreenData = {
  pin: true, locked: false, lockedAt: null, reason: null, delayMinutes: 5, background: 'sea', image: null, waitUntil: null, triesLeft: null,
  now: '2026-10-01T12:32:00Z', timezone: 'Europe/Paris', owner: 'Sam', approvals: 2, unread: 0, focus: null,
  widgets: [{ key: 'l1', id: 'weather.now', title: 'Weather', size: 'small', view: { state: 'ok', body: { kind: 'stat', value: '19°C' } } }],
  clockView: { time: '24h', date: 'long', zone: null },
};

beforeEach(() => {
  vi.spyOn(api, 'lockScreen').mockResolvedValue(face);
  vi.spyOn(api, 'owner').mockResolvedValue({ places: [
    { id: 'home', label: 'Home', address: null, name: 'Lyon, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' },
    { id: 'ben', label: 'Ben', address: null, name: 'Brooklyn, New York', latitude: 40.65, longitude: -73.95, timezone: 'America/New_York' },
  ] } as never);
  vi.spyOn(api, 'saveWidgets').mockImplementation(async (_surface, list) => answer(list.map((x) => ({ ...x, key: x.key ?? 'new' }))));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the lock screen editor', { timeout: 180_000 }, () => {
  const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

  it('previews the lock screen’s own face and says the focus shows only while one is on', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([p('l1', 'weather.now')]));
    const { container } = render(<LockFaceEditor clock={undefined} onClock={() => {}} version="v" />);
    const preview = await screen.findByRole('img', { name: 'Preview of the lock screen' });
    await waitFor(() => expect(within(preview).getByText('19°C')).toBeInTheDocument());
    expect(preview.querySelector('.lk')).toHaveAttribute('data-bg', 'sea');
    expect(preview.querySelector('.lk-zone')).toBeNull();
    expect(screen.getByText(/Your focus shows at the top only while one is on/)).toBeInTheDocument();
    expect(screen.getByText('As it shows now.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Phone' }));
    expect(container.querySelector('.lke-preview')).toHaveAttribute('data-phone', 'true');
  });

  it('keeps the clock’s choices at once: the time, the date, a second clock from a place or a town', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([]));
    vi.spyOn(api, 'findPlace').mockResolvedValue({ found: [{ name: 'Tokyo, Japan', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' }] });
    const onClock = vi.fn();
    render(<LockFaceEditor clock={{ time: 'profile', date: 'profile', zone: null }} onClock={onClock} version="v" />);
    const u = user();
    await u.click(await screen.findByRole('radio', { name: '12-hour' }));
    expect(onClock).toHaveBeenLastCalledWith({ time: '12h', date: 'profile', zone: null });
    await u.selectOptions(screen.getByLabelText('Date'), 'off');
    expect(onClock).toHaveBeenLastCalledWith({ time: 'profile', date: 'off', zone: null });
    const second = screen.getByLabelText(/A second clock/);
    // Only places in another zone are offered.
    expect(within(second).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Ben — Brooklyn', 'Another town…']);
    await u.selectOptions(second, 'place:ben');
    expect(onClock).toHaveBeenLastCalledWith({ time: 'profile', date: 'profile', zone: { place: 'ben' } });
    await u.selectOptions(second, 'find');
    await u.type(screen.getByLabelText('Find a town for the second clock'), 'Tokyo{Enter}');
    await waitFor(() => expect(onClock).toHaveBeenLastCalledWith({ time: 'profile', date: 'profile', zone: { label: 'Tokyo', timezone: 'Asia/Tokyo' } }));
  });

  it('says what Profile means now, and stores no explicit time unless one is picked', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([]));
    const onClock = vi.fn();
    setDisplayFormats({ timeFormat: '12h' });
    try {
      render(<LockFaceEditor clock={undefined} onClock={onClock} version="v" />);
      expect(await screen.findByRole('radio', { name: 'Profile (12-hour)' })).toHaveAttribute('aria-checked', 'true');
      // Opening the editor writes nothing; a change elsewhere keeps the time on Profile.
      expect(onClock).not.toHaveBeenCalled();
      await user().selectOptions(screen.getByLabelText('Date'), 'iso');
      expect(onClock).toHaveBeenLastCalledWith({ time: 'profile', date: 'iso', zone: null });
      cleanup();
      setDisplayFormats({ timeFormat: '24h' });
      render(<LockFaceEditor clock={undefined} onClock={onClock} version="v" />);
      expect(await screen.findByRole('radio', { name: 'Profile (24-hour)' })).toBeInTheDocument();
    } finally {
      setDisplayFormats({ timeFormat: null });
    }
  });

  it('keeps its own widgets: a copy of Home’s with its settings, any widget, never a sensitive one, in order', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([p('l1', 'email.waiting')]));
    render(<LockFaceEditor clock={undefined} onClock={() => {}} version="v" />);
    const u = user();
    await screen.findByText('Waiting on you');
    expect(screen.getByText(/A sensitive widget — Spent this month — never shows here\./)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: /Add a widget/ }), { key: 'Enter' });
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Weather · Worksame settings', 'Weather', 'Waiting on you', 'World clock']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Weather · Work/ }));
    await waitFor(() => expect(api.saveWidgets).toHaveBeenLastCalledWith('lock', [
      p('l1', 'email.waiting'),
      { key: expect.stringMatching(/^w-/), widget: 'weather.now', size: 'small', settings: { place: 'profile-work' } },
    ]));
    await u.click(await screen.findByRole('button', { name: 'Move Waiting on you later' }));
    await waitFor(() => expect(vi.mocked(api.saveWidgets).mock.lastCall![1].map((x) => x.widget)).toEqual(['weather.now', 'email.waiting']));
    await u.click(screen.getByRole('button', { name: 'Take Waiting on you off the lock screen' }));
    await waitFor(() => expect(vi.mocked(api.saveWidgets).mock.lastCall![1].map((x) => x.widget)).toEqual(['weather.now']));
  });

  it('holds four at most: Add is off and says why', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([p('a', 'email.waiting'), p('b', 'weather.now'), p('c', 'buddi.clock'), p('d', 'weather.now')]));
    render(<LockFaceEditor clock={undefined} onClock={() => {}} version="v" />);
    expect(await screen.findByText(/4 of 4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a widget/ })).toBeDisabled();
    expect(screen.getByText(/Four is the most it holds/)).toBeInTheDocument();
  });

  it('opens a placement’s settings for the lock screen, apart from Home’s', async () => {
    vi.spyOn(api, 'widgets').mockResolvedValue(answer([p('l1', 'weather.now')]));
    vi.spyOn(api, 'widgetSettings').mockResolvedValue({ widget: 'weather.now', fields: [{ key: 'place', kind: 'select', label: 'Place', inTitle: true, default: '', options: [{ value: '', label: 'Home' }, { value: 'profile-work', label: 'Work' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }], places: [], timeFormat: null });
    vi.spyOn(api, 'previewWidget').mockResolvedValue({ view: { state: 'ok', body: { kind: 'stat', value: '21°C' } }, label: 'Weather · Work' });
    render(<LockFaceEditor clock={undefined} onClock={() => {}} version="v" />);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Settings for Weather' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/on the lock screen\. These settings are this one’s own; Home keeps its own\./)).toBeInTheDocument();
    await u.click(await within(sheet).findByRole('radio', { name: 'Work' }));
    await u.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveWidgets).toHaveBeenLastCalledWith('lock', [p('l1', 'weather.now', { settings: { place: 'profile-work' } })]));
  });
});
