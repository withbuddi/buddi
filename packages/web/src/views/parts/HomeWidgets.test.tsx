/** Home's widgets: each body kind, the frame's states, the menu, edit mode (mouse and keyboard), the empty line, the phone's one column. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  api: { widgets: vi.fn(), saveWidgetLayout: vi.fn(), refreshWidget: vi.fn() },
}));

import { api, type WidgetInfo, type WidgetLayoutItem, type WidgetsAnswer, type WidgetView } from '../../api';
import { HomeWidgets, placedIds, useWidgets } from './HomeWidgets';
import { GLANCE_UNDO_MS } from './HomeGlances';

/** Radix opens on Enter; a click on an item selects it. Much quicker under jsdom than a full user event. */
const openMenu = (name: string): void => { fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' }); };
const choose = (name: string): void => { fireEvent.click(screen.getByRole('menuitem', { name })); };

const INFO: WidgetInfo[] = [
  { id: 'weather.now', plugin: 'weather', title: 'Weather at home', sizes: ['small', 'medium'], link: { plugin: 'weather', page: 'weather', place: 'rail' } },
  { id: 'calendar.today', plugin: 'calendar', title: 'Today', sizes: ['medium', 'small'] },
  { id: 'finance.month', plugin: 'finance', title: 'Spent this month', sizes: ['small'], sensitive: true },
  { id: 'email.replies', plugin: 'email', title: 'Waiting on you', sizes: ['small'] },
  { id: 'notes.tip', plugin: 'notes', title: 'A thought', sizes: ['small'] },
];

const AT = '2026-10-01T08:00:00.000Z';
const VIEWS: Record<string, WidgetView> = {
  'weather.now': { state: 'ok', updatedAt: AT, body: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Lyon', trend: { label: 'Next 12 hours', points: [18, 17, 15] }, foot: 'High 21° · Low 12°' } },
  'calendar.today': { state: 'ok', updatedAt: AT, body: { kind: 'list', rows: [{ title: 'Dinner with Ana', sub: 'Le Kitchen', side: '20:00' }, { title: 'Standup', side: '09:30' }], more: '2 more tomorrow' } },
  'finance.month': { state: 'ok', updatedAt: AT, body: { kind: 'progress', value: '€1,284', caption: 'of €1,900 budget', ratio: 0.68, tone: 'accent' } },
  'email.replies': { state: 'ok', updatedAt: AT, body: { kind: 'strip', value: '3', caption: 'waiting', items: [{ label: 'Ana', value: '2 d' }, { label: 'Marc', icon: 'mail', value: '4 h' }] } },
  'notes.tip': { state: 'ok', updatedAt: AT, body: { kind: 'text', icon: 'bulb', text: 'Drink water.', sub: 'Every day' } },
};

function answerOf(layout: WidgetLayoutItem[], views: Record<string, WidgetView> = VIEWS, available = INFO): WidgetsAnswer {
  return { available, layout, arranged: true, widgets: Object.fromEntries(layout.map((item) => [item.id, views[item.id]!])) };
}

function Harness({ navigate = () => {} }: { navigate?: (route: string) => void }): JSX.Element {
  const widgets = useWidgets();
  return (
    <>
      <span data-testid="placed">{[...placedIds(widgets.answer)].join(',')}</span>
      <HomeWidgets widgets={widgets} navigate={navigate} />
    </>
  );
}

const ALL: WidgetLayoutItem[] = [
  { id: 'weather.now', size: 'small' },
  { id: 'calendar.today', size: 'medium' },
  { id: 'finance.month', size: 'small' },
  { id: 'email.replies', size: 'small' },
  { id: 'notes.tip', size: 'small' },
];

beforeEach(() => {
  vi.mocked(api.saveWidgetLayout).mockImplementation(async (layout) => answerOf(layout));
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const frame = (name: string) => screen.getByRole('group', { name });
const order = () => screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));

describe('the bodies', () => {
  it('draws each of the five kinds from already formatted values', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL));
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    const weather = await screen.findByRole('group', { name: 'Weather at home' });
    expect(weather).toHaveTextContent('18°C');
    expect(weather).toHaveTextContent('Clear · Lyon');
    expect(weather).toHaveTextContent('Next 12 hours');
    expect(weather).toHaveTextContent('High 21° · Low 12°');
    expect(within(weather).getByTestId('spark')).toBeInTheDocument();
    fireEvent.click(within(weather).getByRole('link'));
    expect(navigate).toHaveBeenCalledWith('#/p/weather/weather');

    const today = frame('Today');
    expect(today).toHaveAttribute('data-size', 'medium');
    expect(within(today).getAllByRole('listitem')).toHaveLength(2);
    expect(today).toHaveTextContent('Le Kitchen'); // medium shows the sub line
    expect(today).toHaveTextContent('2 more tomorrow');

    const strip = frame('Waiting on you');
    expect(strip).toHaveTextContent('Ana2 d');
    expect(strip).toHaveTextContent('Marc4 h');

    const text = frame('A thought');
    expect(text).toHaveTextContent('Drink water.');
    expect(text).toHaveTextContent('Every day');
    expect(screen.getByTestId('placed')).toHaveTextContent('weather.now,calendar.today,finance.month,email.replies,notes.tip');
  });

  it('hides a sensitive body until Show, and draws its bar then', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL));
    render(<Harness />);
    const money = await screen.findByRole('group', { name: 'Spent this month' });
    expect(money).not.toHaveTextContent('€1,284');
    expect(money).toHaveTextContent('Hidden on this screen.');
    fireEvent.click(within(money).getByRole('button', { name: 'Show' }));
    expect(money).toHaveTextContent('€1,284');
    expect(within(money).getByRole('meter')).toHaveAttribute('aria-valuenow', '68');
  });
});

