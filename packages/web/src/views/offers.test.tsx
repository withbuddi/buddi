/**
 * Saying no, on the two pages that draw offers.
 *
 * The owner's installation had 65 live offers and no way to refuse one, so the
 * list stopped being a list of things to do. These tests are about the half
 * that was missing: the × on a Home chip, "Not now" beside Take, and the bulk
 * refusal that has to name what it is about to clear before it clears it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type OfferRow } from '../api';
import { Home, HOME_OFFERS, LONG_PRESS_MS } from './Home';
import { Offers } from './Offers';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      overview: vi.fn(),
      approvals: vi.fn(),
      missions: vi.fn(),
      reminders: vi.fn(),
      conversations: vi.fn(),
      offers: vi.fn(),
      takeOffer: vi.fn(),
      dismissOffer: vi.fn(),
      dismissOffers: vi.fn(),
    },
  };
});

const OVERVIEW = {
  now: '2026-09-21T09:00:00Z', timezone: 'UTC', paused: false, home: [],
  approvals: { pending: 0, oldestPendingAt: null },
  jobs: { pending: 0, leased: 0, suspended: 0, failed: 0, succeeded: 0, cancelled: 0 },
  missions: { total: 0, enabled: 0, nextRun: null },
  reminders: { pending: 0, nextDueAt: null },
  sentinels: { lastRunAt: null, openUrgent: 0, openInfo: 0, errors: [] },
  mail: [],
};

const AGENTS = [
  { id: 'postman', handle: 'postman', name: 'Postman', description: 'Reads the mail', available: true, roles: [], provider: 'x', model: 'y' },
];

function offer(n: number, over: Partial<OfferRow> = {}): OfferRow {
  return {
    id: `off-${n}`,
    agentId: 'postman',
    conversationId: null,
    label: `Offer ${n}`,
    prompt: `do the ${n}th thing`,
    createdAt: '2026-09-21T08:00:00Z',
    expiresAt: '2026-09-23T08:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.overview).mockResolvedValue(OVERVIEW as never);
  vi.mocked(api.approvals).mockResolvedValue({ pending: [], recent: [] } as never);
  vi.mocked(api.missions).mockResolvedValue({ missions: [] } as never);
  vi.mocked(api.reminders).mockResolvedValue({ reminders: [] } as never);
  vi.mocked(api.conversations).mockResolvedValue({ conversations: [] } as never);
  vi.mocked(api.dismissOffer).mockResolvedValue({ id: 'off-1', dismissedAt: '2026-09-21T09:00:00Z' });
  vi.mocked(api.dismissOffers).mockResolvedValue({ dismissed: 9 });
});

const renderHome = async (): Promise<void> => {
  await act(async () => {
    render(<Home timezone="UTC" navigate={() => {}} agents={AGENTS as never} attention={new Map()} />);
  });
};

describe('Home, "On offer"', () => {
  it('draws six chips and sends the rest to the list', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => offer(i + 1));
    vi.mocked(api.offers).mockResolvedValue({ offers: nine, closed: [] });

    await renderHome();

    await waitFor(() => expect(screen.getByText('On offer')).toBeInTheDocument());
    expect(HOME_OFFERS).toBe(6);
    expect(screen.getByText('Offer 6')).toBeInTheDocument();
    // Seven, eight and nine are not chips; they are one link away.
    expect(screen.queryByText('Offer 7')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3 more' })).toBeInTheDocument();
    // Every chip carries what taking it would ask for, so nothing is hidden
    // behind the label.
    expect(screen.getByTitle('do the 1th thing')).toBeInTheDocument();
  });

  it('dismisses a chip from its ×, without navigating', async () => {
    vi.mocked(api.offers).mockResolvedValue({ offers: [offer(1), offer(2)], closed: [] });
    await renderHome();
    await waitFor(() => expect(screen.getByText('Offer 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Offer 1' }));

    await waitFor(() => expect(api.dismissOffer).toHaveBeenCalledWith('off-1'));
    // Refusing starts nothing: the run is what Take is for.
    expect(api.takeOffer).not.toHaveBeenCalled();
  });

  it('dismisses on a long press, where there is no hover to reveal the ×', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.offers).mockResolvedValue({ offers: [offer(1)], closed: [] });
      render(<Home timezone="UTC" navigate={() => {}} agents={AGENTS as never} attention={new Map()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      const chip = screen.getByText('Offer 1').closest('a') as HTMLElement;
      fireEvent.touchStart(chip);
      // A short tap is still a tap: nothing is dismissed before the threshold.
      await act(async () => { await vi.advanceTimersByTimeAsync(LONG_PRESS_MS - 50); });
      expect(api.dismissOffer).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(api.dismissOffer).toHaveBeenCalledWith('off-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the count before it clears the list', async () => {
    const three = [offer(1), offer(2), offer(3)];
    vi.mocked(api.offers).mockResolvedValue({ offers: three, closed: [] });
    await renderHome();
    await waitFor(() => expect(screen.getByText('On offer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    // The sentence says how many, and nothing has happened yet.
    expect(screen.getByText(/Dismiss 3 offers\?/)).toBeInTheDocument();
    expect(api.dismissOffers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss 3' }));
    await waitFor(() => expect(api.dismissOffers).toHaveBeenCalledWith(three.map((item) => item.id)));
  });

  it('lets the owner back out of clearing the list', async () => {
    vi.mocked(api.offers).mockResolvedValue({ offers: [offer(1)], closed: [] });
    await renderHome();
    await waitFor(() => expect(screen.getByText('On offer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(api.dismissOffers).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dismiss all' })).toBeInTheDocument();
  });
});

describe('the Offers tab', () => {
  it('offers both answers, and "Not now" starts nothing', async () => {
    vi.mocked(api.offers).mockResolvedValue({ offers: [offer(1)], closed: [] });

    await act(async () => { render(<Offers embedded agentId="postman" agentName="Postman" />); });
    await waitFor(() => expect(screen.getByText('Offer 1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Take' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(api.dismissOffer).toHaveBeenCalledWith('off-1'));
    expect(api.takeOffer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Dismissed — Offer 1/)).toBeInTheDocument());
  });

  it('confirms "Dismiss all" with the count, scoped to the agent whose page it is', async () => {
    vi.mocked(api.offers).mockResolvedValue({ offers: [offer(1), offer(2)], closed: [] });

    await act(async () => { render(<Offers embedded agentId="postman" agentName="Postman" />); });
    await waitFor(() => expect(screen.getByText('Offer 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(screen.getByText(/Dismiss 2 offers from Postman\?/)).toBeInTheDocument();
    expect(api.dismissOffers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss 2' }));
    await waitFor(() => expect(api.dismissOffers).toHaveBeenCalledWith(['off-1', 'off-2']));
  });

  it('keeps what was refused and what lapsed under a fold, with why', async () => {
    vi.mocked(api.offers).mockResolvedValue({
      offers: [offer(1)],
      closed: [
        offer(2, { dismissedAt: '2026-09-20T09:00:00Z' }),
        offer(3, { lapsedAt: '2026-09-20T10:00:00Z', lapseReason: 'owner-moved-on' }),
        offer(4, { lapsedAt: '2026-09-20T11:00:00Z', lapseReason: 'agent-removed' }),
      ],
    });

    await act(async () => { render(<Offers embedded />); });
    await waitFor(() => expect(screen.getByText('Offer 1')).toBeInTheDocument());

    const fold = screen.getByText('Dismissed and lapsed (3)').closest('details') as HTMLElement;
    expect(within(fold).getByText(/You said no to this one/)).toBeInTheDocument();
    expect(within(fold).getByText(/The conversation moved on/)).toBeInTheDocument();
    expect(within(fold).getByText(/That agent is no longer here/)).toBeInTheDocument();
    // The fold holds no buttons: these are the record, not the table.
    expect(within(fold).queryByRole('button', { name: 'Take' })).not.toBeInTheDocument();
  });
});
