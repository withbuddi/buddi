/**
 * The `calendar` component: where an event lands, what a crowded day says,
 * how the list groups, and that moving through the weeks asks the calendar's
 * own query — and only it — for the days now shown.
 *
 * "Now" is pinned to Monday 28 September 2026, 10:00 in Paris, and the page is
 * drawn in Paris: an event the query gives as 07:30Z is a 09:30 event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import { eventsOn, lanesOf, toEvents, rangeOf, move, rangeTitle } from './calendar';
import type { PluginPageDescriptor } from './types';
import { setDisplayFormats } from '../format';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn() },
}));

const EVENTS = [
  { id: 'standup', title: 'Team standup', start: '2026-09-28T07:30:00Z', end: '2026-09-28T07:45:00Z', allDay: false, calendar: 'Work', tone: 0, location: 'Zoom' },
  { id: 'planning', title: 'Weekly planning', start: '2026-09-28T08:00:00Z', end: '2026-09-28T09:00:00Z', allDay: false, calendar: 'Work', tone: 0, location: '' },
  { id: 'call', title: 'Call with the Lyon office', start: '2026-09-28T08:30:00Z', end: '2026-09-28T09:30:00Z', allDay: false, calendar: 'Work', tone: 0, location: '' },
  { id: 'review', title: 'Design review', start: '2026-09-28T12:00:00Z', end: '2026-09-28T13:30:00Z', allDay: false, calendar: 'Work', tone: 0, location: '' },
  { id: 'dentist', title: 'Dentist', start: '2026-09-29T13:30:00Z', end: '2026-09-29T14:15:00Z', allDay: false, calendar: 'Home', tone: 1, location: 'Lyon' },
  { id: 'rent', title: 'Rent due', start: '2026-10-01', end: '2026-10-02', allDay: true, calendar: 'Bills', tone: 3, location: '' },
];

const page: PluginPageDescriptor = {
  plugin: 'demo',
  id: 'agenda',
  title: 'Calendar',
  place: 'rail',
  body: [
    {
      kind: 'calendar',
      query: { query: 'agenda' },
      events: 'events',
      map: { id: 'id', title: 'title', start: 'start', end: 'end', allDay: 'allDay', calendar: 'calendar', tone: 'tone', location: 'location' },
      views: ['week', 'month', 'list'],
      default: 'week',
    },
  ],
};

const navigate = vi.fn();
const asked = (): Array<Record<string, string>> =>
  vi.mocked(api.pageQuery).mock.calls.filter(([, query]) => query === 'agenda').map(([, , params]) => params as Record<string, string>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T08:00:00Z') });
  window.localStorage.clear();
  vi.mocked(api.pageQuery).mockReset();
  vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: { events: EVENTS } })) as typeof api.pageQuery);
});

afterEach(() => {
  vi.useRealTimers();
});

async function drawn(): Promise<void> {
  render(<PluginPage page={page} item={null} navigate={navigate} timezone="Europe/Paris" />);
  await screen.findByRole('button', { name: /^09:30–09:45, Team standup/ });
}

describe('the calendar component', () => {
  it('places a timed event in its day and at its hour, in the owner’s zone', async () => {
    await drawn();
    const monday = screen.getByRole('gridcell', { name: 'Mon 28 Sep' });
    const standup = within(monday).getByRole('button', { name: '09:30–09:45, Team standup, Zoom, Work, Mon 28 Sep' });
    expect(standup.style.top).toBe('calc(var(--cal-hour) * 9.5)');
    // Shorter than the shortest drawn: drawn half an hour tall, time and title on one line.
    expect(standup.style.height).toBe('calc(var(--cal-hour) * 0.5)');
    expect(standup).toHaveAttribute('data-short', 'true');
    // Two that overlap share the column, side by side.
    const planning = within(monday).getByRole('button', { name: /Weekly planning/ });
    const call = within(monday).getByRole('button', { name: /Call with the Lyon office/ });
    expect([planning.dataset.lane, call.dataset.lane]).toEqual(['0', '1']);
    expect(planning.style.width).toBe('calc((100% - var(--space-1)) / 2 - var(--space-0))');
    // Today's column and header are marked; the range is the week from Monday.
    expect(monday).toHaveAttribute('data-today', 'true');
    expect(screen.getByRole('columnheader', { name: 'Mon 28 Sep' })).toHaveAttribute('data-today', 'true');
    expect(screen.getByRole('heading', { name: '28 Sep – 4 Oct 2026' })).toBeInTheDocument();
    expect(within(screen.getByRole('gridcell', { name: 'Tue 29 Sep' })).getByRole('button', { name: /^15:30–16:15, Dentist/ })).toHaveAttribute('data-tone', '1');
  });

  it('draws an all-day event as a chip at the top of its day', async () => {
    await drawn();
    const chip = screen.getByRole('button', { name: 'All day, Rent due, Bills, Thu 1 Oct' });
    expect(chip).toHaveClass('cal-chip');
    expect(chip.closest('.cal-allday-cell')).not.toBeNull();
    expect(within(screen.getByRole('gridcell', { name: 'Thu 1 Oct' })).queryByText('Rent due')).toBeNull();
  });

  it('shows three events in a month’s day, then +N, and the chosen day below', async () => {
    await drawn();
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    const cell = document.querySelector<HTMLElement>('.cal-cell[data-date="2026-09-28"]')!;
    expect(cell.querySelectorAll('.cal-chip')).toHaveLength(3);
    expect(within(cell).getByRole('button', { name: '1 more on Mon 28 Sep' })).toHaveTextContent('+1');
    expect(cell).toHaveAttribute('data-today', 'true');
    expect(document.querySelector('.cal-cell[data-date="2026-10-01"]')).toHaveAttribute('data-outside', 'true');
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    // Today is chosen at first; its events are listed under the grid.
    expect(screen.getByRole('heading', { name: 'Today · Mon 28 Sep' })).toBeInTheDocument();
    fireEvent.click(within(document.querySelector<HTMLElement>('.cal-cell[data-date="2026-09-29"]')!).getByRole('button', { name: 'Tue 29 Sep, 1 event' }));
    const panel = screen.getByRole('heading', { name: 'Tomorrow · Tue 29 Sep' }).closest('section')!;
    expect(within(panel).getByText('Dentist')).toBeInTheDocument();
    expect(within(panel).getByText('Lyon')).toBeInTheDocument();
    expect(within(panel).getByText('15:30–16:15')).toBeInTheDocument();
  });

  it('lists seven days from today, one panel each, and says Nothing. on an empty day', async () => {
    await drawn();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      '28 Sep – 4 Oct 2026',
      'Today · Mon 28 Sep',
      'Tomorrow · Tue 29 Sep',
      'Wed 30 Sep',
      'Thu 1 Oct',
      'Fri 2 Oct',
      'Sat 3 Oct',
      'Sun 4 Oct',
    ]);
    const today = screen.getByRole('heading', { name: 'Today · Mon 28 Sep' }).closest('section')!;
    expect(within(today).getAllByText(/Team standup|Weekly planning|Call with the Lyon office|Design review/).map((n) => n.textContent)).toEqual([
      'Team standup',
      'Weekly planning',
      'Call with the Lyon office',
      'Design review',
    ]);
    const thursday = screen.getByRole('heading', { name: 'Thu 1 Oct' }).closest('section')!;
    expect(within(thursday).getByText('All day')).toBeInTheDocument();
    const wednesday = screen.getByRole('heading', { name: 'Wed 30 Sep' }).closest('section')!;
    expect(within(wednesday).getByText('Nothing.')).toBeInTheDocument();
  });

  it('asks its query again for the days shown as the owner moves, by button and by key', async () => {
    await drawn();
    expect(asked().at(-1)).toEqual({ from: '2026-09-28', to: '2026-10-05' });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(asked().at(-1)).toEqual({ from: '2026-10-05', to: '2026-10-12' }));
    const region = screen.getByRole('region', { name: 'Calendar' });
    fireEvent.keyDown(region, { key: 'T' });
    await waitFor(() => expect(asked().at(-1)).toEqual({ from: '2026-09-28', to: '2026-10-05' }));
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    await waitFor(() => expect(asked().at(-1)).toEqual({ from: '2026-09-21', to: '2026-09-28' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    // The month around the day it was on: 21 September's month, six weeks from Monday 31 August.
    await waitFor(() => expect(asked().at(-1)).toEqual({ from: '2026-08-31', to: '2026-10-12' }));
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    await waitFor(() => expect(asked().at(-1)).toEqual({ from: '2026-09-28', to: '2026-11-09' }));
    // Nothing else on the page is asked: every read was the calendar's.
    expect(vi.mocked(api.pageQuery).mock.calls.every(([, query]) => query === 'agenda')).toBe(true);
  });

  it('remembers the chosen view for this page', async () => {
    await drawn();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(window.localStorage.getItem('buddi.calendar-view:demo/agenda')).toBe('list');
    act(() => undefined);
    document.body.innerHTML = '';
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="Europe/Paris" />);
    expect(await screen.findByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the calendar arithmetic', () => {
  it('reads instants in the owner’s zone and dates as all-day, and leaves out what it cannot read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const map = { id: 'id', title: 'title', start: 'start', end: 'end' };
    const events = toEvents(
      [
        { id: 'a', title: 'Late', start: '2026-09-28T21:00:00Z', end: '2026-09-29T00:30:00Z' },
        { id: 'b', title: 'Trip', start: '2026-10-03', end: '2026-10-05' },
        { id: 'c', title: 'Broken', start: 'soon', end: '' },
        { id: 'a', title: 'Twice', start: '2026-09-28T09:00:00Z', end: '2026-09-28T10:00:00Z' },
      ],
      map,
      'Europe/Paris',
      'test',
    );
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    // 23:00 to 02:30 in Paris: "from 23:00" on the Monday, "until 02:30" on the Tuesday.
    expect(eventsOn(events, '2026-09-28').map((x) => [x.event.title, x.part.from, x.part.to])).toEqual([['Late', 1380, 1440]]);
    expect(eventsOn(events, '2026-09-29').map((x) => [x.event.title, x.part.from, x.part.to])).toEqual([['Late', 0, 150]]);
    expect(eventsOn(events, '2026-10-04').map((x) => x.part.allDay)).toEqual([true]);
    expect(eventsOn(events, '2026-10-05')).toEqual([]);
  });

  it('puts overlapping events in lanes and starts a new cluster once they stop overlapping', () => {
    const at = (from: number, to: number) => ({ part: { from, to, allDay: false } });
    const laid = lanesOf([at(600, 660), at(630, 690), at(640, 650), at(700, 760)]);
    expect(laid.map((x) => [x.lane, x.lanes])).toEqual([[0, 3], [1, 3], [2, 3], [0, 1]]);
  });

  it('knows the days each view shows and how it steps', () => {
    expect(rangeOf('week', '2026-10-01')).toEqual({ from: '2026-09-28', days: 7 });
    expect(rangeOf('month', '2026-09-15')).toEqual({ from: '2026-08-31', days: 42 });
    expect(rangeOf('list', '2026-09-28')).toEqual({ from: '2026-09-28', days: 7 });
    expect(move('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(rangeTitle('week', '2026-12-30', '2026-12-28', 7)).toBe('28 Dec 2026 – 3 Jan 2027');
  });

  it("titles a month in the owner's date format and the browser's words on Auto", () => {
    try {
      setDisplayFormats({ dateFormat: 'iso' });
      expect(rangeTitle('month', '2026-09-15', '2026-08-31', 42)).toBe('2026-09');
      setDisplayFormats({ dateFormat: 'short' });
      expect(rangeTitle('month', '2026-09-15', '2026-08-31', 42)).toBe('September 2026');
      setDisplayFormats({ dateFormat: null, locale: 'fr-FR' });
      expect(rangeTitle('month', '2026-09-15', '2026-08-31', 42)).toBe('septembre 2026');
    } finally {
      setDisplayFormats({ dateFormat: null, locale: 'en-GB' });
    }
  });
});