describe('the frame states', () => {
  it('marks a stale body, says nothing to show, and offers Try again on a failure', async () => {
    const views: Record<string, WidgetView> = {
      ...VIEWS,
      'weather.now': { ...VIEWS['weather.now']!, state: 'stale', error: 'offline', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
      'calendar.today': { state: 'error', error: 'did not answer in 5 seconds' },
      'email.replies': { state: 'empty', updatedAt: AT },
    };
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL, views));
    vi.mocked(api.refreshWidget).mockResolvedValue(answerOf(ALL));
    render(<Harness />);
    const weather = await screen.findByRole('group', { name: 'Weather at home' });
    expect(weather).toHaveAttribute('data-state', 'stale');
    expect(weather).toHaveTextContent('2 h old');
    expect(weather).toHaveTextContent('18°C');
    const today = frame('Today');
    expect(today).toHaveTextContent("Couldn't load this.");
    expect(today).toHaveTextContent('Did not answer in 5 seconds.');
    expect(within(today).queryByRole('link')).toBeNull();
    expect(frame('Waiting on you')).toHaveTextContent('Nothing to show right now.');
    fireEvent.click(within(today).getByRole('button', { name: 'Try again' }));
    expect(api.refreshWidget).toHaveBeenCalledWith('calendar.today');
    await waitFor(() => expect(frame('Today')).toHaveTextContent('Dinner with Ana'));
  });

  it('holds quiet frames for the last layout while the first answer comes, and draws no section when no plugin offers one', async () => {
    window.localStorage.setItem('buddi.home.widgets', '2');
    let resolve: (a: WidgetsAnswer) => void = () => {};
    vi.mocked(api.widgets).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('.wg-frame[data-state="loading"]')).toHaveLength(2);
    await act(async () => { resolve(answerOf([], VIEWS, [])); });
    expect(screen.queryByRole('region', { name: 'Widgets' })).toBeNull();
    expect(container.querySelector('.wg-section')).toBeNull();
  });
});

describe('the menu', { timeout: 180_000 }, () => {
  it('hides a widget, leaves Undo in its place, and Undo puts it back where it was', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 3)));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Today' });
    openMenu('More for Today');
    expect(screen.getByText(/calendar · /)).toBeInTheDocument();
    choose('Hide from Home');
    expect(api.saveWidgetLayout).toHaveBeenLastCalledWith([ALL[0], ALL[2]]);
    const status = (await screen.findByText('Today hidden')).closest('[role="status"]') as HTMLElement;
    expect(status).toHaveAttribute('data-size', 'medium'); // it holds the hidden one's place
    fireEvent.click(within(status).getByRole('button', { name: 'Undo' }));
    expect(api.saveWidgetLayout).toHaveBeenLastCalledWith(ALL.slice(0, 3));
    await waitFor(() => expect(order()).toEqual(['Weather at home', 'Today', 'Spent this month']));
  });

  it('moves and resizes at once, and the Undo line leaves after its time', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 2)));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Weather at home' });
    openMenu('More for Weather at home');
    expect(screen.queryByRole('menuitem', { name: 'Move earlier' })).toBeNull();
    choose('Make it medium');
    expect(api.saveWidgetLayout).toHaveBeenLastCalledWith([{ id: 'weather.now', size: 'medium' }, ALL[1]]);
    await waitFor(() => expect(frame('Weather at home')).toHaveAttribute('data-size', 'medium'));
    openMenu('More for Today');
    choose('Move earlier');
    await waitFor(() => expect(order()).toEqual(['Today', 'Weather at home']));
    openMenu('More for Today');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    choose('Hide from Home');
    await screen.findByText('Today hidden');
    act(() => { vi.advanceTimersByTime(GLANCE_UNDO_MS + 100); });
    expect(screen.queryByText('Today hidden')).toBeNull();
  });

  it('puts the layout back and says so when a save fails', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 2)));
    vi.mocked(api.saveWidgetLayout).mockRejectedValue(new Error('the gateway said no'));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Today' });
    openMenu('More for Today');
    choose('Hide from Home');
    // A Radix menu closing is slow under jsdom (seconds); the describe allows for it.
    expect((await screen.findByText("Couldn't save your widgets: the gateway said no")).closest('[role="alert"]')).not.toBeNull();
    expect(order()).toEqual(['Weather at home', 'Today']);
  });
});

