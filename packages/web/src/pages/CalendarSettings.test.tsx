/**
 * Settings → Calendar as the calendar plugin draws it (calendar 0.2.0, host
 * API 1.26), through the generic plugin page: each calendar's own colour as a
 * dot before its name (`swatch`), the "Link with an app password" sheet whose
 * Server address shows only for another CalDAV server, the account calendars'
 * Link / Allow changes / Read only on the rows that offer them — and the
 * approval card an agent's change raises, its lines as the plugin wrote them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type ApprovalRow } from '../api';
import { PluginPage } from './PluginPage';
import { ApprovalCard } from '../views/parts/ApprovalCard';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn(), acceptPluginAgent: vi.fn() },
}));

const SETTINGS = {
  hasAccounts: true,
  defaultService: 'icloud',
  calendars: [
    { id: 'work', name: 'Work', color: '#1f6feb', kind: 'account', provider: 'iCloud · sam@icloud.com', may: [{ value: 'add and change events', tone: 'accent' }] },
    { id: 'holidays', name: 'Holidays', color: '', kind: 'link', provider: 'Google (private link)', may: [{ value: 'read', tone: 'neutral' }] },
    { id: 'odd', name: 'Odd', color: 'url(https://evil.example/x)', kind: 'link', provider: 'Calendar link', may: [{ value: 'read', tone: 'neutral' }] },
  ],
  found: [
    { id: 'work', name: 'Work', color: '#1f6feb', account: 'iCloud · sam@icloud.com', linked: true, writable: true, canAllow: false, state: [{ value: 'linked', tone: 'good' }] },
    { id: 'family', name: 'Family', color: '#e5534b', account: 'iCloud · sam@icloud.com', linked: true, writable: false, canAllow: true, state: [{ value: 'linked', tone: 'good' }] },
    { id: 'home', name: 'Home', color: '#2da44e', account: 'iCloud · sam@icloud.com', linked: false, writable: false, canAllow: false, state: [{ value: 'not linked', tone: 'neutral' }] },
  ],
};

const settingsRef = { query: 'settings' };

/** The plugin's page, as far as this screen goes. */
const PAGE: PluginPageDescriptor = {
  plugin: 'calendar',
  id: 'settings',
  title: 'Calendar',
  place: 'settings',
  data: settingsRef,
  body: [
    {
      kind: 'section',
      title: 'Calendars',
      body: [
        {
          kind: 'table',
          query: settingsRef,
          rows: 'calendars',
          columns: [
            { key: 'name', label: 'Name', swatch: 'color' },
            { key: 'provider', label: 'From' },
            { key: 'may', label: 'Agents may', pill: {} },
          ],
        },
        {
          kind: 'form',
          drawer: { title: 'Link with an app password', button: 'Link with an app password' },
          initial: settingsRef,
          fields: [
            {
              name: 'service', label: 'Service', type: 'select', required: true, from: 'defaultService',
              options: [{ value: 'icloud', label: 'iCloud' }, { value: 'fastmail', label: 'Fastmail' }, { value: 'other', label: 'Another CalDAV server' }],
            },
            { name: 'server', label: 'Server address', type: 'text', when: { path: 'service', equals: 'other' } },
            { name: 'username', label: 'Sign-in name', type: 'text', required: true },
            { name: 'password', label: 'App password', type: 'secret', required: true },
          ],
          submit: {
            tool: 'calendar.link_account', label: 'Sign in and find calendars', tone: 'accent', then: 'close', done: { path: 'note' },
            args: { service: { field: 'service' }, server: { field: 'server' }, username: { field: 'username' }, password: { field: 'password' } },
          },
        },
      ],
    },
    {
      kind: 'section',
      title: 'From your accounts',
      when: { path: 'hasAccounts', equals: true },
      body: [
        {
          kind: 'table',
          query: settingsRef,
          rows: 'found',
          columns: [
            { key: 'name', label: 'Calendar', swatch: 'color' },
            { key: 'state', label: 'State', pill: {} },
          ],
          actions: [
            { tool: 'calendar.allow_changes', label: 'Allow changes', when: { path: 'canAllow', equals: true }, args: { id: { row: 'id' }, writable: { const: true } } },
            { tool: 'calendar.allow_changes', label: 'Read only', when: { path: 'writable', equals: true }, args: { id: { row: 'id' }, writable: { const: false } } },
            { tool: 'calendar.link_calendar', label: 'Link', tone: 'accent', when: { path: 'linked', equals: false }, args: { id: { row: 'id' }, linked: { const: true } } },
          ],
        },
      ],
    },
  ],
};

const navigate = vi.fn();
const drawPage = () => render(<PluginPage page={PAGE} item={null} navigate={navigate} timezone="UTC" siblings={[PAGE]} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: SETTINGS })) as unknown as typeof api.pageQuery);
  vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true, output: { note: 'Signed in.' } } } as never);
});

