/**
 * A reading pane, drawn from a descriptor (host API 1.30): a list whose rows
 * are heavier while unread and carry a line of the message, ↑ ↓ and Enter
 * through it, a section that reads the conversation and takes its subject as
 * the heading, and the `message` block — folded until opened, its body read
 * only then, its files opening in the library or fetched first.
 *
 * A synthetic plugin, as the rest of the engine's tests: nothing here knows
 * the email plugin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import type { PluginPageDescriptor } from './types';

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

/** A reply with the earlier messages quoted inside each other, Gmail-style. */
const NESTED_QUOTES = `<div dir="ltr">Thursday works. I'll bring the signed copy.</div>
<div class="gmail_quote"><div class="gmail_attr">On Tue, 6 Oct 2026, Ana Duarte &lt;ana@studio.test&gt; wrote:</div>
<blockquote class="gmail_quote">Could we meet Thursday instead?
<div class="gmail_quote"><div class="gmail_attr">On Mon, 5 Oct 2026, you wrote:</div>
<blockquote class="gmail_quote">Shall we meet Wednesday to sign?</blockquote></div>
</blockquote></div>`;

const THREADS = {
  threads: [
    { id: 't1', name: 'Ana Duarte', subject: 'Signing on Thursday', preview: 'Thursday works. I will bring…', unread: true, when: '7 min' },
    { id: 't2', name: 'news@news.test', subject: 'The week', preview: 'The week in three lines.', unread: false, when: 'yesterday' },
    { id: 't3', name: 'Bo', subject: 'Lunch', preview: 'Friday?', unread: false, when: 'Mon' },
  ],
};

const THREAD = {
  id: 't1',
  subject: 'Signing on Thursday',
  messages: [
    { id: 'm1', from: { name: 'You', address: 'me@home.test' }, at: '2026-10-05T08:00:00.000Z', snippet: 'Shall we meet Wednesday?', folded: true },
    {
      id: 'm2',
      from: { name: 'Ana Duarte', address: 'ana@studio.test' },
      to: [{ address: 'me@home.test' }],
      at: '2026-10-06T09:30:00.000Z',
      snippet: 'Thursday works.',
      folded: false,
    },
  ],
};

const MESSAGES: Record<string, unknown> = {
  m1: { id: 'm1', from: { name: 'You', address: 'me@home.test' }, at: '2026-10-05T08:00:00.000Z', text: 'Shall we meet Wednesday to sign?' },
  m2: {
    id: 'm2',
    from: { name: 'Ana Duarte', address: 'ana@studio.test' },
    to: [{ address: 'me@home.test', name: 'Me' }],
    cc: [{ address: 'office@studio.test' }],
    at: '2026-10-06T09:30:00.000Z',
    html: NESTED_QUOTES,
    text: 'Thursday works.',
    attachments: [
      { name: 'contract.pdf', size: 48_000, mime: 'application/pdf', artifactId: 'art-1', messageId: 'm2', index: 0 },
      { name: 'map.png', size: 9_000, mime: 'image/png', artifactId: null, messageId: 'm2', index: 1 },
    ],
  },
};

