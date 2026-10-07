/**
 * The generic page, component by component.
 *
 * The descriptor below is a synthetic plugin — the same shape as the one core
 * tests against — that uses every component once. Nothing in these tests, or
 * in the file they exercise, knows the name of a real plugin: if the engine
 * can draw this, it can draw email, and that is the whole claim of
 * `docs/plugin-pages.md`.
 *
 * What is asserted is behaviour the owner would notice: a value drawn as text,
 * a URL per item, a write that sends the arguments the descriptor named, a
 * gated write that draws an approval card instead of pretending it happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type ApprovalRow } from '../api';
import { PluginPage } from './PluginPage';
import { resetPlayer } from './play';
import type { Component, PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: {
    pages: vi.fn(),
    pageQuery: vi.fn(),
    pageAct: vi.fn(),
    approval: vi.fn(),
    approvals: vi.fn(),
    decide: vi.fn(),
    acceptPluginAgent: vi.fn(),
  },
}));

const DATA: Record<string, unknown> = {
  counts: { items: 3, open: 1, state: 'ready', headline: 'Three things, one of them open.' },
  items: {
    items: [
      { id: 'a1', title: 'The first thing', sub: 'one@example.com', state: 'open', tone: 'warning', pinned: false },
      { id: 'a2', title: 'The second thing', sub: 'two@example.com', state: 'done', tone: 'good', pinned: true },
    ],
    older: [{ id: 'a0', title: 'An older thing', sub: 'zero@example.com', state: 'done', pinned: false }],
  },
  search: { items: [{ id: 'a1', title: 'The first thing', sub: 'one@example.com' }], total: 9, note: 'The newest nine.' },
  nothing: { items: [], total: 0, note: 'The newest nine.' },
  item: { id: 'a1', title: 'The first thing', state: 'open', at: '2026-09-22', approvalId: 'act-1', holder: 'ada' },
  body: { text: 'The body.', attachmentId: 'artifact-1' },
  messages: {
    messages: [
      { id: 'm1', from: 'Ada, on Tuesday', attachmentId: 'artifact-1' },
      { id: 'm2', from: 'Bo, on Wednesday', attachmentId: null },
    ],
  },
  drafts: { drafts: [{ id: 'd1', subject: 'A reply', state: 'draft' }] },
  draft: { id: 'd1', subject: 'A reply', body: 'Nearly done.', updatedAt: '2026-09-22T09:05:00.000Z', locked: false },
  accounts: {
    accounts: [
      {
        id: 'acc-1',
        address: 'owner@example.com',
        host: 'imap.example.com:993 · smtp.example.com:465',
        password: 'In the vault',
        secretName: 'EMAIL_OWNER_b68f74ea',
        state: 'ready',
        tone: 'good',
        states: [{ value: 'ready', tone: 'good' }],
      },
      {
        id: 'acc-2',
        address: 'old@example.com',
        state: 'locked',
        tone: 'critical',
        states: [
          { value: 'off', tone: 'critical' },
          { value: 'from .env', tone: 'neutral' },
        ],
      },
    ],
  },
  settings: { everyMinutes: 15, keepDays: 30 },
};

const board: Component[] = [
  { kind: 'notice', text: { path: 'headline' }, when: { path: 'state', equals: 'ready' } },
  { kind: 'notice', text: 'Only when it is not ready.', when: { path: 'state', equals: 'ready', not: true } },
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
    rows: 'items',
    count: 'total',
    note: 'note',
    reset: true,
    results: { title: { path: 'title' }, sub: { path: 'sub' } },
    to: { page: 'board', item: { path: 'id' } },
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
      key: 'id',
      item: {
        title: { path: 'title' },
        sub: { path: 'sub' },
        pill: { value: { path: 'state' }, tone: { path: 'tone' } },
        pills: [{ value: { path: 'sub' }, tone: 'neutral' }],
        to: { page: 'board', item: { path: 'id' } },
      },
      select: { key: 'id', disabledWhen: { path: 'pinned', equals: true } },
      actions: [{ tool: 'demo.keep', label: 'Keep', args: { id: { row: 'id' } } }],
      bulk: [
        {
          tool: 'demo.keep_many',
          all: true,
          label: 'Keep {count} {thing|things}',
          confirm: 'Keep {count} {thing|things}?',
          args: { ids: { selected: true } },
        },
      ],
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
          { kind: 'approval', path: 'approvalId', when: { path: 'state', in: ['open', 'waiting'] } },
          // The one link that leaves the plugin: an agent's chat, named by a
          // path into the data rather than by a URL the descriptor wrote.
          { kind: 'link', label: 'The agent that holds it', to: { chat: { path: 'holder' } } },
          // …and the same link over a field the data does not answer.
          { kind: 'link', label: 'Nobody holds it', to: { chat: { path: 'nobody' } } },
          // The other: the owner's Proposals inbox, filtered to this plugin.
          { kind: 'link', label: 'Proposed rules', to: { proposals: true } },
        ],
      },
      {
        kind: 'repeat',
        title: 'The messages',
        query: { query: 'messages', params: { id: { param: 'item' } } },
        rows: 'messages',
        key: 'id',
        body: [
          {
            kind: 'expand',
            label: { path: 'from' },
            query: { query: 'body', params: { id: { path: 'id' } } },
            body: [{ kind: 'notice', text: 'Fetched when you opened it.' }],
          },
          {
            kind: 'button',
            when: { path: 'attachmentId', equals: null },
            action: { tool: 'demo.fetch', label: 'Fetch what {from} sent', args: { id: { path: 'id' } } },
          },
          {
            kind: 'artifact',
            when: { path: 'attachmentId', equals: null, not: true },
            path: 'attachmentId',
            label: 'Download the attachment',
          },
        ],
      },
      {
        kind: 'list-detail',
        param: 'draft',
        selection: 'local',
        empty: 'Choose a draft.',
        list: {
          kind: 'list',
          title: 'Drafts',
          query: { query: 'drafts', params: { id: { param: 'item' } } },
          rows: 'drafts',
          key: 'id',
          item: { title: { path: 'subject' }, pill: { value: { path: 'state' }, tone: 'accent' } },
        },
        detail: [
          {
            kind: 'editor',
            title: 'The draft',
            query: { query: 'draft', params: { id: { param: 'draft' } } },
            version: 'updatedAt',
            readOnlyWhen: { path: 'locked', equals: true },
            footnote: 'Send does not send: it asks you to approve the dispatch.',
            fields: [
              { name: 'subject', label: 'Subject', type: 'text', from: 'subject' },
              { name: 'body', label: 'Body', type: 'textarea', from: 'body' },
            ],
            save: {
              tool: 'demo.save',
              label: 'Save',
              tone: 'accent',
              busy: 'Saving…',
              args: { id: { param: 'draft' }, subject: { field: 'subject' }, version: { field: 'version' } },
            },
            actions: [
              {
                tool: 'demo.discard',
                label: 'Discard',
                tone: 'danger',
                placement: 'leading',
                args: { id: { param: 'draft' } },
                then: { route: { page: 'board' } },
              },
              {
                tool: 'demo.send',
                label: 'Send',
                done: { path: 'message' },
                pending: 'Nothing has been sent yet.',
                args: { id: { param: 'draft' } },
              },
            ],
          },
        ],
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
    actions: [{ kind: 'link', label: 'The board', to: { page: 'board' } }],
    body: [
      {
        kind: 'table',
        query: { query: 'accounts' },
        rows: 'accounts',
        columns: [
          { key: 'address', label: 'Address', fit: 'wrap' },
          { key: 'host', label: 'Host', fit: 'truncate' },
          { key: 'password', label: 'Password', hint: 'secretName' },
          { key: 'state', label: 'State', pill: { tone: { path: 'tone' } } },
          { key: 'states', label: 'Also', pill: {} },
        ],
        actions: [
          {
            tool: 'demo.remove_account',
            label: 'Remove',
            tone: 'danger',
            confirm: 'Remove {address}?',
            when: { path: 'state', equals: 'ready' },
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
          { name: 'advanced', label: 'Give the hosts myself', type: 'checkbox' },
          { name: 'imapHost', label: 'IMAP host', type: 'text', when: { path: 'advanced', equals: true } },
        ],
        submit: {
          tool: 'demo.add_account',
          label: 'Add',
          tone: 'accent',
          done: 'The mailbox was added.',
          args: { address: { field: 'address' }, password: { field: 'password' }, imapHost: { field: 'imapHost' } },
          then: 'close',
        },
      },
    ],
  },
  {
    // A picker, not a search box: it asks again on every change.
    kind: 'search',
    title: 'Things by state',
    auto: true,
    fields: [
      {
        name: 'state',
        label: 'State',
        type: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'done', label: 'Done' },
        ],
      },
    ],
    query: { query: 'items', params: { state: { param: 'state' } } },
    rows: 'items',
    results: { title: { path: 'title' } },
  },
  {
    kind: 'form',
    title: 'Rules',
    drawer: { title: 'Add a rule', button: 'Add a rule' },
    fields: [
      {
        name: 'account',
        label: 'Mailbox',
        type: 'select',
        required: true,
        optionsFrom: { query: { query: 'accounts' }, rows: 'accounts', value: 'id', label: 'address' },
      },
      {
        name: 'state',
        label: 'State',
        type: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'done', label: 'Done' },
        ],
      },
      { name: 'everything', label: 'Everything in the mailbox', type: 'checkbox' },
      {
        name: 'note',
        label: 'Why',
        type: 'text',
        required: true,
        when: { path: 'everything', equals: true },
      },
      {
        name: 'thing',
        label: 'Thing',
        type: 'select',
        required: true,
        when: { path: 'everything', equals: true, not: true },
        optionsFrom: {
          query: { query: 'items' },
          rows: 'items',
          value: 'id',
          label: 'title',
          dependsOn: ['state'],
        },
      },
    ],
    submit: {
      tool: 'demo.add_rule',
      label: 'Add',
      tone: 'accent',
      done: { path: 'message' },
      args: { account: { field: 'account' }, thing: { field: 'thing' }, note: { field: 'note' } },
      then: 'close',
    },
  },
  {
    kind: 'form',
    title: 'Watchers',
    initial: { query: 'settings' },
    fields: [
      { name: 'pause', label: 'Pause the watchers', type: 'checkbox' },
      {
        name: 'everyMinutes',
        label: 'Check every',
        type: 'number',
        from: 'everyMinutes',
        disabledWhen: { path: 'pause', equals: true },
      },
      { name: 'keepDays', label: 'Keep for', type: 'number' },
    ],
    submit: {
      tool: 'demo.set_settings',
      label: 'Save',
      tone: 'accent',
      args: { everyMinutes: { field: 'everyMinutes' }, keepDays: { field: 'keepDays' } },
    },
  },
];

const page = (id: 'board' | 'settings'): PluginPageDescriptor => ({
  plugin: 'demo',
  id,
  title: id === 'board' ? 'Demo board' : 'Demo',
  place: id === 'board' ? 'rail' : 'settings',
  // The page's own read: what the top-level `when`s are about.
  ...(id === 'board' ? { data: { query: 'counts' } } : {}),
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
  render(
    <PluginPage
      page={page(id)}
      item={item ?? null}
      navigate={navigate}
      timezone="UTC"
      siblings={[page('board'), page('settings')]}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
    Promise.resolve({ data: DATA[query] })) as typeof api.pageQuery);
  vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true } });
  vi.mocked(api.approvals).mockResolvedValue({ pending: [], recent: [] });
  vi.mocked(api.approval).mockImplementation(((id: string) =>
    Promise.resolve(approvalRow(id, id === 'act-1' ? 'Send draft d1' : 'Send it now'))) as typeof api.approval);
});

describe('the pieces a descriptor is made of', () => {
  it('draws a notice, a link and the page title', async () => {
    draw('board');
    expect(await screen.findByText('Everything the demo plugin knows.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Accounts and rules' });
    expect(link).toHaveAttribute('href', '#/settings/p.demo.settings');
  });

  /**
   * The one route that leaves the plugin.
   *
   * `{ chat }` names an **agent id out of the data**, not a URL and not a page
   * of anybody's: the descriptor says "whoever holds this", and the engine
   * works out which conversation that is. Everything else about a link is
   * unchanged — a plugin still cannot point the owner at a core screen.
   */
  it('links to an agent’s chat, from an id the data carries', async () => {
    draw('board', 'a1');
    const link = await screen.findByRole('link', { name: 'The agent that holds it' });
    expect(link).toHaveAttribute('href', '#/chat/ada');
  });

  /**
   * And no link at all when the data does not answer one. A button that
   * navigates to the empty hash — which is what returning `''` used to do —
   * is worse than no button: the shell re-renders on a route to nowhere.
   */
  it('links to the Proposals inbox filtered to the plugin drawing the page', async () => {
    draw('board', 'a1');
    const link = await screen.findByRole('link', { name: 'Proposed rules' });
    expect(link).toHaveAttribute('href', '#/settings/proposals?plugin=demo');
  });

  it('draws no link when the chat id is missing', async () => {
    draw('board', 'a1');
    await screen.findByRole('link', { name: 'The agent that holds it' });
    expect(screen.queryByRole('link', { name: 'Nobody holds it' })).toBeNull();
  });

  it('draws stats from their query, formatted by the unit the descriptor named', async () => {
    draw('board');
    expect(await screen.findByText('Where things stand')).toBeInTheDocument();
    // The stats come from their own query, after the page itself.
    expect(await screen.findByText('Things in all')).toBeInTheDocument();
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
    // The first box is the header's select-all; then one per row.
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes[2]).toBeDisabled(); // pinned
    fireEvent.click(boxes[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Keep 1 thing' }));
    // The sentence counts what is actually selected, and says "thing" for one.
    expect(screen.getByText('Keep 1 thing?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Yes, keep 1 thing/i }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.keep_many', args: { ids: ['a1'] } }),
    );
  });

  it('draws a sub-tree per row, each labelled and acting on its own row', async () => {
    draw('board', 'a1');
    // The fold carries the row's own words.
    expect(await screen.findByText('Ada, on Tuesday')).toBeInTheDocument();
    expect(screen.getByText('Bo, on Wednesday')).toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'messages', { id: 'a1' });
    // One row has a file and shows the link; the other has none and offers to
    // fetch it — the same block, under a `when`.
    expect(screen.getByRole('link', { name: 'Download the attachment' })).toHaveAttribute(
      'href',
      '/api/artifacts/artifact-1/download',
    );
    // A button's words read the row it stands in, like a row action's.
    const fetchButtons = screen.getAllByRole('button', { name: 'Fetch what Bo, on Wednesday sent' });
    expect(fetchButtons).toHaveLength(1);
    fireEvent.click(fetchButtons[0] as HTMLElement);
    await waitFor(() =>
      // Its arguments came from the row it stands in.
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.fetch', args: { id: 'm2' } }),
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

  it('fetches an expand\'s body only when it is opened', async () => {
    draw('board', 'a1');
    const summary = (await screen.findByText('Ada, on Tuesday')) as HTMLElement;
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(api.pageQuery).not.toHaveBeenCalledWith('demo', 'body', expect.anything());
    details.open = true;
    fireEvent(details, new Event('toggle'));
    // Asked with the row's own id, not the page's item.
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'body', { id: 'm1' }));
    expect(await screen.findByText('Fetched when you opened it.')).toBeInTheDocument();
  });

  /** Open the local list-detail on the one draft, which is where the editor is. */
  const openDraft = async (): Promise<void> => {
    fireEvent.click(await screen.findByRole('link', { name: /^A reply/ }));
  };

  it('chooses inside a routed detail without touching the URL', async () => {
    draw('board', 'a1');
    expect(await screen.findByText('Choose a draft.')).toBeInTheDocument();
    await openDraft();
    expect(await screen.findByLabelText('Subject')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // The inner selection is what the editor's query was asked with.
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'draft', { id: 'd1' });
  });

  it('fills the editor from its query and saves against the version it read', async () => {
    draw('board', 'a1');
    await openDraft();
    const subject = (await screen.findByLabelText('Subject')) as HTMLInputElement;
    expect(subject.value).toBe('A reply');
    fireEvent.change(subject, { target: { value: 'A better reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', {
        tool: 'demo.save',
        args: { id: 'd1', subject: 'A better reply', version: '2026-09-22T09:05:00.000Z' },
      }),
    );
  });

  it('shows what is there now under the sentence saying why the save was refused', async () => {
    let subject = 'A reply';
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({
        data: query === 'draft' ? { ...(DATA.draft as object), subject } : DATA[query],
      })) as typeof api.pageQuery);
    vi.mocked(api.pageAct).mockRejectedValue(new Error('That draft has moved on since you opened it.'));
    draw('board', 'a1');
    await openDraft();
    // Somebody else edits it while the owner is typing.
    subject = 'What it actually says now';
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    // The refusal stays on the page…
    expect(await screen.findByText('That draft has moved on since you opened it.')).toBeInTheDocument();
    // …and the editor re-reads, so the owner sees what they are up against.
    await waitFor(() =>
      expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('What it actually says now'),
    );
    expect(screen.getByText('That draft has moved on since you opened it.')).toBeInTheDocument();
  });

  it('draws the approval a gated write answered with, rather than claiming it happened', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.approval).toHaveBeenCalledWith('act-2'));
    expect(await screen.findByText('Send it now')).toBeInTheDocument();
  });

  it('holds what `then` asked for until the approval has actually executed', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    vi.mocked(api.decide).mockResolvedValue({
      action: approvalRow('act-2', 'Send it now'),
      execution: { state: 'succeeded' },
    } as never);
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    // A gated answer: nothing has happened, so `then: { route }` has not run.
    expect(navigate).not.toHaveBeenCalled();
    // The card this action is waiting on, not the one the descriptor draws
    // from the item's own data.
    const card = (await screen.findByText('Send it now')).closest('.ui-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/p/demo/board'));
  });

  it('keeps a pending approval when the decision itself failed', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    vi.mocked(api.decide).mockRejectedValue(new Error('the gateway is restarting'));
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    const card = (await screen.findByText('Send it now')).closest('.ui-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalled());
    // Nothing was decided: the card is still there, and so is what it was
    // going to do next.
    expect(await screen.findByText('Send it now')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says what a gated write did, out of what the approval executed', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    vi.mocked(api.decide).mockResolvedValue({
      action: approvalRow('act-2', 'Send it now'),
      execution: { state: 'succeeded', result: { message: 'Sent, and the thread has it.' } },
    } as never);
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const card = (await screen.findByText('Send it now')).closest('.ui-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    // The sentence is the tool's own, and it only becomes true here.
    expect(await screen.findByText('Sent, and the thread has it.')).toBeInTheDocument();
  });

  it('draws a gated action\'s pending sentence above its card while it waits, and drops it once decided', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    vi.mocked(api.decide).mockResolvedValue({
      action: approvalRow('act-2', 'Send it now'),
      execution: { state: 'succeeded', result: { message: 'Sent.' } },
    } as never);
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const sentence = await screen.findByText('Nothing has been sent yet.');
    const card = (await screen.findByText('Send it now')).closest('.ui-card') as HTMLElement;
    // Above the card, in reading order.
    expect(sentence.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Sent.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been sent yet.')).not.toBeInTheDocument();
  });

  it('draws no pending sentence for a gated action that names none', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Send it now')).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been sent yet.')).not.toBeInTheDocument();
  });

  it('draws a draft\'s pill in the accent: it is the thing on this screen', async () => {
    draw('board', 'a1');
    const pill = (await screen.findByText('draft')) as HTMLElement;
    expect(pill).toHaveAttribute('data-tone', 'accent');
  });

  it('does not act on `then` when the approval was rejected', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ approvalId: 'act-2', preview: 'Send it now' });
    vi.mocked(api.decide).mockResolvedValue({
      action: approvalRow('act-2', 'Send it now'),
      execution: null,
    } as never);
    draw('board', 'a1');
    await openDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    const card = (await screen.findByText('Send it now')).closest('.ui-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('draws an editor the data says is a record: no fields to type in, and no buttons', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({
        data: query === 'draft' ? { ...(DATA.draft as object), locked: true } : DATA[query],
      })) as typeof api.pageQuery);
    draw('board', 'a1');
    await openDraft();
    expect(await screen.findByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/Send does not send/)).toBeInTheDocument();
  });

  it('draws no row it cannot key, and says which descriptor is at fault', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({
        data:
          query === 'items'
            ? {
                items: [
                  { id: 'a1', title: 'The first thing', state: 'open', pinned: false },
                  { title: 'A thing with no id', state: 'open', pinned: false },
                  { id: 'a1', title: 'The same id again', state: 'open', pinned: false },
                ],
                older: [],
              }
            : DATA[query],
      })) as typeof api.pageQuery);
    draw('board');
    expect(await screen.findByText('The first thing')).toBeInTheDocument();
    // Neither the keyless row nor the repeated key is drawn — a row keyed by
    // its position is how the owner ticks one thing and sends another.
    expect(screen.queryByText('A thing with no id')).not.toBeInTheDocument();
    expect(screen.queryByText('The same id again')).not.toBeInTheDocument();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('plugin demo') && line.includes('page board') && line.includes('no value at'))).toBe(true);
    expect(lines.some((line) => line.includes('two rows share the key "a1"'))).toBe(true);
    warn.mockRestore();
  });

  it('puts the editor\'s buttons in the order the house rule asks for', async () => {
    draw('board', 'a1');
    await openDraft();
    const toolbar = (await screen.findByRole('button', { name: 'Save' })).closest('.ui-toolbar') as HTMLElement;
    const labels = [...toolbar.querySelectorAll('button')].map((b) => b.textContent);
    // Discard on the left, then Save, then Send: the thing that leaves the
    // room is last, and the editor's own primary is under the thumb.
    expect(labels).toEqual(['Discard', 'Save', 'Send']);
  });

  it('draws every pill a row carries, in the tone the row itself names', async () => {
    draw('board');
    const row = (await screen.findByText('The first thing')).closest('.ui-list-row') as HTMLElement;
    const pills = [...row.querySelectorAll('.ui-pill')];
    expect(pills.map((p) => p.textContent)).toEqual(['open', 'one@example.com']);
    expect(pills[0]).toHaveAttribute('data-tone', 'warning');
  });

  it('ticks every row at once, and offers a bulk action over all of them', async () => {
    draw('board');
    /*
     * Nothing ticked: `all` makes the button about every row the owner may
     * act on — the two unpinned ones, the folded one included — and the words
     * agree with the number.
     */
    expect(await screen.findByRole('button', { name: 'Keep 2 things' })).toBeEnabled();
    expect(screen.getByText('2 to choose from')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every row' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep 2 things' }));
    expect(screen.getByText('Keep 2 things?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Yes, keep 2 things/i }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.keep_many', args: { ids: ['a1', 'a0'] } }),
    );
  });

  it('says "1 thing" when there is one of it', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({
        data: query === 'items' ? { items: (DATA.items as { items: unknown[] }).items, older: [] } : DATA[query],
      })) as typeof api.pageQuery);
    draw('board');
    expect(await screen.findByRole('button', { name: 'Keep 1 thing' })).toBeInTheDocument();
  });

  it('links to a page that lives in Settings as the tab it is', async () => {
    draw('board');
    expect(await screen.findByRole('link', { name: 'Accounts and rules' })).toHaveAttribute(
      'href',
      '#/settings/p.demo.settings',
    );
  });

  it('searches on demand and links each result', async () => {
    draw('board');
    const words = (await screen.findByLabelText('Words')) as HTMLInputElement;
    fireEvent.change(words, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'search', { q: 'first' }));
    const results = await screen.findAllByRole('link', { name: 'The first thing' });
    expect(results[0]).toHaveAttribute('href', '#/p/demo/board/a1');
    // The count and the caveat the query answered with.
    expect(await screen.findByText(/9 in all/)).toBeInTheDocument();
    expect(screen.getByText(/The newest nine/)).toBeInTheDocument();
    // And Clear empties the field and the results with it.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((screen.getByLabelText('Words') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.queryByText(/9 in all/)).not.toBeInTheDocument());
  });

  it('says what the answer is, even when the answer is nothing', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: query === 'search' ? DATA.nothing : DATA[query] })) as typeof api.pageQuery);
    draw('board');
    fireEvent.change(await screen.findByLabelText('Words'), { target: { value: 'nothing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    // The caveat is as true of an empty answer as of a full one.
    expect(await screen.findByText(/The newest nine/)).toBeInTheDocument();
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });

  it('draws what the page\'s own read says, and hides what it does not', async () => {
    draw('board');
    expect(await screen.findByText('Three things, one of them open.')).toBeInTheDocument();
    expect(screen.queryByText('Only when it is not ready.')).not.toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'counts', {});
  });
});