describe('edit mode', { timeout: 180_000 }, () => {
  it('takes one off, resizes, moves with the buttons, adds from the gallery, and saves on Done', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 3)));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Today' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const gallery = screen.getByRole('region', { name: 'Add widgets' });
    expect(within(gallery).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Waiting on you'),
      expect.stringContaining('A thought'),
    ]);
    // Nothing navigates while editing.
    expect(within(frame('Weather at home')).queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take Spent this month off Home' }));
    fireEvent.click(within(frame('Today')).getByRole('radio', { name: 'Small' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Today earlier' }));
    expect(screen.getByRole('button', { name: 'Move Today earlier' })).toBeDisabled();
    fireEvent.click(within(gallery).getByRole('button', { name: 'Add Waiting on you' }));
    expect(order()).toEqual(['Today', 'Weather at home', 'Waiting on you']);
    expect(frame('Waiting on you')).toHaveTextContent('Fills in when you press Done.');
    expect(api.saveWidgetLayout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(api.saveWidgetLayout).toHaveBeenCalledWith([
      { id: 'calendar.today', size: 'small' },
      { id: 'weather.now', size: 'small' },
      { id: 'email.replies', size: 'small' },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Add widgets' })).toBeNull();
  });

  it('moves with the arrow keys on the grip, keeping the focus there, and Cancel puts everything back', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 3)));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Today' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const grip = screen.getByRole('button', { name: /^Move Weather at home, position 1 of 3/ });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(order()).toEqual(['Today', 'Weather at home', 'Spent this month']);
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-grip', 'weather.now'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(order()).toEqual(['Today', 'Spent this month', 'Weather at home']);
    expect(screen.getByText('Weather at home, position 3 of 3.')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(order()).toEqual(['Today', 'Weather at home', 'Spent this month']);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(order()).toEqual(['Weather at home', 'Today', 'Spent this month']);
    expect(api.saveWidgetLayout).not.toHaveBeenCalled();
  });

  it('drags one onto another to move it there', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf(ALL.slice(0, 3)));
    render(<Harness />);
    await screen.findByRole('group', { name: 'Today' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(frame('Spent this month'), { dataTransfer });
    fireEvent.dragOver(frame('Weather at home'), { dataTransfer });
    expect(frame('Weather at home')).toHaveAttribute('data-over', 'true');
    fireEvent.drop(frame('Weather at home'), { dataTransfer });
    expect(order()).toEqual(['Spent this month', 'Weather at home', 'Today']);
  });
});

describe('nothing placed', () => {
  it('offers the gallery in one quiet line', async () => {
    vi.mocked(api.widgets).mockResolvedValue(answerOf([]));
    render(<Harness />);
    expect(await screen.findByText('Add widgets to Home')).toBeInTheDocument();
    expect(screen.getByText(/Weather at home, Today and 3 more\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widgets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Weather at home' }));
    expect(order()).toEqual(['Weather at home']);
  });
});

describe('on a phone', () => {
  it('falls to one column, a medium widget included, with no grip and the moves turned up and down', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/styles.css'), 'utf8');
    const phone = css.slice(css.lastIndexOf('@media (max-width: 720px)', css.indexOf('.wg-grip { display: none; }')));
    expect(phone).toContain(".wg-grid, .wg-grid[data-editing='true'] { grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(calc(var(--space-12) * 3), auto); }");
    expect(phone).toContain(".wg-frame[data-size='medium'], .wg-undo[data-size='medium'] { grid-column: auto; }");
    expect(phone).toContain('.wg-edit-move .ui-icon-btn svg { transform: rotate(90deg); }');
  });
});