const page: PluginPageDescriptor = {
  plugin: 'demo',
  id: 'mail',
  title: 'Mail',
  place: 'rail',
  body: [
    {
      kind: 'list-detail',
      param: 'thread',
      list: {
        kind: 'list',
        query: { query: 'threads' },
        rows: 'threads',
        key: 'id',
        item: {
          title: { path: 'name' },
          sub: { path: 'subject' },
          preview: { path: 'preview' },
          strong: { path: 'unread', equals: true },
          meta: [{ path: 'when' }],
          to: { page: 'mail', item: { path: 'id' } },
        },
      },
      detail: [
        {
          kind: 'section',
          title: 'Conversation',
          query: { query: 'thread', params: { id: { param: 'thread' } } },
          heading: { path: 'subject' },
          body: [
            {
              kind: 'repeat',
              query: { query: 'thread', params: { id: { param: 'thread' } } },
              rows: 'messages',
              key: 'id',
              body: [
                {
                  kind: 'message',
                  query: { query: 'message', params: { id: { path: 'id' } } },
                  folded: { path: 'folded', equals: true },
                  fetch: { tool: 'demo.fetch', label: 'Fetch', args: { message: { path: 'messageId' }, index: { path: 'index' } } },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const navigate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(api.pageQuery).mockImplementation(async (_plugin: string, query: string, params?: Record<string, string>) => {
    if (query === 'threads') return { data: THREADS } as never;
    if (query === 'thread') return { data: THREAD } as never;
    if (query === 'message') return { data: MESSAGES[params?.id ?? ''] } as never;
    throw new Error(`no query ${query}`);
  });
  vi.mocked(api.pageAct).mockResolvedValue({ result: { note: 'Fetched.' } } as never);
});

const draw = (item: string | null): ReturnType<typeof render> =>
  render(<PluginPage page={page} item={item} navigate={navigate} timezone="UTC" siblings={[page]} />);

describe('the list beside a reading pane', () => {
  it('draws unread rows heavier, and a line of the message under each', async () => {
    draw('t1');
    const unread = (await screen.findByText('Ana Duarte', { selector: '.ui-pick-title' })).closest('a')!;
    expect(unread).toHaveAttribute('data-strong', 'true');
    expect(within(unread).getByText('Thursday works. I will bring…')).toHaveClass('ui-pick-snippet');
    const read = screen.getByText('news@news.test').closest('a')!;
    expect(read).toHaveAttribute('data-strong', 'false');
  });

  it('moves with ↑ and ↓ and opens with Enter, as links do', async () => {
    draw('t1');
    const first = (await screen.findByText('Ana Duarte', { selector: '.ui-pick-title' })).closest('a')!;
    const rows = [...document.querySelectorAll<HTMLElement>('a.ui-pick')];
    expect(rows).toHaveLength(3);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    // Enter on a focused link is the browser's own: the row is a real link with its address.
    expect(rows[1]).toHaveAttribute('href', '#/p/demo/mail/t2');
  });
});

describe('the reading pane', () => {
  it('takes the conversation subject as its heading', async () => {
    draw('t1');
    expect(await screen.findByRole('heading', { name: 'Signing on Thursday' })).toBeInTheDocument();
  });

  it('draws the newest message open with its sender, time and body, To and Cc on expand', async () => {
    draw('t1');
    const article = await screen.findByRole('article', { name: 'Message from Ana Duarte' });
    expect(within(article).getByText('<ana@studio.test>')).toBeInTheDocument();
    // The owner's display format, in his zone.
    expect(article.querySelector('.pl-mail-when')).toHaveTextContent(/6 Oct|Oct 6/);
    expect(await within(article).findByText("Thursday works. I'll bring the signed copy.")).toBeInTheDocument();
    expect(within(article).queryByText('Cc')).not.toBeInTheDocument();
    fireEvent.click(within(article).getByRole('button', { name: /^to Me, office@studio.test/ }));
    expect(within(article).getByText('Me <me@home.test>')).toBeInTheDocument();
    expect(within(article).getByText('office@studio.test')).toBeInTheDocument();
    // The earlier message is folded.
    expect(within(article).queryByText(/Could we meet Thursday/)).not.toBeInTheDocument();
  });

  it('keeps an older message to one line, and reads its body only when it is opened', async () => {
    draw('t1');
    const folded = await screen.findByRole('button', { name: 'Open the message from You' });
    expect(within(folded).getByText('Shall we meet Wednesday?')).toBeInTheDocument();
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('demo', 'message', { id: 'm2' }));
    expect(api.pageQuery).not.toHaveBeenCalledWith('demo', 'message', { id: 'm1' });
    fireEvent.click(folded);
    expect(await screen.findByText('Shall we meet Wednesday to sign?')).toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'message', { id: 'm1' });
  });

  it('draws files as file rows: one in the library opens there, one that is only listed has Fetch', async () => {
    draw('t1');
    const open = await screen.findByRole('button', { name: 'Open contract.pdf' });
    fireEvent.click(open);
    expect(navigate).toHaveBeenCalledWith('#/files/art-1');
    expect(screen.queryByRole('button', { name: 'Open map.png' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalledWith('demo', { tool: 'demo.fetch', args: { message: 'm2', index: 1 } }));
  });
});