describe('a settings page', () => {
  it('draws a section, its note and a table of rows', async () => {
    draw('settings');
    expect(await screen.findByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('What this installation reads.')).toBeInTheDocument();
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
  });

  it('offers a row action only where the descriptor says, and names the row', async () => {
    draw('settings');
    // Two accounts, one of them locked: one Remove, and it says which.
    const removes = await screen.findAllByRole('button', { name: 'Remove' });
    expect(removes).toHaveLength(1);
    const cells = [...document.querySelectorAll('.ui-table tbody tr')].map((tr) => tr.textContent);
    expect(cells[1]).toContain('old@example.com');
    expect(cells[1]).not.toContain('Remove');
    // And the state is a pill in the tone the row carried.
    const pill = document.querySelector('.ui-table .ui-pill') as HTMLElement;
    expect(pill.textContent).toBe('ready');
    expect(pill).toHaveAttribute('data-tone', 'good');
  });

  it('keeps long cells inside the table: wrapped, cut with a tooltip, or short with the detail on hover', async () => {
    draw('settings');
    const address = (await screen.findByText('owner@example.com')).closest('td') as HTMLElement;
    expect(address).toHaveAttribute('data-fit', 'wrap');
    const host = screen.getAllByText('imap.example.com:993 · smtp.example.com:465')[0]!.closest('td') as HTMLElement;
    expect(host).toHaveAttribute('data-fit', 'truncate');
    expect(host).toHaveAttribute('title', 'imap.example.com:993 · smtp.example.com:465');
    const password = screen.getAllByText('In the vault')[0]!.closest('td') as HTMLElement;
    expect(password).toHaveAttribute('title', 'EMAIL_OWNER_b68f74ea');
    expect(password.textContent).toBe('In the vault');
  });

  it('draws a section\'s own action beside its heading', async () => {
    draw('settings');
    const head = (await screen.findByText('Accounts')).closest('.ui-section-head') as HTMLElement;
    expect(within(head).getByRole('link', { name: 'The board' })).toHaveAttribute('href', '#/p/demo/board');
    expect(head.closest('.ui-panel')).toBeNull();
  });

  it('asks before a confirmed action, and only then writes', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove owner@example.com?')).toBeInTheDocument();
    expect(api.pageAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Yes, remove/i }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.remove_account', args: { id: 'acc-1' } }),
    );
  });

  it('reveals a field as the box beside it is ticked, with no round trip', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an account' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('IMAP host')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(dialog).getByLabelText('Give the hosts myself')); });
    expect(within(dialog).getByLabelText('IMAP host')).toBeInTheDocument();
  });

  it('disables a field from the form\'s own values, live', async () => {
    draw('settings');
    await waitFor(() => expect(screen.getByLabelText('Check every')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Pause the watchers'));
    expect(screen.getByLabelText('Check every')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Pause the watchers'));
    expect(screen.getByLabelText('Check every')).toBeEnabled();
  });

  it('reads a select\'s options from a query, and again when what it depends on changes', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a rule' }));
    const dialog = await screen.findByRole('dialog');
    const mailbox = within(dialog).getByLabelText('Mailbox');
    await waitFor(() => expect(within(mailbox).getByText('owner@example.com')).toBeInTheDocument());
    // The dependent select asked with no state to begin with…
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'items', {}));
    fireEvent.change(within(dialog).getByLabelText('State'), { target: { value: 'done' } });
    // …and again with the value the owner chose.
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'items', { state: 'done' }));
  });

  it('says what a write did, in the tool\'s own words', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: { message: 'Rule added for a1.' } });
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a rule' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Mailbox')).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText('Mailbox'), { target: { value: 'acc-1' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Thing')).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText('Thing'), { target: { value: 'a1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Rule added for a1.')).toBeInTheDocument();
  });

  it('does not ask for a field nobody can see, and does not send it either', async () => {
    draw('settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a rule' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Mailbox')).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText('Mailbox'), { target: { value: 'acc-1' } });
    // The other branch: `Why` is required, `Thing` is not asked for at all.
    fireEvent.click(within(dialog).getByLabelText('Everything in the mailbox'));
    expect(within(dialog).queryByLabelText('Thing')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: 'It is all mine.' } });
    // One required field filled, the other one hidden: the form submits…
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() =>
      // …and the hidden field is not in the arguments at all.
      expect(api.pageAct).toHaveBeenCalledWith('demo', {
        tool: 'demo.add_rule',
        args: { account: 'acc-1', note: 'It is all mine.' },
      }),
    );
  });

  it('draws every state of a row as its own pill', async () => {
    draw('settings');
    await screen.findByText('old@example.com');
    const row = [...document.querySelectorAll('.ui-table tbody tr')][1] as HTMLElement;
    const pills = [...row.querySelectorAll('.ui-pill')].map((p) => [p.textContent, p.getAttribute('data-tone')]);
    expect(pills).toEqual([
      ['locked', 'critical'],
      ['off', 'critical'],
      ['from .env', null],
    ]);
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
        // `imapHost` is behind "Give the hosts myself", which nobody ticked:
        // the owner said nothing about it, so it is not sent at all.
        args: { address: 'owner@example.com', password: 'hunter2' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks again on every change when the picker says `auto`', async () => {
    draw('settings');
    const picker = await screen.findByLabelText('State');
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'done' } });
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'items', { state: 'done' }));
  });

  it('fills a form from its `initial` query and sends the numbers back', async () => {
    draw('settings');
    // The form remounts when its `initial` query answers, so the element is
    // looked up again rather than held across the load.
    await waitFor(() => expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('15'));
    fireEvent.change(screen.getByLabelText('Check every'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // `keepDays` was never touched, so it is not sent at all: an empty number
    // field is the owner saying nothing, not the number zero or the string ''.
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

describe('a sensitive query', () => {
  const money: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'money',
    title: 'Money',
    place: 'rail',
    sensitive: ['settings'],
    body: [
      { kind: 'notice', text: 'Balances below.' },
      {
        kind: 'section',
        title: 'Balances',
        body: [{ kind: 'stats', query: { query: 'settings' }, items: [{ label: 'Every', value: { path: 'everyMinutes' } }] }],
      },
      { kind: 'stats', title: 'Loose', query: { query: 'settings' }, items: [{ label: 'Keep', value: { path: 'keepDays' } }] },
      {
        kind: 'section',
        title: 'Plain',
        body: [{ kind: 'stats', query: { query: 'counts' }, items: [{ label: 'Things', value: { path: 'items' } }] }],
      },
    ],
  };
  const drawMoney = (): ReturnType<typeof render> =>
    render(<PluginPage page={money} navigate={navigate} timezone="UTC" siblings={[money]} />);
  const asked = (): string[] => vi.mocked(api.pageQuery).mock.calls.map((call) => call[1] as string);

  it('masks every section that reads it, and asks for nothing until shown', async () => {
    drawMoney();
    expect(await screen.findByText('Things')).toBeInTheDocument();
    expect(screen.getAllByText('Hidden until you show it.')).toHaveLength(2);
    expect(screen.queryByText('Every')).not.toBeInTheDocument();
    expect(asked()).not.toContain('settings');

    const section = screen.getByRole('heading', { name: 'Balances' }).closest('section') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Every')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Hide' })).not.toHaveAttribute('aria-pressed');
    // The loose one has its own Show, and stays masked.
    expect(screen.queryByText('Keep')).not.toBeInTheDocument();
  });

  it('masks it again when the window is left', async () => {
    drawMoney();
    const section = (await screen.findByRole('heading', { name: 'Balances' })).closest('section') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Every')).toBeInTheDocument();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(screen.queryByText('Every')).not.toBeInTheDocument());
    visibility.mockRestore();
  });

  it('masks a section whose own query is sensitive, and asks for it only after Show', async () => {
    const own: PluginPageDescriptor = {
      ...money,
      body: [
        {
          kind: 'section',
          title: 'Own',
          query: { query: 'settings' },
          body: [{ kind: 'notice', text: { path: 'everyMinutes' } }],
        },
        { kind: 'notice', text: 'Drawn.' },
      ],
    };
    render(<PluginPage page={own} navigate={navigate} timezone="UTC" siblings={[own]} />);
    expect(await screen.findByText('Drawn.')).toBeInTheDocument();
    expect(screen.getByText('Hidden until you show it.')).toBeInTheDocument();
    expect(asked()).not.toContain('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('15')).toBeInTheDocument();
    expect(asked()).toContain('settings');
  });

  it('leaves a page with no sensitive query exactly as it was', async () => {
    draw('board');
    expect(await screen.findByText('Things in all')).toBeInTheDocument();
    expect(screen.queryByText('Hidden until you show it.')).not.toBeInTheDocument();
  });
});

describe('a list-detail switching conversations', () => {
  const threads: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'inbox',
    title: 'Inbox',
    place: 'rail',
    body: [
      {
        kind: 'list-detail',
        param: 'item',
        list: { kind: 'list', query: { query: 'items' }, rows: 'items', key: 'id', item: { title: { path: 'title' }, to: { page: 'inbox', item: { path: 'id' } } } },
        detail: [
          {
            kind: 'detail',
            title: 'The thread',
            query: { query: 'item', params: { id: { param: 'item' } } },
            fields: [{ label: 'Title', value: { path: 'title' } }],
            body: [{ kind: 'button', action: { tool: 'demo.archive', label: 'Archive {title}', args: { id: { path: 'id' } } } }],
          },
        ],
      },
    ],
  };

  it("never draws the last thread's buttons while the next one loads", async () => {
    let release: (value: { data: unknown }) => void = () => undefined;
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string, params?: Record<string, string>) => {
      if (query === 'item' && params?.id === 'a2') return new Promise<{ data: unknown }>((resolve) => { release = resolve; });
      if (query === 'item') return Promise.resolve({ data: { id: 'a1', title: 'Thread one' } });
      return Promise.resolve({ data: DATA[query] });
    }) as unknown as typeof api.pageQuery);
    const view = render(<PluginPage page={threads} item="a1" navigate={navigate} timezone="UTC" siblings={[threads]} />);
    expect(await screen.findByRole('button', { name: 'Archive Thread one' })).toBeInTheDocument();

    view.rerender(<PluginPage page={threads} item="a2" navigate={navigate} timezone="UTC" siblings={[threads]} />);
    expect(screen.queryByRole('button', { name: 'Archive Thread one' })).not.toBeInTheDocument();
    expect(screen.queryByText('Thread one')).not.toBeInTheDocument();

    await act(async () => release({ data: { id: 'a2', title: 'Thread two' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Thread two' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.archive', args: { id: 'a2' } }),
    );
  });
});

