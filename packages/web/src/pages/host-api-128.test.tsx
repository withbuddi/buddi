/**
 * Host API 1.28 on the page, in Settings → Calendar's shape: a grouped list
 * whose groups have a head of their own (an aside in a tone, Sign in again,
 * a ⋯), each row's colour as a dot and its three-way choice (Not linked ·
 * Read · Read and change, an option greyed with why), one menu that runs a
 * tool or opens a drawer form, a polled card that finishes by itself once,
 * and `where` — the pasted-address fallback only away from this computer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { PluginPage, isLocalBrowser } from './PluginPage';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn() },
}));

const ROWS = [
  { id: 'sam', name: 'Sam', color: '#039be5', group: 'g1', groupLabel: 'Google · sam@gmail.com', groupAside: 'Sign-in ran out', groupTone: 'warning', account: 'g1', expired: true, access: 'change', line: '131 events · changes ask you first', link: false, readOnly: false },
  { id: 'fr', name: 'Holidays in France', color: '#7986cb', group: 'g1', groupLabel: 'Google · sam@gmail.com', groupAside: 'Sign-in ran out', groupTone: 'warning', account: 'g1', expired: true, access: 'off', line: 'Agents don’t see it', link: false, readOnly: true },
  { id: 'work', name: 'Work', color: 'url(https://evil.example/x)', group: 'i1', groupLabel: 'iCloud · sam@icloud.com', groupAside: '2 calendars · 1 linked', groupTone: '', account: 'i1', expired: false, access: 'read', line: '214 events', link: false, readOnly: false },
  { id: 'gym', name: 'Gym', color: '', group: 'links', groupLabel: 'Private links', groupAside: '1 link', groupTone: '', account: '', expired: false, access: 'read', line: 'read 3 days ago', link: true, readOnly: false },
];

const list = {
  kind: 'list' as const,
  query: { query: 'settings' },
  rows: 'calendars',
  key: 'id',
  groupBy: {
    key: 'group',
    label: 'groupLabel',
    aside: 'groupAside',
    asideTone: 'groupTone',
    actions: [
      { tool: 'calendar.google_sign_in', label: 'Sign in again', tone: 'accent' as const, when: { path: 'expired', equals: true }, args: { account: { row: 'account' } } },
      { tool: 'calendar.remove_account', label: 'Remove account…', tone: 'danger' as const, menu: true as const, when: { path: 'account', equals: '', not: true as const }, confirm: 'Remove {groupLabel}?', args: { id: { row: 'account' } } },
    ],
  },
  item: {
    title: { path: 'name' },
    sub: { path: 'line' },
    swatch: 'color',
    choice: {
      tool: 'calendar.set_access',
      label: 'What agents may do with {name}',
      value: 'access',
      options: [
        { value: 'off', label: 'Not linked', when: { path: 'link', equals: false } },
        { value: 'read', label: 'Read' },
        { value: 'change', label: 'Read and change', disabledWhen: { path: 'readOnly', equals: true }, hint: 'Read-only in Google' },
      ],
      args: { id: { row: 'id' }, access: { choice: true as const } },
    },
  },
};

const PAGE = {
  plugin: 'calendar',
  id: 'settings',
  title: 'Calendar',
  place: 'settings',
  data: { query: 'settings' },
  body: [
    {
      kind: 'section',
      title: 'Calendars',
      actions: [
        {
          kind: 'menu',
          label: 'Add a calendar',
          tone: 'accent',
          items: [
            { label: 'Sign in with Google', hint: 'Read and change your Google calendars', action: { tool: 'calendar.google_sign_in', label: 'Sign in with Google', busy: 'Starting…', args: {} } },
            { label: 'Paste a private link', hint: 'Any calendar, read only', open: 'paste' },
          ],
        },
      ],
      body: [
        list,
        {
          kind: 'form',
          drawer: { title: 'Paste a private link', id: 'paste' },
          fields: [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'link', label: 'Private link', type: 'secret', required: true },
          ],
          submit: { tool: 'calendar.add', label: 'Add the calendar', tone: 'accent', then: 'close', args: { name: { field: 'name' }, link: { field: 'link' } } },
        },
      ],
    },
  ],
} as unknown as PluginPageDescriptor;

const navigate = vi.fn();
const drawPage = (page: PluginPageDescriptor = PAGE) =>
  render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" embedded siblings={[page]} />);

beforeEach(() => {
  vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: { calendars: ROWS } })) as unknown as typeof api.pageQuery);
  vi.mocked(api.pageAct).mockResolvedValue({ result: { note: 'Done.' } } as never);
});
afterEach(() => vi.clearAllMocks());

describe('a grouped list with heads of their own', () => {
  it('draws each group’s words, its aside in its tone and its actions, read against its first row', async () => {
    drawPage();
    const google = await screen.findByRole('region', { name: 'Google · sam@gmail.com' });
    expect(within(google).getByText('Sign-in ran out')).toHaveAttribute('data-tone', 'warning');
    expect(within(google).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    const icloud = screen.getByRole('region', { name: 'iCloud · sam@icloud.com' });
    expect(within(icloud).queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
    expect(within(icloud).getByText('2 calendars · 1 linked')).not.toHaveAttribute('data-tone');
    // A private link has no account: no ⋯ on its group.
    const links = screen.getByRole('region', { name: 'Private links' });
    expect(within(links).queryByRole('button', { name: /More for/ })).not.toBeInTheDocument();
    fireEvent.click(within(google).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_sign_in', args: { account: 'g1' } }));
  });

  it('leads each row with its colour, a hollow dot when it has none or it is not a colour', async () => {
    drawPage();
    const sam = (await screen.findByText('Sam')).closest('.ui-list-row')!;
    const dot = sam.querySelector('.pl-swatch') as HTMLElement;
    expect(dot.style.getPropertyValue('--swatch')).toBe('#039be5');
    expect(dot).not.toHaveAttribute('data-none');
    expect(screen.getByText('Work').closest('.ui-list-row')!.querySelector('.pl-swatch')).toHaveAttribute('data-none', 'true');
    expect(screen.getByText('Gym').closest('.ui-list-row')!.querySelector('.pl-swatch')).toHaveAttribute('data-none', 'true');
  });
});

describe('a row’s choice', () => {
  const choiceOf = async (name: string) => screen.findByRole('radiogroup', { name: `What agents may do with ${name}` });

  it('marks what the row holds, leaves out an option the row cannot take, and greys one with why', async () => {
    drawPage();
    const work = await choiceOf('Work');
    expect(within(work).getByRole('radio', { name: 'Read' })).toHaveAttribute('aria-checked', 'true');
    expect(within(work).getAllByRole('radio')).toHaveLength(3);
    const gym = await choiceOf('Gym');
    expect(within(gym).queryByRole('radio', { name: 'Not linked' })).not.toBeInTheDocument();
    const fr = await choiceOf('Holidays in France');
    const locked = within(fr).getByRole('radio', { name: 'Read and change' });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('title', 'Read-only in Google');
  });

  it.each([
    ['Work', 'Read and change', 'change'],
    ['Work', 'Not linked', 'off'],
    ['Sam', 'Read', 'read'],
  ])('moves %s to %s: the pick shows at once and the tool is sent the row and the option', async (name, label, value) => {
    let answer: (v: unknown) => void = () => undefined;
    vi.mocked(api.pageAct).mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    drawPage();
    const group = await choiceOf(name);
    fireEvent.click(within(group).getByRole('radio', { name: label }));
    expect(within(group).getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.set_access', args: { id: name.toLowerCase(), access: value } }));
    expect(group).toHaveAttribute('aria-busy', 'true');
    await act(async () => answer({ result: { note: 'Done.' } }));
  });

  it('puts the old choice back when the tool refuses, and says why', async () => {
    vi.mocked(api.pageAct).mockRejectedValue(new Error('Google holds Work read-only.'));
    drawPage();
    const work = await choiceOf('Work');
    fireEvent.click(within(work).getByRole('radio', { name: 'Read and change' }));
    expect(await screen.findByText('Google holds Work read-only.')).toBeInTheDocument();
    await waitFor(() => expect(within(work).getByRole('radio', { name: 'Read' })).toHaveAttribute('aria-checked', 'true'));
  });
});

describe('a menu', () => {
  it('runs a tool, or opens a drawer form by its id — which a link can open too', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    drawPage();
    // A drawer opened only from a menu has no button of its own.
    await screen.findByText('Sam');
    expect(screen.queryByRole('button', { name: 'Paste a private link' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a calendar' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Sign in with GoogleRead and change your Google calendars', 'Paste a private linkAny calendar, read only']);
    await user.click(screen.getByRole('menuitem', { name: /Paste a private link/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Paste a private link' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Gym' } });
    fireEvent.change(within(sheet).getByLabelText('Private link'), { target: { value: 'https://example.com/gym.ics' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add the calendar' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.add', args: { name: 'Gym', link: 'https://example.com/gym.ics' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add a calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Sign in with Google/ }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_sign_in', args: {} }));
  }, 180_000);

  it('opens the drawer from the page’s parameters', async () => {
    render(<PluginPage page={PAGE} item={null} navigate={navigate} timezone="UTC" embedded siblings={[PAGE]} params={{ open: 'paste' }} />);
    expect(await screen.findByRole('dialog', { name: 'Paste a private link' })).toBeInTheDocument();
  });

  it('says a refusal under the section’s head', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.pageAct).mockRejectedValue(new Error('This buddi cannot sign in to Google yet.'));
    drawPage();
    await screen.findByText('Sam');
    await user.click(screen.getByRole('button', { name: 'Add a calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Sign in with Google/ }));
    expect(await screen.findByText('This buddi cannot sign in to Google yet.')).toBeInTheDocument();
  }, 180_000);
});

describe('a polled card that finishes by itself', () => {
  const card = (finishOnce = true) =>
    ({
      plugin: 'calendar',
      id: 'settings',
      title: 'Calendar',
      place: 'settings',
      body: [
        {
          kind: 'repeat',
          title: 'Sign in with Google',
          query: { query: 'sign_in' },
          rows: 'rows',
          key: 'id',
          poll: {
            seconds: 1,
            while: { path: 'waiting', equals: true },
            ...(finishOnce
              ? { finish: { when: { path: 'state', equals: 'received' }, action: { tool: 'calendar.google_finish', label: 'Finish signing in', busy: 'Reading your calendars…', args: { id: { row: 'id' } } } } }
              : {}),
          },
          body: [
            { kind: 'notice', text: 'Waiting for Google…', when: { path: 'state', equals: 'waiting' } },
            { kind: 'notice', text: { path: 'note' }, tone: 'good', when: { path: 'state', equals: 'done' } },
            { kind: 'notice', text: 'Paste the address', where: 'remote' },
          ],
        },
      ],
    }) as unknown as PluginPageDescriptor;

  it('asks while the sign-in waits, runs the finish once when the answer comes back, then shows what it kept', async () => {
    let asked = 0;
    let finished = false;
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) => {
      if (query !== 'sign_in') return Promise.resolve({ data: {} });
      asked += 1;
      const state = finished ? 'done' : asked < 3 ? 'waiting' : 'received';
      return Promise.resolve({ data: { waiting: state === 'waiting', rows: [{ id: 'si-1', state, note: 'Signed in as sam@gmail.com: 13 calendars found.' }] } });
    }) as typeof api.pageQuery);
    let answer: (v: unknown) => void = () => undefined;
    vi.mocked(api.pageAct).mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    drawPage(card());
    expect(await screen.findByText('Waiting for Google…')).toBeInTheDocument();
    expect(await screen.findByText('Reading your calendars…', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledTimes(1);
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_finish', args: { id: 'si-1' } });
    finished = true;
    await act(async () => answer({ result: { note: 'ok' } }));
    expect(await screen.findByText('Signed in as sam@gmail.com: 13 calendars found.')).toBeInTheDocument();
    const settled = asked;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(asked).toBe(settled);
    expect(api.pageAct).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does not try a failed finish again for the same sign-in', async () => {
    vi.mocked(api.pageQuery).mockImplementation((() =>
      Promise.resolve({ data: { waiting: false, rows: [{ id: 'si-2', state: 'received' }] } })) as unknown as typeof api.pageQuery);
    vi.mocked(api.pageAct).mockRejectedValue(new Error('buddi signed in, but could not read your Google calendars.'));
    drawPage(card());
    expect(await screen.findByText('buddi signed in, but could not read your Google calendars.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.pageAct).toHaveBeenCalledTimes(1);
  });

  it('finishes the next due row once the first is done and the busy action clears', async () => {
    vi.mocked(api.pageQuery).mockImplementation((() =>
      Promise.resolve({ data: { waiting: false, rows: [{ id: 'si-a', state: 'received' }, { id: 'si-b', state: 'received' }] } })) as unknown as typeof api.pageQuery);
    const answers: Array<(v: unknown) => void> = [];
    vi.mocked(api.pageAct).mockImplementation(() => new Promise((resolve) => answers.push(resolve)) as never);
    drawPage(card());
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledTimes(1));
    expect(api.pageAct).toHaveBeenLastCalledWith('calendar', { tool: 'calendar.google_finish', args: { id: 'si-a' } });
    await act(async () => answers[0]!({ result: { note: 'ok' } }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledTimes(2));
    expect(api.pageAct).toHaveBeenLastCalledWith('calendar', { tool: 'calendar.google_finish', args: { id: 'si-b' } });
    await act(async () => answers[1]!({ result: { note: 'ok' } }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.pageAct).toHaveBeenCalledTimes(2);
  });

  it('draws a `where: remote` piece only away from this computer', async () => {
    vi.mocked(api.pageQuery).mockImplementation((() =>
      Promise.resolve({ data: { waiting: false, rows: [{ id: 'si-3', state: 'waiting' }] } })) as unknown as typeof api.pageQuery);
    expect(isLocalBrowser()).toBe(true);
    const { unmount } = drawPage(card(false));
    expect(await screen.findByText('Waiting for Google…')).toBeInTheDocument();
    expect(screen.queryByText('Paste the address')).not.toBeInTheDocument();
    unmount();
    const where = vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hostname: 'buddi.tailnet.ts.net' } as Location);
    try {
      expect(isLocalBrowser()).toBe(false);
      drawPage(card(false));
      expect(await screen.findByText('Paste the address')).toBeInTheDocument();
    } finally {
      where.mockRestore();
    }
  });
});

describe('an event that opens its own sheet', () => {
  const cal = {
    plugin: 'calendar',
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
        default: 'list',
        count: true,
        sheet: {
          notes: 'notes',
          color: 'color',
          mapHref: 'mapHref',
          open: { label: 'openLabel', href: 'openHref' },
          asks: [
            { label: 'Move or change…', text: 'Move or change “{title}” ({when}) on {calendar}: ' },
            { label: 'Cancel…', text: 'Cancel “{title}” ({when}) on {calendar}.' },
          ],
        },
      },
    ],
  } as unknown as PluginPageDescriptor;
  const EVENTS = {
    events: [
      {
        id: 'e1', title: 'Team lunch', start: '2026-09-28T10:00:00Z', end: '2026-09-28T11:30:00Z', allDay: false, calendar: 'Work', tone: 1,
        location: 'Café Lou', color: '#1f6feb', notes: 'Bring the plan', mapHref: 'https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20Lou',
        openLabel: 'Open in Google Calendar', openHref: 'https://calendar.google.com/calendar/event?eid=x',
      },
      { id: 'e2', title: 'Gym', start: '2026-09-29T16:00:00Z', end: '2026-09-29T17:00:00Z', allDay: false, calendar: 'Gym', tone: 2, location: '', openHref: 'javascript:alert(1)', openLabel: 'Open' },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T08:00:00Z') });
    vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: EVENTS })) as unknown as typeof api.pageQuery);
  });
  afterEach(() => vi.useRealTimers());

  it('counts the range’s events beside its name, and opens an event’s sheet with its time, length, calendar, place, notes and link', async () => {
    render(<PluginPage page={cal} item={null} navigate={navigate} timezone="UTC" siblings={[cal]} />);
    expect(await screen.findByText('2 events')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Team lunch'));
    const sheet = await screen.findByRole('dialog', { name: 'Team lunch' });
    expect(within(sheet).getByText('Mon 28 Sep · 10:00–11:30 · 1 h 30')).toBeInTheDocument();
    expect(within(sheet).getByText('Work').querySelector('.pl-swatch')).toHaveStyle({ '--swatch': '#1f6feb' });
    expect(within(sheet).getByRole('link', { name: /Café Lou/ })).toHaveAttribute('href', EVENTS.events[0]!.mapHref);
    expect(within(sheet).getByText('Bring the plan')).toBeInTheDocument();
    const out = within(sheet).getByRole('link', { name: /Open in Google Calendar/ });
    expect(out).toHaveAttribute('target', '_blank');
    expect(out).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('draws no link that is not https, and asks the corner chat with the request written in', async () => {
    const asked: string[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string; handled: boolean }>).detail;
      detail.handled = true;
      asked.push(detail.text);
    };
    window.addEventListener('buddi:ask', listener);
    try {
      render(<PluginPage page={cal} item={null} navigate={navigate} timezone="UTC" siblings={[cal]} />);
      fireEvent.click(await screen.findByText('Gym'));
      const gym = await screen.findByRole('dialog', { name: 'Gym' });
      expect(within(gym).queryByRole('link')).not.toBeInTheDocument();
      fireEvent.click(within(gym).getByRole('button', { name: 'Close' }));
      fireEvent.click(await screen.findByText('Team lunch'));
      const sheet = await screen.findByRole('dialog', { name: 'Team lunch' });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Move or change…' }));
      expect(asked).toEqual(['Move or change “Team lunch” (Mon 28 Sep · 10:00–11:30 · 1 h 30) on Work: ']);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('buddi:ask', listener);
    }
  });

  it('goes to the chat when no corner buddi takes the request', async () => {
    render(<PluginPage page={cal} item={null} navigate={navigate} timezone="UTC" siblings={[cal]} />);
    fireEvent.click(await screen.findByText('Team lunch'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Team lunch' })).getByRole('button', { name: 'Cancel…' }));
    expect(navigate).toHaveBeenCalledWith('#/chat');
  });
});
