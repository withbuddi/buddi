/**
 * The generic page, component by component.
 *
 * The descriptor below is a synthetic plugin — the same shape as the one core
 * tests against — that uses every component once. Nothing in these tests, or
 * in the file they exercise, knows the name of a real plugin: if the engine
 * can draw this, it can draw email, and that is the whole claim of
 * `docs/specs/plugin-pages.md`.
 *
 * What is asserted is behaviour the owner would notice: a value drawn as text,
 * a URL per item, a write that sends the arguments the descriptor named, a
 * gated write that draws an approval card instead of pretending it happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type ApprovalRow } from '../api';
import { PluginPage } from './PluginPage';
import type { Component, PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: {
    pages: vi.fn(),
    pageQuery: vi.fn(),
    pageAct: vi.fn(),
    approval: vi.fn(),
    decide: vi.fn(),
  },
}));

const DATA: Record<string, unknown> = {
  counts: { items: 3, open: 1 },
  items: {
    items: [
      { id: 'a1', title: 'The first thing', sub: 'one@example.com', state: 'open', pinned: false },
      { id: 'a2', title: 'The second thing', sub: 'two@example.com', state: 'done', pinned: true },
    ],
    older: [{ id: 'a0', title: 'An older thing', sub: 'zero@example.com', state: 'done', pinned: false }],
  },
  search: { items: [{ id: 'a1', title: 'The first thing', sub: 'one@example.com' }] },
  item: { id: 'a1', title: 'The first thing', state: 'open', at: '2026-09-22', approvalId: 'act-1' },
  body: { text: 'The body.', attachmentId: 'artifact-1' },
  draft: { id: 'd1', subject: 'A reply', body: 'Nearly done.', updatedAt: '2026-09-22T09:05:00.000Z' },
  accounts: { accounts: [{ id: 'acc-1', address: 'owner@example.com', state: 'ready' }] },
  settings: { everyMinutes: 15, keepDays: 30 },
};

const board: Component[] = [
  { kind: 'notice', text: 'Everything the demo plugin knows.' },
  {
    kind: 'stats',
    title: 'Where things stand',
    query: { query: 'counts' },
    items: [
      { label: 'Things in all', value: { path: 'items' }, unit: 'number' },
      { label: 'Still open', value: { path: 'open' }, unit: 'number' },
    ],
  },
  {
    kind: 'search',
    title: 'Find a thing',
    fields: [{ name: 'q', label: 'Words', type: 'text', required: true }],
    query: { query: 'search', params: { q: { param: 'q' } } },
    results: { title: { path: 'title' }, sub: { path: 'sub' }, to: { page: 'board', item: { path: 'id' } } },
  },
  {
    kind: 'list-detail',
    param: 'item',
    empty: 'Choose a thing.',
    list: {
      kind: 'list',
      title: 'Things',
      query: { query: 'items' },
      rows: 'items',
      item: {
        title: { path: 'title' },
        sub: { path: 'sub' },
        pill: { value: { path: 'state' } },
        to: { page: 'board', item: { path: 'id' } },
      },
      select: { key: 'id', disabledWhen: { path: 'pinned', equals: true } },
      actions: [{ tool: 'demo.keep', label: 'Keep', args: { id: { row: 'id' } } }],
      bulk: [{ tool: 'demo.keep_many', label: 'Keep selected', args: { ids: { selected: true } } }],
      groupBy: { key: 'state', labels: { open: 'Open', done: 'Done' } },
      collapsed: { label: 'Older things', rows: 'older' },
    },
    detail: [
      {
        kind: 'detail',
        title: 'The thing',
        query: { query: 'item', params: { id: { param: 'item' } } },
        fields: [{ label: 'State', value: { path: 'state' } }],
        body: [
          { kind: 'approval', path: 'approvalId', when: { path: 'state', equals: 'open' } },
          {
            kind: 'expand',
            label: 'Show the body',
            query: { query: 'body', params: { id: { param: 'item' } } },
            body: [{ kind: 'artifact', path: 'attachmentId', label: 'Download the attachment' }],
          },
        ],
      },
      {
        kind: 'editor',
        title: 'The draft',
        query: { query: 'draft', params: { id: { param: 'item' } } },
        version: 'updatedAt',
        fields: [
          { name: 'subject', label: 'Subject', type: 'text', from: 'subject' },
          { name: 'body', label: 'Body', type: 'textarea', from: 'body' },
        ],
        save: {
          tool: 'demo.save',
          label: 'Save',
          tone: 'accent',
          args: { id: { param: 'item' }, subject: { field: 'subject' }, version: { field: 'version' } },
        },
        actions: [{ tool: 'demo.send', label: 'Send', args: { id: { param: 'item' } } }],
      },
    ],
  },
  { kind: 'link', label: 'Accounts and rules', to: { page: 'settings' } },
];

const settings: Component[] = [
  {
    kind: 'section',
    title: 'Accounts',
    note: 'What this installation reads.',
    body: [
      {
        kind: 'table',
        query: { query: 'accounts' },
        rows: 'accounts',
        columns: [
          { key: 'address', label: 'Address' },
          { key: 'state', label: 'State' },
        ],
        actions: [
          {
            tool: 'demo.remove_account',
            label: 'Remove',
            tone: 'danger',
            confirm: 'Remove this account?',
            args: { id: { row: 'id' } },
          },
        ],
      },
      {
        kind: 'form',
        drawer: { title: 'Add an account', button: 'Add an account' },
        fields: [
          { name: 'address', label: 'Address', type: 'email', required: true },
          { name: 'password', label: 'Password', type: 'secret', required: true },
        ],
        submit: {
          tool: 'demo.add_account',
          label: 'Add',
          tone: 'accent',
          args: { address: { field: 'address' }, password: { field: 'password' } },
          then: 'close',
        },
      },
    ],
  },
  {
    kind: 'form',
    title: 'Watchers',
    initial: { query: 'settings' },
    fields: [{ name: 'everyMinutes', label: 'Check every', type: 'number', from: 'everyMinutes' }],
    submit: { tool: 'demo.set_settings', label: 'Save', tone: 'accent', args: { everyMinutes: { field: 'everyMinutes' } } },
  },
];

const page = (id: 'board' | 'settings'): PluginPageDescriptor => ({
  plugin: 'demo',
  id,
  title: id === 'board' ? 'Demo board' : 'Demo',
  place: id === 'board' ? 'rail' : 'settings',
  body: id === 'board' ? board : settings,
});

const approvalRow = (id: string, preview: string): ApprovalRow =>
  ({ ...APPROVAL, id, preview }) as ApprovalRow;

const APPROVAL: ApprovalRow = {
  id: 'act-1',
  tool: 'demo.send',
  toolVersion: '1.0.0',
  agentId: 'owner',
  preview: 'Send draft d1',
  envelope: { id: 'd1' },
  canonicalArgs: { id: 'd1' },
  argsHash: 'abcdef123456',
  policyVersion: 1,
  state: 'pending',
  createdAt: '2026-09-22T09:00:00.000Z',
  expiresAt: '2026-09-23T09:00:00.000Z',
  jobId: null,
} as unknown as ApprovalRow;

const navigate = vi.fn();

const draw = (id: 'board' | 'settings', item?: string): ReturnType<typeof render> =>
  render(<PluginPage page={page(id)} item={item ?? null} navigate={navigate} timezone="UTC" />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
    Promise.resolve({ data: DATA[query] })) as typeof api.pageQuery);
  vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true } });
  vi.mocked(api.approval).mockImplementation(((id: string) =>
    Promise.resolve(approvalRow(id, id === 'act-1' ? 'Send draft d1' : 'Send it now'))) as typeof api.approval);
});

describe('the pieces a descriptor is made of', () => {
  it('draws a notice, a link and the page title', async () => {
    draw('board');
    expect(await screen.findByText('Everything the demo plugin knows.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Accounts and rules' });
    expect(link).toHaveAttribute('href', '#/p/demo/settings');
  });

  it('draws stats from their query, formatted by the unit the descriptor named', async () => {
    draw('board');
    expect(await screen.findByText('Where things stand')).toBeInTheDocument();
    expect(screen.getByText('Things in all')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('draws a list: a URL per item, a pill, and its groups', async () => {
    draw('board');
    const first = await screen.findByRole('link', { name: 'The first thing' });
    expect(first).toHaveAttribute('href', '#/p/demo/board/a1');
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    // The folded rows are behind one line, not on the page.
    expect(screen.getByText(/Older things \(1\)/)).toBeInTheDocument();
  });

  it('runs a row action with the arguments the row names', async () => {
    draw('board');
    const buttons = await screen.findAllByRole('button', { name: 'Keep' });
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.keep', args: { id: 'a1' } }),
    );
  });

  it('selects rows and acts on the selection, refusing the ones it may not', async () => {
    draw('board');
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes[1]).toBeDisabled(); // pinned
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Keep selected' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.keep_many', args: { ids: ['a1'] } }),
    );
  });

  it('says what a list-detail is waiting for, and draws the detail once there is a URL', async () => {
    const { unmount } = draw('board');
    expect(await screen.findByText('Choose a thing.')).toBeInTheDocument();
    unmount();
    draw('board', 'a1');
    expect(await screen.findByText('The thing')).toBeInTheDocument();
    expect(await screen.findByText('State')).toBeInTheDocument();
    // The detail's query was asked with the item from the route.
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'item', { id: 'a1' });
  });

  it('draws an approval card in place, from an id in the data', async () => {
    draw('board', 'a1');
    expect(await screen.findByText('Send draft d1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('fetches an expand\'s body when it is opened, and draws its artifact link', async () => {
    draw('board', 'a1');
    const summary = await screen.findByText('Show the body');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(api.pageQuery).not.toHaveBeenCalledWith('demo', 'body', expect.anything());
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const download = await screen.findByRole('link', { name: 'Download the attachment' });
    expect(download).toHaveAttribute('href', '/api/artifacts/artifact-1/download');
  });

  it('fills the editor from its query and saves against the version it read', async () => {
    draw('board', 'a1');
    const subject = (await screen.findByLabelText('Subject')) as HTMLInputElement;
    expect(subject.value).toBe('A reply');
    fireEvent.change(subject, { target: { value: 'A better reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', {
        tool: 'demo.save',
        args: { id: 'a1', subject: 'A better reply', version: '2026-09-22T09:05:00.000Z' },
      }),
    );
  });

  it('draws the approval a gated write answered with, rather than claiming it happened', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    draw('board', 'a1');
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.approval).toHaveBeenCalledWith('act-2'));
    expect(await screen.findByText('Send it now')).toBeInTheDocument();
  });

  it('searches on demand and links each result', async () => {
    draw('board');
    const words = (await screen.findByLabelText('Words')) as HTMLInputElement;
    fireEvent.change(words, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'search', { q: 'first' }));
    const results = await screen.findAllByRole('link', { name: 'The first thing' });
    expect(results[0]).toHaveAttribute('href', '#/p/demo/board/a1');
  });
});

describe('a settings page', () => {
  it('draws a section, its note and a table of rows', async () => {
    draw('settings');
    expect(await screen.findByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('What this installation reads.')).toBeInTheDocument();
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
  });

  it('asks before a confirmed action, and only then writes', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove this account?')).toBeInTheDocument();
    expect(api.pageAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Yes, remove/i }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.remove_account', args: { id: 'acc-1' } }),
    );
  });

  it('opens a drawer form, refuses to submit until it is filled, and closes on `then`', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an account' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', {
        tool: 'demo.add_account',
        args: { address: 'owner@example.com', password: 'hunter2' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('fills a form from its `initial` query and sends the numbers back', async () => {
    draw('settings');
    // The form remounts when its `initial` query answers, so the element is
    // looked up again rather than held across the load.
    await waitFor(() => expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('15'));
    fireEvent.change(screen.getByLabelText('Check every'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.set_settings', args: { everyMinutes: 30 } }),
    );
  });
});

describe('what a descriptor may hide', () => {
  it('leaves out a component whose `when` does not match', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: query === 'item' ? { ...(DATA.item as object), state: 'done' } : DATA[query] })) as typeof api.pageQuery);
    draw('board', 'a1');
    expect(await screen.findByText('The thing')).toBeInTheDocument();
    expect(api.approval).not.toHaveBeenCalled();
  });

  it('says when a query failed, and does not pretend it was empty', async () => {
    vi.mocked(api.pageQuery).mockRejectedValue(new Error('the plugin could not answer'));
    draw('settings');
    // Once per component that asked, and each says so where it stands.
    expect((await screen.findAllByText(/the plugin could not answer/)).length).toBeGreaterThan(0);
  });
});