describe('the page as the design system draws it', () => {
  const mailish: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'inbox',
    title: 'Inbox',
    place: 'rail',
    body: [
      { kind: 'notice', text: 'What the demo has read.' },
      {
        kind: 'search',
        fields: [
          { name: 'q', label: 'Text', type: 'text', hint: 'A word in it' },
          { name: 'from', label: 'From', type: 'text', hint: 'An address' },
          { name: 'files', label: 'With files', type: 'checkbox' },
        ],
        query: { query: 'search', params: { q: { param: 'q' }, from: { param: 'from' }, files: { param: 'files' } } },
        rows: 'items',
        reset: true,
        results: { title: { path: 'title' } },
      },
      {
        kind: 'list-detail',
        param: 'item',
        empty: 'Choose a thing to read it here.',
        list: {
          kind: 'list',
          query: { query: 'items' },
          rows: 'items',
          key: 'id',
          item: {
            title: { path: 'sub' },
            sub: { path: 'title' },
            meta: [{ path: 'id' }],
            pills: [
              {
                value: { path: 'state' },
                labels: { open: 'Waiting on you', done: 'Finished' },
                tones: { open: 'warning' },
              },
            ],
            to: { page: 'inbox', item: { path: 'id' } },
          },
        },
        detail: [{ kind: 'notice', text: 'The detail.' }],
      },
    ],
  };
  const drawInbox = (item?: string): ReturnType<typeof render> =>
    render(<PluginPage page={mailish} item={item ?? null} navigate={navigate} timezone="UTC" siblings={[mailish]} />);

  it('makes a leading notice the page intro, one line under the title', async () => {
    const { container } = drawInbox();
    expect((await screen.findByText('What the demo has read.')).className).toBe('ui-page-lede');
    expect(container.querySelector('.ui-notice')).toBeNull();
  });

  it('keeps the filters behind Filters, and searches on Enter', async () => {
    drawInbox();
    const text = (await screen.findByLabelText('Text')) as HTMLInputElement;
    // The hint is the placeholder, not a line under the field.
    expect(text).toHaveAttribute('placeholder', 'A word in it');
    expect(screen.queryByText('A word in it')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    const filters = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(filters);
    expect(filters).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'acme.com' } });
    fireEvent.change(text, { target: { value: 'invoice' } });
    fireEvent.submit(text.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(api.pageQuery).toHaveBeenCalledWith('demo', 'search', { q: 'invoice', from: 'acme.com', files: 'false' }),
    );
  });

  it('shows a filter that is on as a chip that takes itself off', async () => {
    drawInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByLabelText('With files'));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From: acme.com')).toBeInTheDocument();
    expect([...document.querySelectorAll('.ui-chip')].map((chip) => chip.firstChild?.textContent)).toEqual([
      'From: acme.com',
      'With files',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove From' }));
    await waitFor(() => expect(screen.queryByText('From: acme.com')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(api.pageQuery).toHaveBeenLastCalledWith('demo', 'search', { files: 'true' }),
    );
  });

  it('draws the list beside its reading pane as the roster draws rows, in the words the descriptor gives', async () => {
    drawInbox('a1');
    const row = (await screen.findByText('one@example.com')).closest('a') as HTMLElement;
    expect(row).toHaveClass('ui-pick');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveAttribute('href', '#/p/demo/inbox/a1');
    const pill = within(row).getByText('Waiting on you');
    expect(pill).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByText('Finished')).not.toHaveAttribute('data-tone');
    expect(screen.queryByText('open')).not.toBeInTheDocument();
    expect(await screen.findByText('The detail.')).toBeInTheDocument();
  });

  it('says what to do in the reading pane while nothing is chosen', async () => {
    drawInbox();
    const empty = await screen.findByText('Choose a thing to read it here.');
    expect(empty.closest('.ui-split-detail')).toHaveAttribute('data-empty', 'true');
  });
});

