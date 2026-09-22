/**
 * Mail: the conversations, and the editor over the drafts waiting on them.
 *
 * Three things this page has to get right, and each of them is a way mail goes
 * wrong quietly:
 *
 *  - the **draft** pill, and a conversation that is a link rather than a
 *    button, so a thread has an address;
 *  - the editor following what is *stored* when the stored version moves —
 *    without that, a page left open while an agent rewrote the draft shows the
 *    old words, and Save is the owner unknowingly putting them back;
 *  - a draft whose dispatch was never confirmed drawn as the unresolved thing
 *    it is, with every action taken away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type EmailDraftRow } from '../api';
import { DraftEditor, Mail, addressesOf, draftStatusLine } from './Mail';
import { mailRoute, parseMailRoute } from '../routes';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: {
    emailThreads: vi.fn(),
    emailThread: vi.fn(),
    emailMessage: vi.fn(),
    saveEmailDraft: vi.fn(),
    discardEmailDraft: vi.fn(),
    sendEmailDraft: vi.fn(),
    approval: vi.fn(),
    decide: vi.fn(),
  },
}));

const DRAFT: EmailDraftRow = {
  id: 'd1',
  threadId: 't1',
  accountId: 'a1',
  inReplyTo: 'm1',
  to: ['alerts@bank.test'],
  cc: [],
  bcc: [],
  subject: 'Re: Direct debit returned',
  bodyText: 'I will cover it today.',
  createdByAgent: 'mail-triage',
  status: 'draft',
  editedBy: null,
  updatedAt: '2026-09-21T10:00:00.000Z',
  createdAt: '2026-09-21T10:00:00.000Z',
  sentAt: null,
  live: true,
  sentActionId: null,
  sendError: null,
  unresolved: false,
};

const place = (hash: string): JSX.Element => (
  <Mail
    hash={hash}
    timezone="UTC"
    navigate={() => {}}
    agents={[]}
    attention={undefined as never}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.emailThreads).mockResolvedValue({
    threads: [
      {
        id: 't1',
        accountId: 'a1',
        subject: 'Direct debit returned',
        participants: ['alerts@bank.test'],
        state: 'waiting-on-me',
        lastAt: '2026-09-21T09:00:00.000Z',
        messageCount: 1,
        hasLiveDraft: true,
      },
      {
        id: 't2',
        accountId: 'a1',
        subject: 'Weekend sale',
        participants: ['shop@shop.test'],
        state: 'closed',
        lastAt: '2026-09-20T09:00:00.000Z',
        messageCount: 1,
        hasLiveDraft: false,
      },
    ],
  });
  vi.mocked(api.emailThread).mockResolvedValue({
    thread: {
      id: 't1',
      accountId: 'a1',
      subject: 'Direct debit returned',
      participants: ['alerts@bank.test'],
      state: 'waiting-on-me',
      lastAt: '2026-09-21T09:00:00.000Z',
      messageCount: 1,
      hasLiveDraft: true,
    },
    messages: [
      {
        id: 'm1',
        direction: 'in',
        from: 'alerts@bank.test',
        to: ['owner@example.test'],
        subject: 'Direct debit returned',
        date: '2026-09-20T09:00:00.000Z',
        snippet: 'Your direct debit was returned',
      },
    ],
    drafts: [DRAFT],
    older: [],
  });
});

describe('the route', () => {
  it('gives every conversation an address, and reads one back', () => {
    expect(mailRoute('t1')).toBe('#/email/t1');
    expect(parseMailRoute('#/email/t1')).toEqual({ threadId: 't1' });
    expect(parseMailRoute('#/email')).toEqual({});
    expect(parseMailRoute('#/files')).toBeNull();
  });
});

describe('the conversation list', () => {
  it('pills the conversations a reply is waiting on, and links each one', async () => {
    render(place('#/email'));
    const waiting = await screen.findByRole('link', { name: /Direct debit returned/ });
    expect(waiting).toHaveAttribute('href', '#/email/t1');
    expect(waiting.textContent).toContain('draft');
    const quiet = screen.getByRole('link', { name: /Weekend sale/ });
    expect(quiet.textContent).not.toContain('draft');
  });
});

describe('the thread', () => {
  it('draws the messages as snippets and fetches a body only when one is opened', async () => {
    vi.mocked(api.emailMessage).mockResolvedValue({
      message: {
        id: 'm1',
        from: 'alerts@bank.test',
        to: [],
        cc: [],
        subject: 'Direct debit returned',
        date: null,
        direction: 'in',
        bodyText: 'The whole body, fetched on demand.',
        purged: false,
      },
    });
    render(place('#/email/t1'));
    expect(await screen.findByText(/Your direct debit was returned/)).toBeInTheDocument();
    expect(api.emailMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await waitFor(() => expect(api.emailMessage).toHaveBeenCalledWith('m1'));
    expect(await screen.findByText('The whole body, fetched on demand.')).toBeInTheDocument();
  });
});

describe('the editor', () => {
  it('sends the version it loaded, so a save that lost a race is refused', async () => {
    vi.mocked(api.saveEmailDraft).mockResolvedValue({ draft: DRAFT });
    render(<DraftEditor draft={DRAFT} onChanged={() => {}} onProposed={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveEmailDraft).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({ updatedAt: DRAFT.updatedAt }),
      ),
    );
    // The route refuses a save with no version, so the editor must never make
    // one: the field is required, not merely usually present.
    const [, body] = vi.mocked(api.saveEmailDraft).mock.calls[0] as [string, { updatedAt: string }];
    expect(typeof body.updatedAt).toBe('string');
    expect(body.updatedAt).not.toBe('');
  });

  it('follows the stored draft when somebody else rewrites it', async () => {
    const { rerender } = render(
      <DraftEditor draft={DRAFT} onChanged={() => {}} onProposed={() => {}} />,
    );
    expect(screen.getByLabelText('Body')).toHaveValue('I will cover it today.');

    // An agent rewrote it. The screen must not keep showing the old words:
    // Save would then be the owner putting them back without knowing.
    rerender(
      <DraftEditor
        draft={{ ...DRAFT, bodyText: 'The agent rewrote it.', updatedAt: '2026-09-21T11:00:00.000Z' }}
        onChanged={() => {}}
        onProposed={() => {}}
      />,
    );
    expect(screen.getByLabelText('Body')).toHaveValue('The agent rewrote it.');
  });

  it('takes every action away from a draft whose dispatch was never confirmed', () => {
    render(
      <DraftEditor
        draft={{
          ...DRAFT,
          live: false,
          unresolved: true,
          sentActionId: 'act-1',
          sendError: 'connection reset',
        }}
        onChanged={() => {}}
        onProposed={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/never got an answer/);
    expect(screen.getByText(/connection reset/)).toBeInTheDocument();
    for (const name of ['Save', 'Discard', 'Send']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByLabelText('Body')).toBeDisabled();
  });

  it('says plainly where a draft is in its life', () => {
    expect(draftStatusLine({ ...DRAFT, status: 'lapsed' })).toMatch(/no longer sendable/);
    expect(draftStatusLine({ ...DRAFT, status: 'edited', editedBy: 'owner' })).toMatch(/Edited by you/);
  });

  it('reads a typed recipient list however it is separated', () => {
    expect(addressesOf('a@x.test, b@x.test;  c@x.test')).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
    ]);
    expect(addressesOf('   ')).toEqual([]);
  });
});
