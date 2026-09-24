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
          { key: 'address', label: 'Address' },
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
    fireEvent.click(await screen.findByRole('link', { name: 'A reply' }));
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
    fireEvent.click(within(dialog).getByLabelText('Give the hosts myself'));
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
    expect(within(section).getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true');
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

  it('leaves a page with no sensitive query exactly as it was', async () => {
    draw('board');
    expect(await screen.findByText('Things in all')).toBeInTheDocument();
    expect(screen.queryByText('Hidden until you show it.')).not.toBeInTheDocument();
  });
});