/*
 * An agent the plugin proposes, offered where it is needed: the line, and the
 * same accept the Plugins page runs. The click is the approval: the agent comes
 * back, and the line says it is ready.
 */
describe('an agent offer', () => {
  const offerPage: PluginPageDescriptor = {
    plugin: 'email',
    id: 'settings',
    title: 'Email',
    place: 'settings',
    data: { query: 'mailboxes' },
    body: [
      {
        kind: 'agent-offer',
        agent: 'mail-triage',
        text: 'Mail arrives, but nobody sorts it as it lands: no labels, no “needs a reply”, no drafts waiting. buddi and your other agents still read mail when you ask.',
        label: 'Create @mail',
        when: { path: 'triage', equals: 'needs-agent' },
      },
      { kind: 'notice', text: 'Mailboxes.' },
    ],
  } as PluginPageDescriptor;

  const drawOffer = (triage: string): ReturnType<typeof render> => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { triage } } as never);
    return render(<PluginPage page={offerPage} navigate={navigate} timezone="UTC" />);
  };

  it('says the line, creates the agent in one click, and says it is ready', async () => {
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({
      approvalId: 'act-9',
      agent: { id: 'mail-triage', handle: 'mail', name: 'Mail' },
    });
    drawOffer('needs-agent');
    expect(await screen.findByText('Mail arrives, but nobody sorts it as it lands: no labels, no “needs a reply”, no drafts waiting. buddi and your other agents still read mail when you ask.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create @mail' }));
    await waitFor(() => expect(api.acceptPluginAgent).toHaveBeenCalledWith('email', 'mail-triage'));
    expect(await screen.findByText(/@mail is ready/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talk to @mail' })).toHaveAttribute('href', '#/chat/mail-triage');
    // No second step: no card is drawn.
    expect(api.approval).not.toHaveBeenCalled();
    expect(api.pageAct).not.toHaveBeenCalled();
  });

  it('draws the card the gateway raised in place of the button, and approving it is the one click', async () => {
    const raised = {
      ...APPROVAL,
      id: 'act-raised',
      tool: 'platform.accept_plugin_agent',
      preview: 'The email plugin (1.0.0) proposes an agent',
      canonicalArgs: { plugin: 'email', agent: 'mail-triage' },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as ApprovalRow;
    vi.mocked(api.approvals).mockResolvedValue({ pending: [raised], recent: [] });
    vi.mocked(api.decide).mockResolvedValue({ action: raised, execution: { state: 'succeeded' } } as never);
    drawOffer('needs-agent');
    expect(await screen.findByText('The email plugin (1.0.0) proposes an agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create @mail' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalled());
    expect(vi.mocked(api.decide).mock.calls[0]![0]).toBe('act-raised');
    expect(await screen.findByText(/@mail is ready/)).toBeInTheDocument();
    expect(api.acceptPluginAgent).not.toHaveBeenCalled();
  });

  it('is not there once the agent is', async () => {
    drawOffer('ready');
    expect(await screen.findByText('Mailboxes.')).toBeInTheDocument();
    expect(screen.queryByText('Mail arrives, but nobody sorts it as it lands: no labels, no “needs a reply”, no drafts waiting. buddi and your other agents still read mail when you ask.')).not.toBeInTheDocument();
  });
});

describe('a repeat that polls', () => {
  it('asks its own query again while its answer says so, and stops once it does not', async () => {
    let calls = 0;
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) => {
      if (query !== 'downloads') return Promise.resolve({ data: DATA[query] });
      calls += 1;
      const busy = calls < 3;
      return Promise.resolve({
        data: { busy, rows: [{ id: 'm', line: busy ? `Downloading: ${calls * 30}%` : 'Installed, 92 MB' }] },
      });
    }) as typeof api.pageQuery);
    const polled: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [
        {
          kind: 'repeat',
          query: { query: 'downloads' },
          rows: 'rows',
          key: 'id',
          poll: { seconds: 1, while: { path: 'busy', equals: true } },
          body: [{ kind: 'notice', text: { path: 'line' } }],
        },
      ],
    };
    render(<PluginPage page={polled} item={null} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('Downloading: 30%')).toBeInTheDocument();
    expect(await screen.findByText('Installed, 92 MB', undefined, { timeout: 4000 })).toBeInTheDocument();
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(calls).toBe(settled);
  }, 10_000);

  it('draws progress as the install does: the label, a bar and "7 of 252 MB · 2%", then the done line', async () => {
    let bytes = 7_400_000;
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) => {
      if (query !== 'downloads') return Promise.resolve({ data: DATA[query] });
      return Promise.resolve({ data: { rows: [{ id: 'w', bytes, total: 252_000_000, label: 'Whisper on this computer · listening' }] } });
    }) as typeof api.pageQuery);
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [
        {
          kind: 'repeat',
          query: { query: 'downloads' },
          rows: 'rows',
          key: 'id',
          body: [
            { kind: 'progress', value: { path: 'bytes' }, total: { path: 'total' }, label: { path: 'label' }, done: 'Installed, 252 MB' },
            { kind: 'progress', value: { const: 0.5 }, label: 'Half' },
          ],
        },
      ],
    };
    const { unmount } = render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    const bar = await screen.findByRole('progressbar', { name: 'Whisper on this computer · listening' });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('Whisper on this computer · listening')).toBeInTheDocument();
    expect(screen.getByText('7 of 252 MB · 2%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Half' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    unmount();

    bytes = 252_000_000;
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('Installed, 252 MB')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Whisper on this computer · listening' })).not.toBeInTheDocument();
  });
});

