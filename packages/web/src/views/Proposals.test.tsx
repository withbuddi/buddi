/**
 * Settings → Proposals: the card, the untrusted mark, and both answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ProposalRow } from '../api';
import { Proposals } from './Proposals';
import { Home } from './Home';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      proposals: vi.fn(),
      keepProposal: vi.fn(),
      discardProposal: vi.fn(),
      overview: vi.fn(),
      approvals: vi.fn(),
      missions: vi.fn(),
      reminders: vi.fn(),
      conversations: vi.fn(),
      offers: vi.fn(),
    },
  };
});

function proposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 'p-1',
    kind: 'skill',
    agent: 'advisor',
    title: 'Skill: Check a bank balance in the browser',
    why: 'I did this twice this week.',
    editable: '1. Open the bank.\n2. Read the balance.',
    payload: { name: 'Check a bank balance in the browser', when: 'When asked for a balance.', body: '1. Open the bank.\n2. Read the balance.' },
    conversationId: 'c-1',
    turn: 3,
    runId: 'run-1',
    untrusted: false,
    sources: [],
    state: 'open',
    createdAt: '2026-09-23T10:00:00Z',
    decidedAt: null,
    reason: null,
    note: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.keepProposal).mockResolvedValue({ proposal: proposal({ state: 'kept' }), applied: false, note: 'Kept; written as a skill file when learning step 2 ships.' });
  vi.mocked(api.discardProposal).mockResolvedValue({ proposal: proposal({ state: 'discarded' }) });
});

const renderPage = async (): Promise<void> => {
  await act(async () => { render(<Proposals />); });
};

describe('the Proposals inbox', () => {
  it('draws the card: what, why, where it came from, unmarked when the run read nothing untrusted', async () => {
    vi.mocked(api.proposals).mockResolvedValue({ open: [proposal()], closed: [] });
    await renderPage();
    expect(screen.getByText('Skill: Check a bank balance in the browser')).toBeInTheDocument();
    expect(screen.getByText('I did this twice this week.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'this conversation, turn 3' })).toHaveAttribute('href', '#/activity/conversations/c-1');
    expect(screen.queryByText('untrusted text in view')).not.toBeInTheDocument();
  });

  it('marks a proposal made with untrusted text in view and lists the sources', async () => {
    vi.mocked(api.proposals).mockResolvedValue({
      open: [proposal({ untrusted: true, sources: ['web page bank.example/balance (browser.act)'] })],
      closed: [],
    });
    await renderPage();
    expect(screen.getByText('untrusted text in view')).toBeInTheDocument();
    expect(screen.getByText('Made with untrusted text in view.')).toBeInTheDocument();
    expect(screen.getByText('web page bank.example/balance (browser.act)')).toBeInTheDocument();
  });

  it('keeps as proposed, or the owner\'s corrected version', async () => {
    vi.mocked(api.proposals).mockResolvedValue({ open: [proposal()], closed: [] });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(api.keepProposal).toHaveBeenCalledWith('p-1', undefined));
    expect(await screen.findByText(/written as a skill file when learning step 2 ships/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /The steps/ }), { target: { value: '1. Open the bank carefully.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }));
    await waitFor(() => expect(api.keepProposal).toHaveBeenLastCalledWith('p-1', '1. Open the bank carefully.'));
  });

  it('discards with the optional reason', async () => {
    vi.mocked(api.proposals).mockResolvedValue({ open: [proposal()], closed: [] });
    await renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for discarding (optional)' }), { target: { value: 'I do it myself' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.discardProposal).toHaveBeenCalledWith('p-1', 'I do it myself'));
    expect(await screen.findByText(/will not propose it again for 90 days/)).toBeInTheDocument();
  });

  it('folds what was decided this week, saying what happened to each', async () => {
    vi.mocked(api.proposals).mockResolvedValue({
      open: [],
      closed: [
        proposal({ id: 'k', state: 'kept', decidedAt: '2026-09-23T11:00:00Z', note: 'Kept; written as a skill file when learning step 2 ships.' }),
        proposal({ id: 'd', title: 'Skill: Other', state: 'discarded', decidedAt: '2026-09-23T11:00:00Z', reason: 'no' }),
      ],
    });
    await renderPage();
    expect(screen.getByText('Kept, discarded and expired (2)')).toBeInTheDocument();
    expect(screen.getByText('advisor: Kept; written as a skill file when learning step 2 ships.')).toBeInTheDocument();
    expect(screen.getByText('advisor: Discarded: no')).toBeInTheDocument();
    expect(screen.getByText(/Nothing proposed/)).toBeInTheDocument();
  });

  it('shows a policy as its parts, with no editor', async () => {
    vi.mocked(api.proposals).mockResolvedValue({
      open: [proposal({ kind: 'policy', title: 'Rule for email: ignore', editable: null, payload: { plugin: 'email', matcher: { from: 'news@x.com' }, action: 'ignore', verdicts: [1, 2] } })],
      closed: [],
    });
    await renderPage();
    expect(screen.getByText('{"from":"news@x.com"}')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /The steps/ })).not.toBeInTheDocument();
  });
});

describe('Home', () => {
  it('counts open proposals under "Needs you" and links to the inbox', async () => {
    vi.mocked(api.overview).mockResolvedValue({
      now: '2026-09-23T12:00:00Z', timezone: 'UTC', paused: false, home: [],
      approvals: { pending: 0, oldestPendingAt: null },
      jobs: { pending: 0, leased: 0, suspended: 0, failed: 0, succeeded: 0, cancelled: 0 },
      missions: { total: 0, enabled: 0, nextRun: null }, reminders: { pending: 0, nextDueAt: null },
      sentinels: { lastRunAt: null, openUrgent: 0, openInfo: 0, errors: [] }, mail: [],
    } as never);
    vi.mocked(api.approvals).mockResolvedValue({ pending: [], recent: [] } as never);
    vi.mocked(api.missions).mockResolvedValue({ missions: [] } as never);
    vi.mocked(api.reminders).mockResolvedValue({ reminders: [] } as never);
    vi.mocked(api.conversations).mockResolvedValue({ conversations: [] } as never);
    vi.mocked(api.offers).mockResolvedValue({ offers: [], closed: [] });
    vi.mocked(api.proposals).mockResolvedValue({ open: [proposal(), proposal({ id: 'p-2' })], closed: [] });
    await act(async () => {
      render(<Home timezone="UTC" navigate={() => {}} agents={[]} attention={new Map()} />);
    });
    expect(await screen.findByRole('link', { name: '2 proposals from your agents to keep or discard.' })).toHaveAttribute('href', '#/settings/proposals');
    expect(screen.getByText('2 proposals to review.')).toBeInTheDocument();
  });
});