describe('Settings → Calendar', () => {
  it('draws each calendar’s colour as a dot before its name, and nothing for a value that is not a colour', async () => {
    drawPage();
    const calendars = (await screen.findAllByRole('table'))[0]!;
    const row = (name: string) => within(calendars).getByText(name).closest('td')!;
    await waitFor(() => expect(row('Work').querySelector('.ui-table-swatch')).not.toBeNull());
    const dot = row('Work').querySelector('.ui-table-swatch') as HTMLElement;
    expect(dot.style.getPropertyValue('--swatch')).toBe('#1f6feb');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(row('Holidays').querySelector('.ui-table-swatch')).toBeNull();
    expect(row('Odd').querySelector('.ui-table-swatch')).toBeNull();
    expect(within(calendars).getByText('add and change events')).toBeInTheDocument();
  });

  it('links with an app password: iCloud first, the server address only for another server, sent as typed', async () => {
    drawPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Link with an app password' }));
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect((within(sheet).getByLabelText('Service') as HTMLSelectElement).value).toBe('icloud'));
    expect(within(sheet).queryByLabelText('Server address')).not.toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Service'), { target: { value: 'other' } });
    fireEvent.change(await within(sheet).findByLabelText('Server address'), { target: { value: 'https://cloud.example.com/remote.php/dav' } });
    fireEvent.change(within(sheet).getByLabelText('Sign-in name'), { target: { value: 'sam' } });
    fireEvent.change(within(sheet).getByLabelText('App password'), { target: { value: 'app-pass-word' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign in and find calendars' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('calendar', {
        tool: 'calendar.link_account',
        args: { service: 'other', server: 'https://cloud.example.com/remote.php/dav', username: 'sam', password: 'app-pass-word' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('leaves the server address out for iCloud', async () => {
    drawPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Link with an app password' }));
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect((within(sheet).getByLabelText('Service') as HTMLSelectElement).value).toBe('icloud'));
    fireEvent.change(within(sheet).getByLabelText('Sign-in name'), { target: { value: 'sam@icloud.com' } });
    fireEvent.change(within(sheet).getByLabelText('App password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Sign in and find calendars' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('calendar', {
        tool: 'calendar.link_account',
        args: { service: 'icloud', username: 'sam@icloud.com', password: 'abcd-efgh-ijkl-mnop' },
      }),
    );
  });

  it('offers Allow changes, Read only and Link only on the rows they fit, and sends the row', async () => {
    drawPage();
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2));
    const found = screen.getAllByRole('table')[1]!;
    const rowOf = (name: string) => within(found).getByText(name).closest('tr')!;
    await waitFor(() => expect(within(rowOf('Family')).getByRole('button', { name: 'Allow changes' })).toBeInTheDocument());
    expect(within(rowOf('Work')).queryByRole('button', { name: 'Allow changes' })).not.toBeInTheDocument();
    expect(within(rowOf('Work')).getByRole('button', { name: 'Read only' })).toBeInTheDocument();
    expect(within(rowOf('Home')).getByRole('button', { name: 'Link' })).toBeInTheDocument();
    expect(within(rowOf('Home')).queryByRole('button', { name: 'Read only' })).not.toBeInTheDocument();
    fireEvent.click(within(rowOf('Family')).getByRole('button', { name: 'Allow changes' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.allow_changes', args: { id: 'family', writable: true } }));
  });
});

describe('the card an agent’s change raises', () => {
  const row = (tool: string, preview: string): ApprovalRow => ({
    id: 'act-9', tool, toolVersion: '0.2.0', agentId: 'tempo', conversationId: 'c1', jobId: null, preview, envelope: {}, canonicalArgs: {},
    argsHash: 'abcdef0123456789', policyVersion: 1, state: 'pending', decidedBy: null, decidedVia: null, decidedAt: null,
    expiresAt: '2026-10-06T13:00:00.000Z', createdAt: '2026-10-05T13:00:00.000Z', outcome: null,
  });

  it('shows the change as the plugin wrote it — the calendar, the title, when before → after — and decides it', () => {
    const onDecide = vi.fn();
    const preview = 'Change “Team lunch” on Work (iCloud)\nWhen:  Fri 9 Oct, 12:30–13:30  →  Fri 9 Oct, 13:00–14:00\nWhere: Café Lou  →  (none)';
    render(<ApprovalCard action={row('calendar.update_event', preview)} timezone="America/New_York" busy={false} onDecide={onDecide} agentName="Tempo" />);
    expect(screen.getByText('calendar.update_event')).toBeInTheDocument();
    const block = screen.getByText(/Change “Team lunch” on Work \(iCloud\)/);
    expect(block.textContent).toBe(preview);
    expect(screen.getByText(/asked by Tempo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('act-9', 'approve', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith('act-9', 'reject');
  });

  it('says a series is cancelled whole, on the card itself', () => {
    const preview = 'Cancel “Weekly 1:1” on Work (iCloud)\nRepeats weekly, from Tue 29 Sep, 10:00–10:30\nThe whole series: every occurrence goes.';
    render(<ApprovalCard action={row('calendar.cancel_event', preview)} timezone="UTC" busy={false} onDecide={vi.fn()} />);
    expect(screen.getByText(/The whole series: every occurrence goes\./)).toBeInTheDocument();
  });
});