describe('a chart', () => {
  it('draws a goal the way the Goals page asks: the values as a line with the target dashed, the weeks as bars', async () => {
    let values: unknown[] = [
      { at: '2026-09-01', value: 82 },
      { at: '2026-09-08', value: 81.2 },
      { at: '2026-09-15', value: 'n/a' },
      { at: '2026-09-22', value: 80.4 },
    ];
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) => {
      if (query === 'goal') return Promise.resolve({ data: { target: 78, values } });
      if (query === 'weeks') return Promise.resolve({ data: [{ week: '2026-09-07', count: 2 }, { week: '2026-09-14', count: 3 }] });
      return Promise.resolve({ data: DATA[query] });
    }) as typeof api.pageQuery);
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'board',
      title: 'Goals',
      place: 'rail',
      body: [
        { kind: 'chart', title: 'Over the window', query: { query: 'goal' }, rows: 'values', x: 'at', y: 'value', label: 'Weight', target: { path: 'target' }, empty: 'No values yet.' },
        { kind: 'chart', title: 'Per week', query: { query: 'weeks' }, x: 'week', y: 'count', type: 'bar', label: 'Runs' },
      ],
    };
    const { unmount } = render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    const line = await screen.findByText(/^Weight, 4 points from/);
    const figure = line.closest('figure')!;
    expect(figure).toHaveAttribute('data-type', 'line');
    // The row that said "n/a" is a gap, not a zero: two strokes.
    expect(figure.querySelector('.ui-chart-line')!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
    expect(within(figure as HTMLElement).getByTestId('chart-target')).toBeInTheDocument();
    expect(line).toHaveTextContent('latest 80.4, lowest 80.4, highest 82. Target 78.');
    const bars = (await screen.findByText(/^Runs, 2 points/)).closest('figure')!;
    expect(bars).toHaveAttribute('data-type', 'bar');
    expect(bars.querySelectorAll('.ui-chart-bar')).toHaveLength(2);
    unmount();

    values = [];
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('No values yet')).toBeInTheDocument();
    expect(screen.getAllByTestId('chart-svg')).toHaveLength(1);
  });
});

describe('a forecast page: tabs with a pick, a hero, tiles and a two-kind chart', () => {
  const HOURS = (date: string) => ['00:00', '06:00', '12:00', '18:00'].map((time, i) => ({ time: `${date} ${time}`, icon: i === 2 ? 'sun' : 'cloud', value: `${10 + i}°`, rain: `Rain ${i * 10}%`, temp: 10 + i, chance: i * 10 }));
  const page: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'sky',
    title: 'Sky',
    place: 'rail',
    icon: 'cloud',
    body: [
      {
        kind: 'tabs',
        pick: { param: 'place', label: 'Place', optionsFrom: { query: { query: 'places' }, rows: 'places', value: 'id', label: 'label' } },
        tabs: [
          {
            id: 'today',
            label: 'Today',
            body: [
              { kind: 'hero', query: { query: 'today', params: { place: { param: 'place' } } }, icon: { path: 'icon' }, value: 'now', title: 'sky', facts: [{ label: 'Feels like', path: 'feels' }, { label: 'Wind', path: 'wind' }, { label: 'Missing', path: 'nope' }] },
              { kind: 'chart', title: 'By the hour', query: { query: 'hours', params: { place: { param: 'place' } } }, rows: 'hours', x: 'time', series: [{ y: 'temp', type: 'line', label: 'Temperature' }, { y: 'chance', type: 'bar', label: 'Chance of rain', unit: 'percent' }] },
            ],
          },
          {
            id: 'week',
            label: 'Week',
            body: [
              { kind: 'tiles', query: { query: 'days', params: { place: { param: 'place' } } }, items: 'days', icon: { path: 'icon' }, value: 'value', label: 'label', lines: ['rain'], layout: 'row', select: { param: 'date', key: 'date' } },
              { kind: 'tiles', title: 'By the hour', query: { query: 'hours', params: { place: { param: 'place' }, date: { param: 'date' } } }, items: 'hours', icon: { path: 'icon' }, value: 'value', label: 'time', lines: ['rain'], layout: 'strip' },
            ],
          },
        ],
      },
    ],
  };
  const asked: Array<[string, Record<string, string> | undefined]> = [];
  beforeEach(() => {
    asked.length = 0;
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string, params?: Record<string, string>) => {
      asked.push([query, params]);
      const place = params?.place ?? 'home';
      if (query === 'places') return Promise.resolve({ data: { places: [{ id: 'home', label: 'Home' }, { id: 'work', label: 'Work' }] } });
      if (query === 'today') return Promise.resolve({ data: { icon: place === 'home' ? 'sun' : 'storm', now: place === 'home' ? '18°' : '24°', sky: 'Clear', feels: '17°', wind: '12 km/h' } });
      if (query === 'days') return Promise.resolve({ data: { days: ['2026-09-28', '2026-09-29', '2026-09-30'].map((date, i) => ({ date, icon: 'sun', value: `2${i}° / 1${i}°`, label: i === 0 ? 'Today' : date, rain: `Rain ${i}0%` })) } });
      if (query === 'hours') return Promise.resolve({ data: { hours: HOURS(params?.date ?? '2026-09-28') } });
      return Promise.resolve({ data: DATA[query] });
    }) as typeof api.pageQuery);
  });

  it('opens on the first tab and the first place: the hero with its facts, and a line over percent bars', async () => {
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    const hero = await screen.findByLabelText('18°, Clear, Feels like 17°, Wind 12 km/h');
    expect(hero.querySelector('.pg-hero-value')).toHaveTextContent('18°');
    // A fact whose path answers nothing is left out, not drawn empty.
    expect(within(hero).queryByText('Missing')).not.toBeInTheDocument();
    const figure = (await screen.findByText(/^Chart, 4 points/)).closest('figure')!;
    expect(figure).toHaveAttribute('data-type', 'mixed');
    expect(figure.querySelectorAll('.ui-chart-line')).toHaveLength(1);
    // Zero is no bar; the right scale reads 0–100%.
    expect(figure.querySelectorAll('.ui-chart-bar')).toHaveLength(3);
    expect(within(figure as HTMLElement).getByText('100%')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Home' })).toHaveAttribute('aria-checked', 'true');
  });

  it('asks again for the place the owner picks, and draws only the chosen tab', async () => {
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    await screen.findByLabelText(/^18°/);
    fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    expect(await screen.findByLabelText(/^24°/)).toBeInTheDocument();
    expect(asked).toContainEqual(['today', { place: 'work' }]);
    expect(asked.some(([query]) => query === 'days')).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Week' }));
    expect(await screen.findByRole('button', { name: 'Today, 20° / 10°, Rain 00%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText(/^24°/)).not.toBeInTheDocument();
    expect(asked).toContainEqual(['days', { place: 'work' }]);
  });

  it('writes the picked tile into the page parameter, which the strip below reads', async () => {
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Week' }));
    const tuesday = await screen.findByRole('button', { name: /^2026-09-29, 21°/ });
    const list = tuesday.closest('ul')!;
    expect(list).toHaveAttribute('data-layout', 'row');
    // Until the owner picks, the first day is chosen, and the strip below is its hours.
    expect(await screen.findByText('2026-09-28 12:00, 12°, Rain 20%')).toBeInTheDocument();
    fireEvent.click(tuesday);
    await waitFor(() => expect(tuesday).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByText('2026-09-29 12:00, 12°, Rain 20%')).toBeInTheDocument();
    expect(asked).toContainEqual(['hours', { date: '2026-09-29' }]);
    expect(screen.getByText('2026-09-29 12:00, 12°, Rain 20%').closest('ul')).toHaveAttribute('data-layout', 'strip');
  });

  it('draws one tab with a pick as the pick alone: a filter over one view (Mail: All · Needs a reply · Notifications)', async () => {
    const filtered: PluginPageDescriptor = {
      ...page,
      body: [
        {
          kind: 'tabs',
          pick: { param: 'place', label: 'Show', options: [{ value: 'home', label: 'All' }, { value: 'work', label: 'Needs a reply' }] },
          tabs: [{ id: 'one', label: 'One', body: [(page.body[0] as any).tabs[0].body[0]] }],
        },
      ],
    };
    const { container } = render(<PluginPage page={filtered} item={null} navigate={navigate} timezone="UTC" />);
    await screen.findByLabelText(/^18°/);
    expect(screen.queryByRole('radio', { name: 'One' })).not.toBeInTheDocument();
    expect(container.querySelector('.pg-tabs-bar')).toHaveAttribute('data-only', 'pick');
    fireEvent.click(screen.getByRole('radio', { name: 'Needs a reply' }));
    expect(await screen.findByLabelText(/^24°/)).toBeInTheDocument();
    expect(asked).toContainEqual(['today', { place: 'work' }]);
  });

  it('gives a list-detail inside a tab the route item, so the open item reaches its detail (the Mail page)', async () => {
    const mail: PluginPageDescriptor = {
      ...page,
      body: [
        {
          kind: 'tabs',
          pick: { param: 'place', label: 'Show', options: [{ value: 'home', label: 'All' }, { value: 'work', label: 'Needs a reply' }] },
          tabs: [
            {
              id: 'one',
              label: 'One',
              body: [
                {
                  kind: 'list-detail',
                  param: 'thread',
                  list: { kind: 'list', query: { query: 'places' }, rows: 'places', key: 'id', item: { title: { path: 'label' }, to: { page: 'sky', item: { path: 'id' } } } },
                  detail: [{ kind: 'detail', title: 'One place', query: { query: 'today', params: { thread: { param: 'thread' } } }, fields: [{ label: 'Sky', value: { path: 'sky' } }], body: [] }],
                  empty: 'Choose one.',
                },
              ],
            },
          ],
        },
      ],
    };
    render(<PluginPage page={mail} item="work" navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('Clear')).toBeInTheDocument();
    expect(asked).toContainEqual(['today', { thread: 'work' }]);
  });
});

describe('a series panel', () => {
  const page: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'day',
    title: 'Day',
    place: 'rail',
    body: [
      {
        kind: 'series-panel',
        title: 'Today',
        query: { query: 'hours' },
        points: 'hours',
        x: 'time',
        series: [
          { id: 'temp', label: 'Temperature', y: 'temp', unit: 'temp', kind: 'area' },
          { id: 'rain', label: 'Rain', y: 'chance', unit: 'percent', kind: 'bars' },
        ],
        tiles: { icon: { path: 'icon' }, value: 'value', label: 'time', lines: ['rain'] },
      },
    ],
  };
  const HOURS = [14, 16, 17, 15, 12, 11].map((temp, i) => ({ time: i === 0 ? 'Now' : `1${i}:00`, icon: 'cloud', value: `${temp}°`, rain: `Rain ${i * 10}%`, temp, chance: i * 10 }));

  it('draws the chart and the strip from the same points, one panel, one mark', async () => {
    vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: { hours: HOURS } })) as unknown as typeof api.pageQuery);
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    const tiles = await screen.findAllByRole('button', { name: /°, Rain/ });
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(HOURS.map((h) => `${h.time}, ${h.value}, ${h.rain}`));
    const panel = tiles[0]!.closest('.ui-panel')!;
    expect(within(panel as HTMLElement).getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    const svg = within(panel as HTMLElement).getByTestId('series-svg');
    expect([...svg.querySelectorAll('.pg-series-value')].map((t) => t.textContent)).toEqual(['14°', '15°']);
    fireEvent.mouseEnter(svg.querySelector('.pg-series-hit[data-index="4"]')!);
    expect(tiles[4]).toHaveAttribute('data-hover', 'true');
    expect(svg.querySelector('.pg-series-dot[data-hover="true"]')).toHaveAttribute('data-index', '4');
  });
});

describe('a form three to a row', () => {
  it('passes `columns` to the grid, and leaves the default grid alone', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: DATA[query] })) as typeof api.pageQuery);
    const form = (columns?: 2 | 3): Component => ({
      kind: 'form',
      ...(columns ? { columns } : {}),
      fields: [
        { name: 'a', label: columns ? 'Three A' : 'Two A', type: 'text' },
        { name: 'b', label: 'B', type: 'text' },
        { name: 'c', label: 'C', type: 'text' },
      ],
      submit: { tool: 'demo.save', label: 'Save' },
    });
    const page: PluginPageDescriptor = { plugin: 'demo', id: 'settings', title: 'Demo', place: 'settings', body: [form(3), form()] };
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    expect((await screen.findByLabelText('Three A')).closest('.ui-formgrid')).toHaveAttribute('data-columns', '3');
    expect(screen.getByLabelText('Two A').closest('.ui-formgrid')).not.toHaveAttribute('data-columns');
  });
});

describe('a select with several choices', () => {
  it('starts from the array it reads, and submits what is picked as an array', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: query === 'prefs' ? { languages: ['fr'] } : DATA[query] })) as typeof api.pageQuery);
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [
        {
          kind: 'form',
          initial: { query: 'prefs' },
          fields: [
            {
              name: 'languages',
              label: 'Languages you speak',
              type: 'select',
              multiple: true,
              from: 'languages',
              options: [
                { value: 'en', label: 'English' },
                { value: 'fr', label: 'French' },
                { value: 'es', label: 'Spanish' },
              ],
            },
          ],
          submit: { tool: 'demo.save', label: 'Save', args: { languages: { field: 'languages' } } },
        },
      ],
    };
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    // Drawn as chips, not a scrolling box.
    expect(await screen.findByRole('button', { name: 'Remove French' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Languages you speak' })).toBeInTheDocument();
    expect(document.querySelector('select[multiple]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    const list = screen.getByRole('listbox', { name: 'Languages you speak' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    fireEvent.click(within(list).getByRole('option', { name: 'English' }));
    // The order it was picked in.
    expect(screen.getByRole('button', { name: 'Remove English' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.save', args: { languages: ['fr', 'en'] } }),
    );
  });

  it('greys Add at `max` and says why in the hint', async () => {
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: query === 'prefs' ? { languages: ['fr', 'en'] } : DATA[query] })) as typeof api.pageQuery);
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [
        {
          kind: 'form',
          initial: { query: 'prefs' },
          fields: [
            {
              name: 'languages',
              label: 'Languages you speak',
              type: 'select',
              multiple: true,
              max: 2,
              hint: 'None lets the service detect.',
              from: 'languages',
              options: [
                { value: 'en', label: 'English' },
                { value: 'fr', label: 'French' },
                { value: 'es', label: 'Spanish' },
              ],
            },
          ],
          submit: { tool: 'demo.save', label: 'Save', args: { languages: { field: 'languages' } } },
        },
      ],
    };
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByRole('button', { name: 'Remove English' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add…' })).toBeDisabled();
    expect(screen.getByText('None lets the service detect. Up to 2; remove one to add another.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove English' }));
    expect(screen.getByRole('button', { name: 'Add…' })).toBeEnabled();
    expect(screen.getByText('None lets the service detect.')).toBeInTheDocument();
  });
});

describe('a sound a tool answers with', () => {
  /** One fake `Audio`: what it was given, and a way to end it. */
  class FakeAudio {
    static last: FakeAudio | null = null;
    src = '';
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    constructor() {
      FakeAudio.last = this;
    }
  }
  const SOUND = { play: { mime: 'audio/ogg', data: btoa('OggS fake opus') }, message: 'Alloy, with OpenAI.' };

  beforeEach(() => {
    FakeAudio.last = null;
    resetPlayer();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:sound'), revokeObjectURL: vi.fn() }));
    vi.mocked(api.pageQuery).mockImplementation(((_plugin: string, query: string) =>
      Promise.resolve({ data: query === 'prefs' ? { backend: 'openai', voice: 'alloy' } : DATA[query] })) as typeof api.pageQuery);
  });

  afterEach(() => {
    resetPlayer();
    vi.unstubAllGlobals();
  });

  const voicePage = (action: Record<string, unknown>): PluginPageDescriptor => ({
    plugin: 'demo',
    id: 'settings',
    title: 'Demo',
    place: 'settings',
    body: [
      {
        kind: 'form',
        initial: { query: 'prefs' },
        fields: [
          { name: 'backend', label: 'Service', type: 'select', from: 'backend', options: [{ value: 'openai', label: 'OpenAI' }] },
          {
            name: 'voice',
            label: 'Voice',
            type: 'select',
            from: 'voice',
            options: [
              { value: 'alloy', label: 'Alloy' },
              { value: 'nova', label: 'Nova' },
            ],
            action: action as never,
          },
        ],
        submit: { tool: 'demo.save', label: 'Save', args: { voice: { field: 'voice' } } },
      },
    ],
  });

  it('plays the unsaved choice in the browser, spins while asked, and stops when pressed again', async () => {
    let answer: (value: unknown) => void = () => undefined;
    vi.mocked(api.pageAct).mockImplementation(() => new Promise((resolve) => (answer = resolve as never)));
    render(
      <PluginPage
        page={voicePage({ tool: 'demo.preview', label: 'Play a sample', icon: 'play', args: { backend: { field: 'backend' }, voice: { field: 'voice' } } })}
        item={null}
        navigate={navigate}
        timezone="UTC"
      />,
    );
    // The form is drawn again once its `initial` answers: ask for the select after that.
    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue('alloy'));
    const voice = screen.getByLabelText('Voice');
    // Changed, and not saved.
    fireEvent.change(voice, { target: { value: 'nova' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play a sample' }));
    expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.preview', args: { backend: 'openai', voice: 'nova' } });
    expect(await screen.findByRole('button', { name: 'Play a sample: working' })).toBeDisabled();
    answer({ result: SOUND });
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(FakeAudio.last?.play).toHaveBeenCalled();
    expect(FakeAudio.last?.src).toBe('blob:sound');
    expect(screen.getByRole('status')).toHaveTextContent('Alloy, with OpenAI.');
    // Nothing re-read: the unsaved choice is still on the form.
    expect(voice).toHaveValue('nova');
    fireEvent.click(stop);
    expect(FakeAudio.last?.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sound');
    expect(await screen.findByRole('button', { name: 'Play a sample' })).toBeEnabled();
    expect(api.pageAct).toHaveBeenCalledTimes(1);
  });

  it('sends the form\'s active values when the action names no arguments, and goes back to play when the sound ends', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: SOUND });
    render(<PluginPage page={voicePage({ tool: 'demo.preview', label: 'Play a sample', icon: 'play' })} item={null} navigate={navigate} timezone="UTC" />);
    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue('alloy'));
    fireEvent.click(screen.getByRole('button', { name: 'Play a sample' }));
    await screen.findByRole('button', { name: 'Stop' });
    expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.preview', args: { backend: 'openai', voice: 'alloy' } });
    act(() => FakeAudio.last?.onended?.());
    expect(await screen.findByRole('button', { name: 'Play a sample' })).toBeInTheDocument();
  });

  it('says the refusal under the field, and plays nothing', async () => {
    vi.mocked(api.pageAct).mockRejectedValue(new Error('refused: Kokoro on this computer is not installed.'));
    render(<PluginPage page={voicePage({ tool: 'demo.preview', label: 'Play a sample', icon: 'play' })} item={null} navigate={navigate} timezone="UTC" />);
    await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue('alloy'));
    fireEvent.click(screen.getByRole('button', { name: 'Play a sample' }));
    expect(await screen.findByText('refused: Kokoro on this computer is not installed.')).toBeInTheDocument();
    expect(FakeAudio.last).toBeNull();
  });

  it('plays a sound any page button answers with, and shows its message', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: SOUND });
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [{ kind: 'button', action: { tool: 'demo.chime', label: 'Chime' } }],
    };
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chime' }));
    expect(await screen.findByText('Alloy, with OpenAI.')).toBeInTheDocument();
    expect(FakeAudio.last?.play).toHaveBeenCalled();
  });

  it('plays nothing that is not audio, or is too big', async () => {
    const page: PluginPageDescriptor = {
      plugin: 'demo',
      id: 'settings',
      title: 'Demo',
      place: 'settings',
      body: [{ kind: 'button', action: { tool: 'demo.chime', label: 'Chime', done: 'Done.' } }],
    };
    vi.mocked(api.pageAct).mockResolvedValue({ result: { play: { mime: 'text/html', data: btoa('<b>hi</b>') } } });
    render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chime' }));
    expect(await screen.findByText('Done.')).toBeInTheDocument();
    vi.mocked(api.pageAct).mockResolvedValue({ result: { play: { mime: 'audio/ogg', data: 'A'.repeat(800_000) } } });
    fireEvent.click(screen.getByRole('button', { name: 'Chime' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledTimes(2));
    expect(FakeAudio.last).toBeNull();
  });
});

describe('a row action that asks first', () => {
  const rowForm: PluginPageDescriptor = {
    plugin: 'demo',
    id: 'settings',
    title: 'Demo',
    place: 'settings',
    body: [
      {
        kind: 'table',
        query: { query: 'accounts' },
        rows: 'accounts',
        columns: [{ key: 'address', label: 'Address' }],
        actions: [
          {
            tool: 'demo.set_secret',
            label: 'Set password',
            form: {
              title: 'Set the password for {address}',
              fields: [{ name: 'password', label: 'Password', type: 'secret', required: true }],
              submit: 'Test and save',
              openWhen: { account: { row: 'id' }, set: 'password' },
            },
            done: { path: 'note' },
            then: 'close',
            args: { id: { row: 'id' }, password: { field: 'password' } },
          },
        ],
      },
    ],
  };
  const drawForm = (params?: Record<string, string>): ReturnType<typeof render> =>
    render(<PluginPage page={rowForm} navigate={navigate} timezone="UTC" embedded {...(params ? { params } : {})} />);

  it('opens a sheet for its row, keeps a refusal there, and closes once it worked', async () => {
    drawForm();
    const buttons = await screen.findAllByRole('button', { name: 'Set password' });
    fireEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Set the password for owner@example.com')).toBeInTheDocument();
    const input = within(dialog).getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    const save = within(dialog).getByRole('button', { name: 'Test and save' });
    expect(save).toBeDisabled();

    vi.mocked(api.pageAct).mockRejectedValueOnce(new Error('imap.example.com refused that password, so the old one is kept.'));
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(save);
    expect(await within(dialog).findByText('imap.example.com refused that password, so the old one is kept.')).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.set_secret', args: { id: 'acc-1', password: 'wrong' } });

    vi.mocked(api.pageAct).mockResolvedValueOnce({ result: { note: 'owner@example.com opens with the new password.' } });
    fireEvent.change(input, { target: { value: 'right' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test and save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('owner@example.com opens with the new password.')).toBeInTheDocument();
  });

  it('cancels without writing anything', async () => {
    drawForm();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set password' }))[1]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Set the password for old@example.com')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.pageAct).not.toHaveBeenCalled();
  });

  it('opens itself on the row a link names', async () => {
    drawForm({ account: 'acc-2', set: 'password' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Set the password for old@example.com')).toBeInTheDocument();
  });

  it('opens nothing for a link that names no row here', async () => {
    drawForm({ account: 'acc-9', set: 'password' });
    await screen.findAllByRole('button', { name: 'Set password' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});


it('keeps setup actions in a compact card rather than promoting them into its heading', async () => {
  const page: PluginPageDescriptor = { plugin: 'demo', id: 'setup', title: 'Setup', place: 'settings', body: [
    { kind: 'section', look: 'setup', title: 'Set up', note: 'Step 1 of 2', body: [
      { kind: 'notice', text: 'Prepare your local tools.' },
      { kind: 'button', action: { tool: 'demo.prepare', label: 'Download and continue', tone: 'accent' } },
      { kind: 'button', action: { tool: 'demo.skip', label: 'Skip download' } },
    ] },
  ] };
  const { container } = render(<PluginPage page={page} navigate={() => {}} timezone="UTC" embedded />);
  const button = await screen.findByRole('button', { name: 'Download and continue' });
  expect(button.closest('.pp-setup-actions')).not.toBeNull();
  expect(within(button.closest('.pp-setup-actions') as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['Skip download', 'Download and continue']);
  expect(button.closest('.ui-section-head')).toBeNull();
  expect(container.querySelector('.pp-setup')).toHaveTextContent('Step 1 of 2');
  fireEvent.click(button);
  await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.prepare', args: {} }));
});

it('keeps sections inside a polling container in separate panels', async () => {
  vi.mocked(api.pageQuery).mockResolvedValue({ data: { rows: [{ id: 'settings' }] } });
  const page: PluginPageDescriptor = { plugin: 'demo', id: 'settings', title: 'Settings', place: 'settings', body: [
    { kind: 'repeat', query: { query: 'settings' }, rows: 'rows', key: 'id', body: [
      { kind: 'section', title: 'Sources', body: [{ kind: 'notice', text: 'Source content' }] },
      { kind: 'section', title: 'Topics', body: [{ kind: 'notice', text: 'Topic content' }] },
    ] },
  ] };
  render(<PluginPage page={page} navigate={() => {}} timezone="UTC" embedded />);
  const sources = await screen.findByText('Source content');
  const topics = await screen.findByText('Topic content');
  expect(sources.closest('.ui-panel')).not.toBeNull();
  expect(sources.closest('.ui-panel')).not.toBe(topics.closest('.ui-panel'));
});

it('lets an expand defer its one query to a child list', async () => {
  const page: PluginPageDescriptor = { plugin: 'demo', id: 'review', title: 'Review', place: 'settings', body: [
    { kind: 'expand', label: 'Review sources', body: [
      { kind: 'list', query: { query: 'items' }, rows: 'items', key: 'id', item: { title: { path: 'title' } } },
    ] },
  ] };
  render(<PluginPage page={page} navigate={() => {}} timezone="UTC" embedded />);
  expect(api.pageQuery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Review sources'));
  await screen.findByText('The first thing');
  expect(api.pageQuery).toHaveBeenCalledTimes(1);
});
